import { randomUUID } from "node:crypto"
import path from "node:path"
import archiver from "archiver"
import cookieParser from "cookie-parser"
import cors from "cors"
import express, { type Request } from "express"
import { rateLimit } from "express-rate-limit"
import helmet from "helmet"
import { z } from "zod"
import type { AppConfig } from "./config.js"
import { ApiError, errorHandler, notFound } from "./errors.js"
import { guestSession, requestIpHash, type GuestRequest } from "./session.js"
import type { ApiStore, InternalBatch } from "./store.js"
import { toPublicJob } from "./store.js"
import {
  safeDownloadBaseName,
  uniqueOutputName,
  uploadBodySchema,
  validateUploadCandidate,
} from "./validation.js"

const idSchema = z.string().uuid()

function guest(request: Request): GuestRequest {
  return request as GuestRequest
}

async function requireBatch(
  store: ApiStore,
  batchId: string,
  sessionId: string,
): Promise<InternalBatch> {
  const batch = await store.getBatchOwned(idSchema.parse(batchId), sessionId)
  if (!batch)
    throw new ApiError(
      404,
      "This batch was not found in your browser session.",
      "BATCH_NOT_FOUND",
    )
  return batch
}

async function publicBatch(
  store: ApiStore,
  batch: InternalBatch,
  config: AppConfig,
) {
  const jobs = await Promise.all(
    batch.jobs.map(async (job) => {
      const safeJob = toPublicJob(job)
      if (job.status === "ready") {
        safeJob.preview_url = await store.createOutputSignedUrl(
          job.output_storage_key,
          config.previewUrlTtlSeconds,
        )
      }
      return safeJob
    }),
  )
  const { guest_session_id: _session, ...safeBatch } = batch
  return { ...safeBatch, jobs }
}

