import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import type { AppConfig } from "../server/config.js"
import type { InternalFrameJob } from "../server/store.js"
import {
  extractFirstFrame,
  MediaCommandError,
  probeVideo,
  type VideoMetadata,
} from "./ffmpeg.js"
import type { WorkerStore } from "./store.js"

export interface MediaRunner {
  probe(inputPath: string, timeoutMs: number): Promise<VideoMetadata>
  extract(
    inputPath: string,
    outputPath: string,
    timeoutMs: number,
  ): Promise<void>
}

const defaultMediaRunner: MediaRunner = {
  probe: probeVideo,
  extract: extractFirstFrame,
}

function friendlyError(error: unknown): string {
  if (error instanceof MediaCommandError) {
    if (
      /invalid data|moov atom|could not find codec|decoder|corrupt/i.test(
        error.stderr,
      )
    ) {
      return "This video is corrupt or uses a codec the worker cannot decode."
    }
    return error.message
  }
  if (error instanceof Error && /unsupported codec/i.test(error.message))
    return error.message
  return "FirstFrame could not extract a frame from this video."
}

export async function processFrameJob(
  job: InternalFrameJob,
  store: WorkerStore,
  config: AppConfig,
  media: MediaRunner = defaultMediaRunner,
): Promise<void> {
  const root = path.resolve(config.workerTempRoot ?? os.tmpdir())
  await mkdir(root, { recursive: true })
  const tempDirectory = await mkdtemp(path.join(root, "firstframe-"))
  if (!tempDirectory.startsWith(`${root}${path.sep}`))
    throw new Error("Unsafe worker temporary directory")
  const inputPath = path.join(tempDirectory, `${job.id}.video`)
  const outputPath = path.join(tempDirectory, `${job.id}.png`)

  try {
    await store.progress(job.id, 15)
    await pipeline(
      await store.sourceStream(job),
      createWriteStream(inputPath, { flags: "wx" }),
    )
    if ((await store.status(job.id)) !== "processing") return

    await store.progress(job.id, 30)
    const metadata = await media.probe(inputPath, config.processTimeoutMs)
    if (metadata.durationSeconds > config.maxVideoDurationSeconds) {
      throw new Error(
        `This video is longer than the ${config.maxVideoDurationSeconds}-second limit.`,
      )
    }
    if (!config.allowedVideoCodecs.has(metadata.codec)) {
      throw new Error(`Unsupported codec: ${metadata.codec}.`)
    }

    await store.progress(job.id, 60)
    await media.extract(inputPath, outputPath, config.processTimeoutMs)
    if ((await store.status(job.id)) !== "processing") return
    const output = await stat(outputPath)
    if (!output.isFile() || output.size === 0)
      throw new Error("FFmpeg did not produce a PNG frame.")

    await store.progress(job.id, 85)
    await store.uploadOutput(job, outputPath)
    const committed = await store.markReady(job, {
      width: metadata.width,
      height: metadata.height,
      outputSizeBytes: output.size,
    })
    await store.deleteSource(job)
    if (!committed) await store.deleteOutput(job)
  } catch (error) {
    await Promise.allSettled([store.deleteSource(job), store.deleteOutput(job)])
    if ((await store.status(job.id)) === "processing")
      await store.markFailed(job, friendlyError(error))
  } finally {
    await store.refreshBatch(job.batch_id)
    await rm(tempDirectory, { recursive: true, force: true })
  }
}
