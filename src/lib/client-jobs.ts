import type { PublicFrameJob } from "../../shared/contracts"

export type ProcessingMode = "local" | "server"

export interface ClientFrameJob extends PublicFrameJob {
  processingMode: ProcessingMode
  localOutput?: Blob
}

export function createLocalPlaceholder(
  file: File,
  position: number,
): ClientFrameJob {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    batch_id: "local",
    position,
    original_name: file.name,
    source_size_bytes: file.size,
    mime_type: file.type,
    status: "processing",
    progress: 10,
    width: null,
    height: null,
    output_size_bytes: null,
    error_message: null,
    created_at: now,
    completed_at: null,
    processingMode: "local",
  }
}

export function asServerJob(
  job: PublicFrameJob,
  outputContentUrl?: (jobId: string) => string,
): ClientFrameJob {
  return {
    ...job,
    preview_url:
      job.status === "ready" && outputContentUrl
        ? outputContentUrl(job.id)
        : undefined,
    processingMode: "server",
  }
}

export function mergeServerJobs(
  current: ClientFrameJob[],
  serverJobs: PublicFrameJob[],
  outputContentUrl?: (jobId: string) => string,
): ClientFrameJob[] {
  const updates = new Map(
    serverJobs.map(
      (job) => [job.id, asServerJob(job, outputContentUrl)] as const,
    ),
  )
  const merged = current.map((job) => updates.get(job.id) ?? job)
  const known = new Set(merged.map((job) => job.id))
  for (const job of serverJobs) {
    if (!known.has(job.id)) merged.push(asServerJob(job, outputContentUrl))
  }
  return merged
}

export function pngDownloadName(originalName: string): string {
  const leaf = originalName.replace(/[\\/]/g, "_")
  const dot = leaf.lastIndexOf(".")
  const rawBase = dot > 0 ? leaf.slice(0, dot) : leaf
  const base = rawBase.replace(/[^a-zA-Z0-9._ -]/g, "_").trim() || "frame"
  return `${base.slice(0, 120)}-first-frame.png`
}

export function uniqueDownloadName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf(".")
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  let candidate = name
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})${extension}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export async function collectReadyZipEntries(
  jobs: readonly ClientFrameJob[],
  fetchServerOutput: (jobId: string) => Promise<Blob>,
): Promise<Array<{ name: string; blob: Blob }>> {
  const used = new Set<string>()
  const entries: Array<{ name: string; blob: Blob }> = []
  for (const job of jobs) {
    if (job.status !== "ready") continue
    const blob =
      job.processingMode === "local" && job.localOutput
        ? job.localOutput
        : await fetchServerOutput(job.id)
    entries.push({
      name: uniqueDownloadName(pngDownloadName(job.original_name), used),
      blob,
    })
  }
  return entries
}
