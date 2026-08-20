import { Readable } from "node:stream"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { AppConfig } from "./config.js"
import type { PublicBatch, PublicFrameJob } from "../shared/contracts.js"

export interface InternalFrameJob extends PublicFrameJob {
  source_storage_key: string
  output_storage_key: string
}

export interface InternalBatch extends Omit<PublicBatch, "jobs"> {
  guest_session_id: string
  jobs: InternalFrameJob[]
}

export interface NewUploadingJob {
  id: string
  batch_id: string
  position: number
  original_name: string
  source_storage_key: string
  output_storage_key: string
  source_size_bytes: number
  mime_type: string
}

export interface ApiStore {
  createBatch(guestSessionId: string, expiresAt: string): Promise<InternalBatch>
  getBatchOwned(
    batchId: string,
    guestSessionId: string,
  ): Promise<InternalBatch | null>
  getJobOwned(
    jobId: string,
    guestSessionId: string,
  ): Promise<InternalFrameJob | null>
  reserveCapacity(
    sessionHash: string,
    ipHash: string,
    count: number,
    maxPerSession: number,
    maxPerIp: number,
  ): Promise<boolean>
  createUploadingJobs(jobs: NewUploadingJob[]): Promise<InternalFrameJob[]>
  createSignedUploadUrl(storageKey: string): Promise<string>
  sourceObjectSize(storageKey: string): Promise<number | null>
  markQueued(jobId: string): Promise<void>
  markCancelled(jobId: string): Promise<void>
  removeJobFiles(job: InternalFrameJob): Promise<void>
  deleteJob(jobId: string): Promise<void>
  clearBatch(batch: InternalBatch): Promise<void>
  createOutputSignedUrl(
    storageKey: string,
    expiresIn: number,
    downloadName?: string,
  ): Promise<string>
  openOutput(storageKey: string): Promise<Readable>
}

type BatchRow = Omit<InternalBatch, "jobs">
type JobRow = InternalFrameJob

function publicJob(job: JobRow): InternalFrameJob {
  return {
    ...job,
    source_size_bytes: Number(job.source_size_bytes),
    output_size_bytes:
      job.output_size_bytes === null ? null : Number(job.output_size_bytes),
    progress: Number(job.progress),
  }
}

export function toPublicJob(job: InternalFrameJob): PublicFrameJob {
  const { source_storage_key: _source, output_storage_key: _output, ...safe } =
    job
  return safe
}

export class SupabaseApiStore implements ApiStore {
  private readonly client: SupabaseClient

