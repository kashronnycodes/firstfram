import { describe, expect, it } from "vitest"
import { safeDownloadBaseName, uniqueOutputName } from "../validation.js"

describe("download names", () => {
  it("creates unique PNG names when source videos share a base name", () => {
    const used = new Set<string>()
    expect(uniqueOutputName(safeDownloadBaseName("shot.mp4"), used)).toBe(
      "shot-first-frame.png",
    )
    expect(uniqueOutputName(safeDownloadBaseName("shot.mov"), used)).toBe(
      "shot-first-frame (2).png",
    )
    expect(uniqueOutputName(safeDownloadBaseName("SHOT.webm"), used)).toBe(
      "SHOT-first-frame (3).png",
    )
  })
})
