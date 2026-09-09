import type {
  ApiErrorBody,
  PublicBatch,
  UploadCandidate,
  UploadUrlsResponse,
} from "../../shared/contracts"

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787"
).replace(/\/$/, "")

export const SERVER_FALLBACK_ENABLED =
  import.meta.env.VITE_SERVER_FALLBACK_ENABLED !== "false"

export class FirstFrameApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

function requireServerFallback(): void {
  if (!SERVER_FALLBACK_ENABLED)
    throw new FirstFrameApiError(
      "The public version processes videos only on your device.",
      "SERVER_FALLBACK_DISABLED",
    )
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  requireServerFallback()
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  })
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({ error: "The request failed." }))) as ApiErrorBody
    throw new FirstFrameApiError(body.error, body.code, body.details)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export const firstFrameApi = {
  createBatch: () => api<PublicBatch>("/api/batches", { method: "POST" }),
  getBatch: (batchId: string) => api<PublicBatch>(`/api/batches/${batchId}`),
  createUploadUrls: (
    batchId: string,
    files: UploadCandidate[],
    captchaToken?: string,
  ) =>
    api<UploadUrlsResponse>(`/api/batches/${batchId}/upload-urls`, {
      method: "POST",
      body: JSON.stringify({ files, captchaToken }),
    }),
  completeUpload: (batchId: string, jobId: string) =>
    api<{ status: "queued" }>(
      `/api/batches/${batchId}/jobs/${jobId}/complete-upload`,
      { method: "POST" },
    ),
  cancelJob: (jobId: string) =>
    api(`/api/jobs/${jobId}/cancel`, { method: "POST" }),
  deleteJob: (jobId: string) =>
    api<void>(`/api/jobs/${jobId}`, { method: "DELETE" }),
  clearBatch: (batchId: string) =>
    api<void>(`/api/batches/${batchId}/clear`, { method: "POST" }),
  fetchOutput: async (jobId: string) => {
    requireServerFallback()
    const response = await fetch(`${API_BASE}/api/jobs/${jobId}/content`, {
      credentials: "include",
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({
        error: "The PNG could not be downloaded.",
      }))) as ApiErrorBody
      throw new FirstFrameApiError(body.error, body.code, body.details)
    }
    return response.blob()
  },
  outputContentUrl: (jobId: string) => `${API_BASE}/api/jobs/${jobId}/content`,
}

export function uploadToSignedUrl(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
  contentType = file.type,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("PUT", url)
    request.setRequestHeader("Content-Type", contentType)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onerror = () =>
      reject(new Error("The direct video upload was interrupted."))
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve()
      else
        reject(new Error(`The direct video upload failed (${request.status}).`))
    }
    request.send(file)
  })
}

export function downloadFromApi(path: string): void {
  requireServerFallback()
  const link = document.createElement("a")
  link.href = `${API_BASE}${path}`
  link.target = "_self"
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
