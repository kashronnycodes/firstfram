import "dotenv/config"

export interface AppConfig {
  apiPort: number
  clientOrigin: string
  sessionSecret: string
  secureCookies: boolean
  supabaseUrl: string
  supabaseServiceRoleKey: string
  sourceBucket: string
  outputBucket: string
  maxFileSizeBytes: number
  maxBatchSizeBytes: number
  maxVideoDurationSeconds: number
  maxJobsPerSessionPerDay: number
  maxJobsPerIpPerHour: number
  maxJobsPerIpPerDay: number
  captchaThresholdPerIpHour: number
  captchaThresholdPerIpDay: number
  maxConcurrentFallbacksPerSession: number
  maxVideosPerBatch: number
  retentionHours: number
  previewUrlTtlSeconds: number
  workerPollMs: number
  workerTempRoot: string | undefined
  processTimeoutMs: number
  allowedVideoCodecs: Set<string>
  turnstileSecretKey: string | undefined
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return parsed
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function loadConfig(): AppConfig {
  const sessionSecret = required("SESSION_SECRET")
  if (sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters")

  return {
    apiPort: numberFromEnv("API_PORT", 8787),
    clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:8443",
    sessionSecret,
    secureCookies: process.env.SECURE_COOKIES === "true",
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    sourceBucket: process.env.SOURCE_VIDEO_BUCKET ?? "source-videos",
    outputBucket: process.env.OUTPUT_FRAME_BUCKET ?? "output-frames",
    maxFileSizeBytes: numberFromEnv("MAX_FILE_SIZE_BYTES", 524_288_000),
    maxBatchSizeBytes: numberFromEnv("MAX_BATCH_SIZE_BYTES", 1_073_741_824),
    maxVideoDurationSeconds: numberFromEnv("MAX_VIDEO_DURATION_SECONDS", 3_600),
    maxJobsPerSessionPerDay: numberFromEnv("MAX_JOBS_PER_SESSION_PER_DAY", 50),
    maxJobsPerIpPerHour: numberFromEnv("MAX_JOBS_PER_IP_PER_HOUR", 25),
    maxJobsPerIpPerDay: numberFromEnv("MAX_JOBS_PER_IP_PER_DAY", 75),
    captchaThresholdPerIpHour: numberFromEnv(
      "CAPTCHA_THRESHOLD_PER_IP_HOUR",
      15,
    ),
    captchaThresholdPerIpDay: numberFromEnv("CAPTCHA_THRESHOLD_PER_IP_DAY", 40),
    maxConcurrentFallbacksPerSession: numberFromEnv(
      "MAX_CONCURRENT_FALLBACKS_PER_SESSION",
      2,
    ),
    maxVideosPerBatch: 10,
    retentionHours: numberFromEnv("RETENTION_HOURS", 24),
    previewUrlTtlSeconds: numberFromEnv("PREVIEW_URL_TTL_SECONDS", 300),
    workerPollMs: numberFromEnv("WORKER_POLL_MS", 1_500),
    workerTempRoot: process.env.WORKER_TEMP_ROOT || undefined,
    processTimeoutMs: numberFromEnv("FFMPEG_TIMEOUT_MS", 900_000),
    allowedVideoCodecs: new Set(
      (process.env.ALLOWED_VIDEO_CODECS ?? "h264,hevc,vp8,vp9,av1,prores,mpeg4")
        .split(",")
        .map((codec) => codec.trim().toLowerCase())
        .filter(Boolean),
    ),
    turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY?.trim() || undefined,
  }
}
