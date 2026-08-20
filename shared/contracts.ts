export type BatchStatus = "uploading" | "queued" | "processing" | "complete" | "failed"

export type JobStatus = "uploading" | "queued" | "processing" | "ready" | "failed" | "cancelled"

export interface PublicFrameJob {
  id: string
  batch_id: string
  position: number
  original_name: string
  source_size_bytes: number
  mime_type: string
  status: JobStatus
  progress: number
  width: number | null
  height: number | null
  output_size_bytes: number | null
  error_message: string | null
  created_at: string
  completed_at: string | null
  preview_url?: string
}

export interface PublicBatch {
  id: string
  status: BatchStatus
  created_at: string
  expires_at: string
  jobs: PublicFrameJob[]
}

export interface UploadCandidate {
  name: string
  size: number
  type: string
}

export interface SignedUpload {
  job: PublicFrameJob
  upload_url: string
}

export interface UploadUrlsResponse {
  uploads: SignedUpload[]
  skipped: number
  message?: string
}

export interface ApiErrorBody {
  error: string
  code?: string
  details?: unknown
}