export function createApp(config: AppConfig, store: ApiStore) {
  const app = express()
  app.set("trust proxy", 1)
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }))
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, !origin || origin === config.clientOrigin)
      },
      credentials: true,
      methods: ["GET", "POST", "DELETE"],
    }),
  )
  app.use(express.json({ limit: "64kb" }))
  app.use(cookieParser())
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: "Too many requests. Please wait a few minutes and try again.",
        code: "RATE_LIMITED",
      },
    }),
  )
  app.use(guestSession(config.sessionSecret, config.secureCookies))

  app.get("/api/health", (_request, response) => response.json({ ok: true }))

  app.post("/api/batches", async (request, response) => {
    const expiresAt = new Date(
      Date.now() + config.retentionHours * 60 * 60 * 1_000,
    ).toISOString()
    const batch = await store.createBatch(
      guest(request).guestSessionId,
      expiresAt,
    )
    response.status(201).json(await publicBatch(store, batch, config))
  })

  app.post("/api/batches/:batchId/upload-urls", async (request, response) => {
    const batch = await requireBatch(
      store,
      request.params.batchId,
      guest(request).guestSessionId,
    )
    const parsed = uploadBodySchema.parse(request.body)
    const remaining = Math.max(0, config.maxVideosPerBatch - batch.jobs.length)
    if (remaining === 0)
      throw new ApiError(409, "This batch already has 10 videos.", "BATCH_FULL")

    const acceptedInput = parsed.files.slice(0, remaining)
    const skipped = parsed.files.length - acceptedInput.length
    const accepted = acceptedInput.map((file) =>
      validateUploadCandidate(file, config),
    )
    const existingSize = batch.jobs.reduce(
      (sum, job) => sum + job.source_size_bytes,
      0,
    )
    const newSize = accepted.reduce((sum, file) => sum + file.size, 0)
    if (existingSize + newSize > config.maxBatchSizeBytes) {
      throw new ApiError(
        413,
        "Those videos exceed the configured total batch size.",
        "BATCH_TOO_LARGE",
      )
    }

    const capacity = await store.reserveCapacity(
      guest(request).guestSessionId,
      requestIpHash(request, config.sessionSecret),
      accepted.length,
      config.maxJobsPerSessionPerDay,
      config.maxJobsPerIpPerDay,
    )
    if (!capacity)
      throw new ApiError(
        429,
        "This browser or network has reached today's processing limit.",
        "JOB_LIMIT_REACHED",
      )

    const rows = accepted.map((file, index) => {
      const id = randomUUID()
      const position = batch.jobs.length + index
      return {
        id,
        batch_id: batch.id,
        position,
        original_name: file.name,
        source_storage_key: `sessions/${guest(request).guestSessionId.slice(0, 16)}/${batch.id}/${id}${file.extension}`,
        output_storage_key: `batches/${batch.id}/${id}.png`,
        source_size_bytes: file.size,
        mime_type: file.type,
      }
    })
    const jobs = await store.createUploadingJobs(rows)
    const uploads = await Promise.all(
      jobs.map(async (job) => ({
        job: toPublicJob(job),
        upload_url: await store.createSignedUploadUrl(job.source_storage_key),
      })),
    )
    response.status(201).json({
      uploads,
      skipped,
      message:
        skipped > 0
          ? `${skipped} video${
              skipped === 1 ? " was" : "s were"
            } skipped because a batch can contain 10.`
          : undefined,
    })
  })

  app.post(
    "/api/batches/:batchId/jobs/:jobId/complete-upload",
    async (request, response) => {
      const batch = await requireBatch(
        store,
        request.params.batchId,
        guest(request).guestSessionId,
      )
      const jobId = idSchema.parse(request.params.jobId)
      const job = batch.jobs.find((candidate) => candidate.id === jobId)
      if (!job)
        throw new ApiError(
          404,
          "This upload was not found in your browser session.",
          "JOB_NOT_FOUND",
        )
      if (job.status !== "uploading")
        throw new ApiError(
          409,
          "This upload has already been finalized.",
          "INVALID_JOB_STATE",
        )
      const actualSize = await store.sourceObjectSize(job.source_storage_key)
      if (actualSize === null)
        throw new ApiError(
          409,
          "The uploaded video could not be found. Please upload it again.",
          "UPLOAD_MISSING",
        )
      if (
        actualSize !== job.source_size_bytes ||
        actualSize > config.maxFileSizeBytes
      ) {
        await store.removeJobFiles(job)
        await store.markCancelled(job.id)
        throw new ApiError(
          400,
          "The uploaded video size did not match the signed upload request.",
          "UPLOAD_SIZE_MISMATCH",
        )
      }
      await store.markQueued(job.id)
      response.status(202).json({ status: "queued" })
    },
  )

  app.get("/api/batches/:batchId", async (request, response) => {
    const batch = await requireBatch(
      store,
      request.params.batchId,
      guest(request).guestSessionId,
    )
    response.json(await publicBatch(store, batch, config))
  })

  app.post("/api/jobs/:jobId/cancel", async (request, response) => {
    const job = await store.getJobOwned(
      idSchema.parse(request.params.jobId),
      guest(request).guestSessionId,
    )
    if (!job)
      throw new ApiError(
        404,
        "This video job was not found in your browser session.",
        "JOB_NOT_FOUND",
      )
    if (["ready", "failed", "cancelled"].includes(job.status)) {
      response.json({ status: job.status })
      return
    }
    await store.markCancelled(job.id)
    if (job.status !== "processing") await store.removeJobFiles(job)
    response.json({ status: "cancelled" })
  })

  app.delete("/api/jobs/:jobId", async (request, response) => {
    const job = await store.getJobOwned(
      idSchema.parse(request.params.jobId),
      guest(request).guestSessionId,
    )
    if (!job)
      throw new ApiError(
        404,
        "This video job was not found in your browser session.",
        "JOB_NOT_FOUND",
      )
    if (job.status === "processing") {
      await store.markCancelled(job.id)
    } else {
      await store.removeJobFiles(job)
      await store.deleteJob(job.id)
    }
    response.status(204).end()
  })

  app.post("/api/batches/:batchId/clear", async (request, response) => {
    const batch = await requireBatch(
      store,
      request.params.batchId,
      guest(request).guestSessionId,
    )
    await store.clearBatch(batch)
    response.status(204).end()
  })

  app.get("/api/jobs/:jobId/download", async (request, response) => {
    const job = await store.getJobOwned(
      idSchema.parse(request.params.jobId),
      guest(request).guestSessionId,
    )
    if (!job)
      throw new ApiError(
        403,
        "This PNG does not belong to your browser session.",
        "DOWNLOAD_FORBIDDEN",
      )
    if (job.status !== "ready")
      throw new ApiError(
        404,
        "That PNG is not ready or no longer exists.",
        "OUTPUT_NOT_FOUND",
      )
    const url = await store.createOutputSignedUrl(
      job.output_storage_key,
      config.previewUrlTtlSeconds,
      safeDownloadBaseName(job.original_name),
    )
    response.redirect(302, url)
  })

  app.get("/api/batches/:batchId/download-all", async (request, response) => {
    const batch = await store.getBatchOwned(
      idSchema.parse(request.params.batchId),
      guest(request).guestSessionId,
    )
    if (!batch)
      throw new ApiError(
        403,
        "This ZIP does not belong to your browser session.",
        "DOWNLOAD_FORBIDDEN",
      )
    const ready = batch.jobs.filter((job) => job.status === "ready")
    if (ready.length === 0)
      throw new ApiError(
        409,
        "No PNG frames are ready to download yet.",
        "NO_READY_OUTPUTS",
      )
    response.attachment(`firstframe-${batch.id.slice(0, 8)}.zip`)
    response.type("application/zip")
    const archive = archiver("zip", { zlib: { level: 6 } })
    archive.on("error", (error) => response.destroy(error))
    archive.pipe(response)
    const used = new Set<string>()
    for (const job of ready) {
      const name = uniqueOutputName(
        safeDownloadBaseName(job.original_name),
        used,
      )
      archive.append(await store.openOutput(job.output_storage_key), { name })
    }
    await archive.finalize()
  })

  app.use(notFound)
  app.use(errorHandler)
  return app
}