  constructor(private readonly config: AppConfig) {
    this.client = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    )
  }

  async createBatch(
    guestSessionId: string,
    expiresAt: string,
  ): Promise<InternalBatch> {
    const { data, error } = await this.client
      .from("batches")
      .insert({
        guest_session_id: guestSessionId,
        status: "uploading",
        expires_at: expiresAt,
      })
      .select("*")
      .single()
    if (error) throw error
    return { ...data as BatchRow, jobs: [] }
  }

  async getBatchOwned(
    batchId: string,
    guestSessionId: string,
  ): Promise<InternalBatch | null> {
    const { data: batch, error: batchError } = await this.client
      .from("batches")
      .select("*")
      .eq("id", batchId)
      .eq("guest_session_id", guestSessionId)
      .maybeSingle()
    if (batchError) throw batchError
    if (!batch) return null
    const { data: jobs, error: jobsError } = await this.client
      .from("frame_jobs")
      .select("*")
      .eq("batch_id", batchId)
      .order("position", { ascending: true })
    if (jobsError) throw jobsError
    return {
      ...batch as BatchRow,
      jobs: ((jobs ?? []) as JobRow[]).map(publicJob),
    }
  }

  async getJobOwned(
    jobId: string,
    guestSessionId: string,
  ): Promise<InternalFrameJob | null> {
    const { data: job, error } = await this.client
      .from("frame_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle()
    if (error) throw error
    if (!job) return null
    const { data: batch, error: batchError } = await this.client
      .from("batches")
      .select("id")
      .eq("id", (job as JobRow).batch_id)
      .eq("guest_session_id", guestSessionId)
      .maybeSingle()
    if (batchError) throw batchError
    return batch ? publicJob(job as JobRow) : null
  }

  async reserveCapacity(
    sessionHash: string,
    ipHash: string,
    count: number,
    maxPerSession: number,
    maxPerIp: number,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc("reserve_job_capacity", {
      p_session_hash: sessionHash,
      p_ip_hash: ipHash,
      p_count: count,
      p_max_per_session: maxPerSession,
      p_max_per_ip: maxPerIp,
    })
    if (error) throw error
    return data === true
  }

  async createUploadingJobs(
    jobs: NewUploadingJob[],
  ): Promise<InternalFrameJob[]> {
    const { data, error } = await this.client
      .from("frame_jobs")
      .insert(jobs.map((job) => ({ ...job, status: "uploading", progress: 0 })))
      .select("*")
    if (error) throw error
    return ((data ?? []) as JobRow[]).map(publicJob)
  }

  async createSignedUploadUrl(storageKey: string): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.config.sourceBucket)
      .createSignedUploadUrl(storageKey)
    if (error) throw error
    return data.signedUrl
  }

  async sourceObjectSize(storageKey: string): Promise<number | null> {
    const separator = storageKey.lastIndexOf("/")
    const directory = storageKey.slice(0, separator)
    const fileName = storageKey.slice(separator + 1)
    const { data, error } = await this.client.storage
      .from(this.config.sourceBucket)
      .list(directory, { search: fileName, limit: 100 })
    if (error) throw error
    const object = data.find((item) => item.name === fileName)
    const size = object?.metadata?.size
    return typeof size === "number" ? size : size ? Number(size) : null
  }

  async markQueued(jobId: string): Promise<void> {
    const { data: job, error } = await this.client
      .from("frame_jobs")
      .update({ status: "queued", progress: 5, error_message: null })
      .eq("id", jobId)
      .eq("status", "uploading")
      .select("batch_id")
      .single()
    if (error) throw error
    await this.refreshBatch((job as { batch_id: string }).batch_id)
  }

  async markCancelled(jobId: string): Promise<void> {
    const { data: job, error } = await this.client
      .from("frame_jobs")
      .update({
        status: "cancelled",
        progress: 0,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .in("status", ["uploading", "queued", "processing"])
      .select("batch_id")
      .maybeSingle()
    if (error) throw error
    if (job) await this.refreshBatch((job as { batch_id: string }).batch_id)
  }

  async removeJobFiles(job: InternalFrameJob): Promise<void> {
    await Promise.all([
      this.client.storage
        .from(this.config.sourceBucket)
        .remove([job.source_storage_key]),
      this.client.storage
        .from(this.config.outputBucket)
        .remove([job.output_storage_key]),
    ])
  }

  async deleteJob(jobId: string): Promise<void> {
    const { error } = await this.client
      .from("frame_jobs")
      .delete()
      .eq("id", jobId)
    if (error) throw error
  }

  async clearBatch(batch: InternalBatch): Promise<void> {
    await this.client
      .from("frame_jobs")
      .update({
        status: "cancelled",
        progress: 0,
        completed_at: new Date().toISOString(),
      })
      .eq("batch_id", batch.id)
      .in("status", ["uploading", "queued", "processing"])
    await Promise.all(batch.jobs.map((job) => this.removeJobFiles(job)))
    const { error: deleteError } = await this.client
      .from("frame_jobs")
      .delete()
      .eq("batch_id", batch.id)
    if (deleteError) throw deleteError
    const { error: batchError } = await this.client
      .from("batches")
      .update({ status: "failed" })
      .eq("id", batch.id)
    if (batchError) throw batchError
  }

  async createOutputSignedUrl(
    storageKey: string,
    expiresIn: number,
    downloadName?: string,
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.config.outputBucket)
      .createSignedUrl(
        storageKey,
        expiresIn,
        downloadName ? { download: downloadName } : undefined,
      )
    if (error) throw error
    return data.signedUrl
  }

  async openOutput(storageKey: string): Promise<Readable> {
    const signedUrl = await this.createOutputSignedUrl(storageKey, 60)
    const response = await fetch(signedUrl)
    if (!response.ok || !response.body)
      throw new Error(`Unable to fetch output object (${response.status})`)
    return Readable.fromWeb(response.body as never)
  }

  private async refreshBatch(batchId: string): Promise<void> {
    const { error } = await this.client.rpc("refresh_batch_status", {
      p_batch_id: batchId,
    })
    if (error) throw error
  }
}
