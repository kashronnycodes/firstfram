import { File as NodeFile } from "node:buffer"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  extractLocalFirstFrame,
  LocalExtractionError,
  processSequentially,
} from "./local-frame"

class FakeVideo extends EventTarget {
  preload = ""
  muted = false
  playsInline = false
  crossOrigin: string | null = null
  src = ""
  readyState = 0
  videoWidth: number
  videoHeight: number
  failDecode = false
  pause = vi.fn()

  constructor(width = 1920, height = 1080) {
    super()
    this.videoWidth = width
    this.videoHeight = height
  }

  load() {
    if (!this.src) return
    queueMicrotask(() =>
      this.dispatchEvent(new Event(this.failDecode ? "error" : "loadeddata")),
    )
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = ""
  }

  requestVideoFrameCallback(callback: () => void) {
    queueMicrotask(callback)
    return 1
  }

  cancelVideoFrameCallback() {}
}

class StalledVideo extends FakeVideo {
  load() {}
}

function installMediaDom(video = new FakeVideo()) {
  const drawImage = vi.fn()
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((callback: (blob: Blob | null) => void) =>
      callback(new Blob(["png"], { type: "image/png" })),
    ),
  }
  vi.stubGlobal("document", {
    createElement: vi.fn((tag: string) => (tag === "video" ? video : canvas)),
  })
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:video")
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
  return { video, canvas, drawImage }
}

function videoFile(name: string, type: string, size = 3): globalThis.File {
  return new NodeFile([new Uint8Array(size)], name, {
    type,
  }) as unknown as globalThis.File
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("local first-frame extraction", () => {
  it.each([
    ["clip.mp4", "video/mp4"],
    ["clip.webm", "video/webm"],
    ["clip.m4v", "video/x-m4v"],
    ["iphone.mov", "video/quicktime"],
  ])("decodes browser-compatible %s files locally", async (name, type) => {
    const { drawImage } = installMediaDom()
    const result = await extractLocalFirstFrame(videoFile(name, type))
    expect(result.png.type).toBe("image/png")
    expect(result.width).toBe(1920)
    expect(result.height).toBe(1080)
    expect(drawImage).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video")
  })

  it("handles a large 4K frame without uploading or duplicating the video", async () => {
    const { canvas } = installMediaDom(new FakeVideo(3840, 2160))
    const result = await extractLocalFirstFrame(
      videoFile("large-4k.mp4", "video/mp4", 1_000_000),
    )
    expect([result.width, result.height]).toEqual([3840, 2160])
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })

  it("rejects a browser-incompatible HEVC MOV for automatic fallback and releases resources", async () => {
    const video = new FakeVideo()
    video.failDecode = true
    installMediaDom(video)
    await expect(
      extractLocalFirstFrame(videoFile("hevc.mov", "video/quicktime")),
    ).rejects.toMatchObject({ code: "decode_failed" })
    expect(video.pause).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video")
  })

  it("supports cancellation/removal without invoking fallback", async () => {
    installMediaDom()
    const controller = new AbortController()
    controller.abort()
    await expect(
      extractLocalFirstFrame(videoFile("cancel.mp4", "video/mp4"), {
        signal: controller.signal,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalExtractionError>>({
        code: "aborted",
      }),
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it("times out a stalled browser decoder and releases resources", async () => {
    const video = new StalledVideo()
    installMediaDom(video)
    await expect(
      extractLocalFirstFrame(videoFile("stalled.mp4", "video/mp4"), {
        timeoutMs: 5,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalExtractionError>>({
        code: "timeout",
      }),
    )
    expect(video.pause).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video")
  })

  it("processes 10 files sequentially with a maximum concurrency of one", async () => {
    let active = 0
    let maxActive = 0
    const completed: number[] = []
    await processSequentially(
      Array.from({ length: 10 }, (_, index) => index),
      async (index) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return index
      },
      (result) => {
        if (result.status === "fulfilled") completed.push(result.value)
      },
    )
    expect(maxActive).toBe(1)
    expect(completed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
