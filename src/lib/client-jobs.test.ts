import { describe, expect, it, vi } from "vitest"
import type { ClientFrameJob } from "./client-jobs"
import { collectReadyZipEntries, mergeServerJobs } from "./client-jobs"
import { createStoredZip } from "./zip"

function job(
  index: number,
  processingMode: "local" | "server",
  status: ClientFrameJob["status"] = "ready",
): ClientFrameJob {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    batch_id: processingMode === "local" ? "local" : "server-batch",
    position: index,
    original_name: `clip-${index}.mp4`,
    source_size_bytes: 100,
    mime_type: "video/mp4",
    status,
    progress: status === "ready" ? 100 : 0,
    width: status === "ready" ? 1920 : null,
    height: status === "ready" ? 1080 : null,
    output_size_bytes: status === "ready" ? 3 : null,
    error_message: status === "failed" ? "bad video" : null,
    created_at: new Date().toISOString(),
    completed_at: status === "ready" ? new Date().toISOString() : null,
    processingMode,
    localOutput:
      processingMode === "local" && status === "ready"
        ? new Blob([`local-${index}`], { type: "image/png" })
        : undefined,
  }
}

describe("mixed local/server downloads", () => {
  it("collects 8 local and 2 server PNGs and ignores one failed item", async () => {
    const jobs = [
      ...Array.from({ length: 8 }, (_, index) => job(index, "local")),
      job(8, "server"),
      job(9, "server"),
      job(10, "server", "failed"),
    ]
    const fetchServer = vi.fn(
      async (id: string) => new Blob([`server-${id}`], { type: "image/png" }),
    )
    const entries = await collectReadyZipEntries(jobs, fetchServer)
    expect(entries).toHaveLength(10)
    expect(fetchServer).toHaveBeenCalledTimes(2)
    expect(entries.map((entry) => entry.name)).toContain(
      "clip-0-first-frame.png",
    )
    expect(entries.map((entry) => entry.name)).toContain(
      "clip-9-first-frame.png",
    )
    const zip = await createStoredZip(entries)
    const contents = new TextDecoder().decode(await zip.arrayBuffer())
    expect(contents).toContain("local-0")
    expect(contents).toContain(`server-${jobs[9].id}`)
    expect(contents).not.toContain("clip-10-first-frame.png")
  })

  it("uses the guest-authorized API content route for server previews", () => {
    const merged = mergeServerJobs(
      [],
      [job(1, "server")],
      (jobId) => `http://localhost:8787/api/jobs/${jobId}/content`,
    )
    expect(merged[0].preview_url).toBe(
      `http://localhost:8787/api/jobs/${merged[0].id}/content`,
    )
    expect(merged[0].preview_url).not.toContain("token")
  })
})
