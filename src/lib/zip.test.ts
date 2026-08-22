import { describe, expect, it } from "vitest"
import { createStoredZip } from "./zip"

describe("browser ZIP", () => {
  it("stores PNGs without recompression and includes every filename", async () => {
    const zip = await createStoredZip([
      { name: "one-first-frame.png", blob: new Blob(["png-one"]) },
      { name: "two-first-frame.png", blob: new Blob(["png-two"]) },
    ])
    const bytes = new Uint8Array(await zip.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(bytes[8]).toBe(0)
    expect(bytes[9]).toBe(0)
    expect(text).toContain("one-first-frame.png")
    expect(text).toContain("two-first-frame.png")
    expect(zip.type).toBe("application/zip")
  })
})
