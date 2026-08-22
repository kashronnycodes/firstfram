import { describe, expect, it } from "vitest"
import { MediaCommandError, runMediaCommand } from "../ffmpeg.js"

describe("media command timeout", () => {
  it("kills a stalled child process and reports the configured timeout", async () => {
    await expect(
      runMediaCommand(
        process.execPath,
        ["-e", "setTimeout(() => undefined, 10_000)"],
        100,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<MediaCommandError>>({
        message: "Video processing exceeded the configured time limit.",
      }),
    )
  })
})
