import path from "node:path"
import { z } from "zod"
import type { AppConfig } from "./config.js"
import { ApiError } from "./errors.js"

const MIME_BY_EXTENSION: Record<string, Set<string>> = {
  ".mp4": new Set(["video/mp4", "application/mp4"]),
  ".mov": new Set(["video/quicktime"]),
  ".m4v": new Set(["video/x-m4v", "video/mp4"]),
  ".webm": new Set(["video/webm"]),
}

export const uploadBodySchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(255),
        size: z.number().int().positive(),
        type: z.string().trim().min(1).max(100),
      }),
    )
    .min(1)
    .max(100),
})

export function validateUploadCandidate(
  candidate: z.infer<typeof uploadBodySchema>["files"][number],
  config: AppConfig,
) {
  const extension = path.extname(candidate.name).toLowerCase()
  const acceptedTypes = MIME_BY_EXTENSION[extension]
  if (!acceptedTypes || !acceptedTypes.has(candidate.type.toLowerCase())) {
    throw new ApiError(
      400,
      `${candidate.name} is not a supported MP4, MOV, M4V, or WebM video.`,
      "UNSUPPORTED_VIDEO_TYPE",
    )
  }
  if (candidate.size > config.maxFileSizeBytes) {
    throw new ApiError(
      413,
      `${candidate.name} is larger than the configured file limit.`,
      "FILE_TOO_LARGE",
    )
  }
  return { ...candidate, extension }
}

export function safeDownloadBaseName(originalName: string): string {
  const parsed = path.parse(originalName.replace(/[\\/]/g, "_"))
  const base = parsed.name.replace(/[^a-zA-Z0-9._ -]/g, "_").trim() || "frame"
  return `${base.slice(0, 120)}-first-frame.png`
}

export function uniqueOutputName(name: string, used: Set<string>): string {
  const parsed = path.parse(name)
  let candidate = name
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${parsed.name} (${suffix})${parsed.ext}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}
