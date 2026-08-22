import { describe, expect, it } from "vitest"
import { safeDownloadBaseName } from "../validation.js"

describe("download names", () => {
  it("creates a safe PNG name from an untrusted source filename", () => {
    expect(safeDownloadBaseName("../shot?.mp4")).toBe(
      ".._shot_-first-frame.png",
    )
  })
})
