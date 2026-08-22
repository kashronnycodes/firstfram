import { randomUUID } from "node:crypto"
import path from "node:path"
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
import { createTurnstileVerifier, type CaptchaVerifier } from "./turnstile.js"
import {
  safeDownloadBaseName,
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

function publicBatch(batch: InternalBatch) {
  const jobs = batch.jobs.map(toPublicJob)
  const { guest_session_id: _session, ...safeBatch } = batch
  return { ...safeBatch, jobs }
}

export function createApp(
  config: AppConfig,
  store: ApiStore,
  verifyCaptcha: CaptchaVerifier = createTurnstileVerifier(
    config.turnstileSecretKey,
  ),
) {
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
    response.status(201).json(publicBatch(batch))
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
    if (parsed.files.length > remaining)
      throw new ApiError(
        400,
        `This request would exceed the ${config.maxVideosPerBatch}-video fallback batch limit.`,
        "BATCH_LIMIT_EXCEEDED",
      )

    const accepted = parsed.files.map((file) =>
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

    const capacityRequest = {
      sessionHash: guest(request).guestSessionId,
      ipHash: requestIpHash(request, config.sessionSecret),
      count: accepted.length,
      maxPerSessionDay: config.maxJobsPerSessionPerDay,
      maxPerIpHour: config.maxJobsPerIpPerHour,
      maxPerIpDay: config.maxJobsPerIpPerDay,
      captchaThresholdPerIpHour: config.captchaThresholdPerIpHour,
      captchaThresholdPerIpDay: config.captchaThresholdPerIpDay,
      maxConcurrentPerSession: config.maxConcurrentFallbacksPerSession,
      requireCaptcha: Boolean(config.turnstileSecretKey),
      captchaVerified: false,
    }
    let capacity = await store.reserveCapacity(capacityRequest)
    if (capacity === "captcha_required") {
      const verified =
        Boolean(parsed.captchaToken) &&
        (await verifyCaptcha(parsed.captchaToken!, request.ip))
      if (!verified)
        throw new ApiError(
          403,
          "Please complete the verification before using more compatibility fallbacks.",
          "CAPTCHA_REQUIRED",
        )
      capacity = await store.reserveCapacity({
        ...capacityRequest,
        captchaVerified: true,
      })
    }
    if (capacity === "concurrent_limit")
      throw new ApiError(
        429,
        "This browser already has the maximum number of active fallback extractions.",
        "CONCURRENT_FALLBACK_LIMIT",
      )
    if (capacity !== "reserved")
      throw new ApiError(
        429,
        "This browser or network has reached the compatibility fallback limit.",
        "FALLBACK_RATE_LIMITED",
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
      skipped: 0,
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
    response.json(publicBatch(batch))
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

  app.get("/api/jobs/:jobId/content", async (request, response) => {
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
    response.type("image/png")
    response.setHeader("Cache-Control", "private, no-store")
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${safeDownloadBaseName(job.original_name)}"`,
    )
    const output = await store.openOutput(job.output_storage_key)
    output.on("error", (error) => response.destroy(error))
    output.pipe(response)
  })

  app.use(notFound)
  app.use(errorHandler)
  return app
}
