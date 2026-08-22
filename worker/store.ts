import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { AppConfig } from "../server/config.js"
import type { InternalFrameJob } from "../server/store.js"

export interface ReadyMetadata {
  width: number
  height: number
  outputSizeBytes: number
}

export interface WorkerStore {
  claim(
    workerId: string,
    maxConcurrentPerSession: number,
  ): Promise<InternalFrameJob | null>
  status(jobId: string): Promise<string | null>
  sourceStream(job: InternalFrameJob): Promise<Readable>
  uploadOutput(job: InternalFrameJob, filePath: string): Promise<void>
  markReady(job: InternalFrameJob, metadata: ReadyMetadata): Promise<boolean>
  markFailed(job: InternalFrameJob, message: string): Promise<void>
  deleteSource(job: InternalFrameJob): Promise<void>
  deleteOutput(job: InternalFrameJob): Promise<void>
  refreshBatch(batchId: string): Promise<void>
  cleanupExpired(): Promise<number>
}

export class SupabaseWorkerStore implements WorkerStore {
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

  async claim(
    workerId: string,
    maxConcurrentPerSession: number,
  ): Promise<InternalFrameJob | null> {
    const { data, error } = await this.client.rpc("claim_frame_job", {
      p_worker_id: workerId,
      p_max_concurrent_per_session: maxConcurrentPerSession,
    })
    if (error) throw error
    const job = (data as InternalFrameJob[] | null)?.[0] ?? null
    if (job) await this.refreshBatch(job.batch_id)
    return job
  }

  async status(jobId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("frame_jobs")
      .select("status")
      .eq("id", jobId)
      .maybeSingle()
    if (error) throw error
    return (data as { status?: string } | null)?.status ?? null
  }

  async sourceStream(job: InternalFrameJob): Promise<Readable> {
    const { data, error } = await this.client.storage
      .from(this.config.sourceBucket)
      .createSignedUrl(job.source_storage_key, 60)
    if (error) throw error
    const response = await fetch(data.signedUrl)
    if (!response.ok || !response.body)
      throw new Error(
        `Unable to download the source video (${response.status}).`,
      )
    return Readable.fromWeb(response.body as never)
  }

  async uploadOutput(job: InternalFrameJob, filePath: string): Promise<void> {
    const bytes = await readFile(filePath)
    const { error } = await this.client.storage
      .from(this.config.outputBucket)
      .upload(job.output_storage_key, bytes, {
        contentType: "image/png",
        cacheControl: "300",
        upsert: false,
      })
    if (error) throw error
  }

  async markReady(
    job: InternalFrameJob,
    metadata: ReadyMetadata,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from("frame_jobs")
      .update({
        status: "ready",
        progress: 100,
        width: metadata.width,
        height: metadata.height,
        output_size_bytes: metadata.outputSizeBytes,
        error_message: null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "processing")
      .select("id")
    if (error) throw error
    return (data?.length ?? 0) === 1
  }

  async markFailed(job: InternalFrameJob, message: string): Promise<void> {
    const { error } = await this.client
      .from("frame_jobs")
      .update({
        status: "failed",
        progress: 0,
        error_message: message.slice(0, 500),
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "processing")
    if (error) throw error
  }

  async deleteSource(job: InternalFrameJob): Promise<void> {
    await this.client.storage
      .from(this.config.sourceBucket)
      .remove([job.source_storage_key])
  }

  async deleteOutput(job: InternalFrameJob): Promise<void> {
    await this.client.storage
      .from(this.config.outputBucket)
      .remove([job.output_storage_key])
  }

  async refreshBatch(batchId: string): Promise<void> {
    const { error } = await this.client.rpc("refresh_batch_status", {
      p_batch_id: batchId,
    })
    if (error) throw error
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString()
    const { data: batches, error } = await this.client
      .from("batches")
      .select("id")
      .lt("expires_at", now)
      .limit(500)
    if (error) throw error
    let cleaned = 0
    for (const batch of (batches ?? []) as Array<{ id: string }>) {
      const { data: jobs, error: jobsError } = await this.client
        .from("frame_jobs")
        .select("source_storage_key,output_storage_key")
        .eq("batch_id", batch.id)
      if (jobsError) throw jobsError
      const sourceKeys = (jobs ?? []).map(
        (job) => job.source_storage_key as string,
      )
      const outputKeys = (jobs ?? []).map(
        (job) => job.output_storage_key as string,
      )
      if (sourceKeys.length)
        await this.client.storage
          .from(this.config.sourceBucket)
          .remove(sourceKeys)
      if (outputKeys.length)
        await this.client.storage
          .from(this.config.outputBucket)
          .remove(outputKeys)
      const { error: deleteError } = await this.client
        .from("batches")
        .delete()
        .eq("id", batch.id)
      if (deleteError) throw deleteError
      cleaned += 1
    }
    await this.client
      .from("job_rate_events")
      .delete()
      .lt(
        "created_at",
        new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
      )
    return cleaned
  }
}
