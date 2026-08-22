import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import type { InternalFrameJob } from "../../server/store.js"
import { testConfig } from "../../server/__tests__/fixtures.js"
import { processFrameJob } from "../processor.js"
import type { WorkerStore } from "../store.js"

const roots: string[] = []
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
)

it("marks a failed FFmpeg job without crashing and removes temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstframe-test-root-"))
  roots.push(root)
  const job: InternalFrameJob = {
    id: "00000000-0000-4000-8000-000000000001",
    batch_id: "00000000-0000-4000-8000-000000000002",
    position: 0,
    original_name: "broken.mp4",
    source_storage_key: "source",
    output_storage_key: "output",
    source_size_bytes: 4,
    mime_type: "video/mp4",
    status: "processing",
    progress: 10,
    width: null,
    height: null,
    output_size_bytes: null,
    error_message: null,
    created_at: new Date().toISOString(),
    completed_at: null,
  }
  let status = "processing"
  let failedMessage = ""
  const store: WorkerStore = {
    claim: async () => null,
    status: async () => status,
    sourceStream: async () => Readable.from(Buffer.from("nope")),
    uploadOutput: async () => undefined,
    markReady: async () => false,
    markFailed: async (_job, message) => {
      status = "failed"
      failedMessage = message
    },
    deleteSource: async () => undefined,
    deleteOutput: async () => undefined,
    refreshBatch: async () => undefined,
    cleanupExpired: async () => 0,
  }
  await processFrameJob(job, store, { ...testConfig, workerTempRoot: root }, {
    probe: async () => {
      throw new Error("bad ffprobe")
    },
    extract: async () => undefined,
  })
  expect(status).toBe("failed")
  expect(failedMessage).toContain("could not extract")
  expect(await readdir(root)).toEqual([])
})

it("deletes the private source immediately after extraction and removes temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstframe-test-root-"))
  roots.push(root)
  const job: InternalFrameJob = {
    id: "00000000-0000-4000-8000-000000000011",
    batch_id: "00000000-0000-4000-8000-000000000012",
    position: 0,
    original_name: "valid.mp4",
    source_storage_key: "source",
    output_storage_key: "output",
    source_size_bytes: 4,
    mime_type: "video/mp4",
    status: "processing",
    progress: 10,
    width: null,
    height: null,
    output_size_bytes: null,
    error_message: null,
    created_at: new Date().toISOString(),
    completed_at: null,
  }
  const events: string[] = []
  let status = "processing"
  const store: WorkerStore = {
    claim: async () => null,
    status: async () => status,
    sourceStream: async () => Readable.from(Buffer.from("video")),
    uploadOutput: async () => {
      events.push("upload-output")
    },
    markReady: async () => {
      events.push("mark-ready")
      status = "ready"
      return true
    },
    markFailed: async () => undefined,
    deleteSource: async () => {
      events.push("delete-source")
    },
    deleteOutput: async () => {
      events.push("delete-output")
    },
    refreshBatch: async () => undefined,
    cleanupExpired: async () => 0,
  }
  await processFrameJob(job, store, { ...testConfig, workerTempRoot: root }, {
    probe: async () => ({
      durationSeconds: 10,
      width: 1920,
      height: 1080,
      codec: "h264",
    }),
    extract: async (_inputPath, outputPath) => {
      events.push("extract")
      await writeFile(outputPath, Buffer.from("png"))
    },
  })
  expect(status).toBe("ready")
  expect(events).toEqual([
    "extract",
    "delete-source",
    "upload-output",
    "mark-ready",
  ])
  expect(await readdir(root)).toEqual([])
})
