import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import type { AppConfig } from "../config.js"
import type {
  ApiStore,
  CapacityDecision,
  CapacityRequest,
  InternalBatch,
  InternalFrameJob,
  NewUploadingJob,
} from "../store.js"

export const testConfig: AppConfig = {
  apiPort: 0,
  clientOrigin: "http://localhost:8443",
  sessionSecret: "test-secret-that-is-longer-than-thirty-two-characters",
  secureCookies: false,
  supabaseUrl: "http://supabase.test",
  supabaseServiceRoleKey: "service-role-test",
  sourceBucket: "source-videos",
  outputBucket: "output-frames",
  maxFileSizeBytes: 1_000_000,
  maxBatchSizeBytes: 10_000_000,
  maxVideoDurationSeconds: 60,
  maxJobsPerSessionPerDay: 100,
  maxJobsPerIpPerHour: 25,
  maxJobsPerIpPerDay: 200,
  captchaThresholdPerIpHour: 15,
  captchaThresholdPerIpDay: 40,
  maxConcurrentFallbacksPerSession: 2,
  maxVideosPerBatch: 10,
  retentionHours: 24,
  previewUrlTtlSeconds: 300,
  workerPollMs: 10,
  workerTempRoot: undefined,
  processTimeoutMs: 10_000,
  allowedVideoCodecs: new Set(["h264"]),
  turnstileSecretKey: undefined,
}

export class MemoryApiStore implements ApiStore {
  batches = new Map<string, InternalBatch>()
  jobs = new Map<string, InternalFrameJob>()
  objectSizes = new Map<string, number>()
  signedOutputRequests: Array<{
    storageKey: string
    expiresIn: number
    downloadName?: string
  }> = []
  capacityDecision: CapacityDecision = "reserved"
  capacityRequests: CapacityRequest[] = []

  async createBatch(
    guestSessionId: string,
    expiresAt: string,
  ): Promise<InternalBatch> {
    const batch: InternalBatch = {
      id: randomUUID(),
      guest_session_id: guestSessionId,
      status: "uploading",
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      jobs: [],
    }
    this.batches.set(batch.id, batch)
    return batch
  }
  async getBatchOwned(batchId: string, guestSessionId: string) {
    const batch = this.batches.get(batchId)
    if (!batch || batch.guest_session_id !== guestSessionId) return null
    return { ...batch, jobs: [...batch.jobs] }
  }
  async getJobOwned(jobId: string, guestSessionId: string) {
    const job = this.jobs.get(jobId)
    const batch = job && this.batches.get(job.batch_id)
    return job && batch?.guest_session_id === guestSessionId ? job : null
  }
  async reserveCapacity(request: CapacityRequest) {
    this.capacityRequests.push(request)
    if (this.capacityDecision === "captcha_required" && request.captchaVerified)
      return "reserved" as const
    return this.capacityDecision
  }
  async createUploadingJobs(rows: NewUploadingJob[]) {
    return rows.map((row) => {
      const job: InternalFrameJob = {
        ...row,
        status: "uploading",
        progress: 0,
        width: null,
        height: null,
        output_size_bytes: null,
        error_message: null,
        created_at: new Date().toISOString(),
        completed_at: null,
      }
      this.jobs.set(job.id, job)
      this.batches.get(job.batch_id)?.jobs.push(job)
      return job
    })
  }
  async createSignedUploadUrl(storageKey: string) {
    const job = [...this.jobs.values()].find(
      (candidate) => candidate.source_storage_key === storageKey,
    )
    if (job) this.objectSizes.set(storageKey, job.source_size_bytes)
    return `https://storage.test/upload?token=signed-${encodeURIComponent(storageKey)}`
  }
  async sourceObjectSize(storageKey: string) {
    return this.objectSizes.get(storageKey) ?? null
  }
  async markQueued(jobId: string) {
    const job = this.jobs.get(jobId)
    if (job) {
      job.status = "queued"
      job.progress = 5
    }
  }
  async markCancelled(jobId: string) {
    const job = this.jobs.get(jobId)
    if (job) job.status = "cancelled"
  }
  async removeJobFiles(job: InternalFrameJob) {
    this.objectSizes.delete(job.source_storage_key)
  }
  async deleteJob(jobId: string) {
    const job = this.jobs.get(jobId)
    if (job)
      this.batches.get(job.batch_id)!.jobs = this.batches
        .get(job.batch_id)!
        .jobs.filter((item) => item.id !== jobId)
    this.jobs.delete(jobId)
  }
  async clearBatch(batch: InternalBatch) {
    batch.jobs.forEach((job) => this.jobs.delete(job.id))
    this.batches.get(batch.id)!.jobs = []
  }
  async createOutputSignedUrl(
    storageKey: string,
    expiresIn: number,
    downloadName?: string,
  ) {
    this.signedOutputRequests.push({ storageKey, expiresIn, downloadName })
    const download = downloadName
      ? `&download=${encodeURIComponent(downloadName)}`
      : ""
    return `https://storage.test/output?token=${encodeURIComponent(storageKey)}${download}`
  }
  async openOutput() {
    return Readable.from(Buffer.from("png"))
  }
}
