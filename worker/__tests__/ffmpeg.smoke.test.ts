import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  extractFirstFrame,
  ffmpegPath,
  probeVideo,
  runMediaCommand,
} from "../ffmpeg.js"

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "firstframe-ffmpeg-smoke-"))
})
afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

it("extracts a real PNG from a small generated video", async () => {
  const video = path.join(directory, "sample.mp4")
  const png = path.join(directory, "sample.png")
  await runMediaCommand(
    ffmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=32x24:d=0.2",
      "-c:v",
      "mpeg4",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    20_000,
  )
  const metadata = await probeVideo(video, 20_000)
  await extractFirstFrame(video, png, 20_000)
  const bytes = await readFile(png)
  expect(metadata.width).toBe(32)
  expect(metadata.height).toBe(24)
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
})
