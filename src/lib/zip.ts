export interface ZipEntry {
  name: string
  blob: Blob
}

const encoder = new TextEncoder()
let crcTable: Uint32Array | undefined

function table(): Uint32Array {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    crcTable[index] = value >>> 0
  }
  return crcTable
}

function crc32(bytes: Uint8Array): number {
  const values = table()
  let crc = 0xffffffff
  for (const byte of bytes) crc = values[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  }
}

function header(size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size)
  return { bytes, view: new DataView(bytes.buffer) }
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

export async function createStoredZip(
  entries: readonly ZipEntry[],
): Promise<Blob> {
  const parts: BlobPart[] = []
  const centralParts: Uint8Array[] = []
  const stamp = dosDateTime(new Date())
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = new Uint8Array(await entry.blob.arrayBuffer())
    const checksum = crc32(data)
    const local = header(30 + name.length)
    local.view.setUint32(0, 0x04034b50, true)
    local.view.setUint16(4, 20, true)
    local.view.setUint16(6, 0x0800, true)
    local.view.setUint16(8, 0, true)
    local.view.setUint16(10, stamp.time, true)
    local.view.setUint16(12, stamp.date, true)
    local.view.setUint32(14, checksum, true)
    local.view.setUint32(18, data.length, true)
    local.view.setUint32(22, data.length, true)
    local.view.setUint16(26, name.length, true)
    local.bytes.set(name, 30)
    parts.push(blobPart(local.bytes), blobPart(data))

    const central = header(46 + name.length)
    central.view.setUint32(0, 0x02014b50, true)
    central.view.setUint16(4, 20, true)
    central.view.setUint16(6, 20, true)
    central.view.setUint16(8, 0x0800, true)
    central.view.setUint16(10, 0, true)
    central.view.setUint16(12, stamp.time, true)
    central.view.setUint16(14, stamp.date, true)
    central.view.setUint32(16, checksum, true)
    central.view.setUint32(20, data.length, true)
    central.view.setUint32(24, data.length, true)
    central.view.setUint16(28, name.length, true)
    central.view.setUint32(42, offset, true)
    central.bytes.set(name, 46)
    centralParts.push(central.bytes)
    offset += local.bytes.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  parts.push(...centralParts.map(blobPart))
  const end = header(22)
  end.view.setUint32(0, 0x06054b50, true)
  end.view.setUint16(8, entries.length, true)
  end.view.setUint16(10, entries.length, true)
  end.view.setUint32(12, centralSize, true)
  end.view.setUint32(16, offset, true)
  parts.push(blobPart(end.bytes))
  return new Blob(parts, { type: "application/zip" })
}
