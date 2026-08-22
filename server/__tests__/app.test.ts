import request from "supertest"
import { describe, expect, it, vi } from "vitest"
import { createApp } from "../app.js"
import { MemoryApiStore, testConfig } from "./fixtures.js"

const video = (index: number) => ({
  name: `clip-${index}.mp4`,
  size: 1_000 + index,
  type: "video/mp4",
})

function binaryParser(
  response: any,
  callback: (error: Error | null, body: Buffer) => void,
) {
  const chunks: Buffer[] = []
  response.on("data", (chunk: Buffer) => chunks.push(chunk))
  response.on("end", () => callback(null, Buffer.concat(chunks)))
  response.on("error", (error: Error) => callback(error, Buffer.alloc(0)))
}

describe("FirstFrame API", () => {
  it("keeps credentialed API CORS restricted to CLIENT_ORIGIN", async () => {
    const app = createApp(testConfig, new MemoryApiStore())
    const allowed = await request(app)
      .get("/api/health")
      .set("Origin", testConfig.clientOrigin)
      .expect(200)
    const blocked = await request(app)
      .get("/api/health")
      .set("Origin", "https://untrusted.example")
      .expect(200)

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      testConfig.clientOrigin,
    )
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true")
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("rejects a direct API request that exceeds 10 fallback videos", async () => {
    const store = new MemoryApiStore()
    const agent = request.agent(createApp(testConfig, store))
    const batch = await agent.post("/api/batches").expect(201)
    const response = await agent
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: Array.from({ length: 11 }, (_, index) => video(index)) })
      .expect(400)
    expect(response.body.code).toBe("INVALID_INPUT")
    expect(store.capacityRequests).toHaveLength(0)
  })

  it("accepts exactly 10 fallback videos", async () => {
    const store = new MemoryApiStore()
    const agent = request.agent(createApp(testConfig, store))
    const batch = await agent.post("/api/batches").expect(201)
    const response = await agent
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: Array.from({ length: 10 }, (_, index) => video(index)) })
      .expect(201)
    expect(response.body.uploads).toHaveLength(10)
    expect(store.capacityRequests.at(-1)?.count).toBe(10)
  })

  it("does not allow another guest session to read a batch", async () => {
    const app = createApp(testConfig, new MemoryApiStore())
    const owner = request.agent(app)
    const stranger = request.agent(app)
    const batch = await owner.post("/api/batches").expect(201)
    await stranger.get(`/api/batches/${batch.body.id}`).expect(404)
    await owner.get(`/api/batches/${batch.body.id}`).expect(200)
  })

  it("returns an opaque signed upload URL and queues only after storage verification", async () => {
    const store = new MemoryApiStore()
    const agent = request.agent(createApp(testConfig, store))
    const batch = await agent.post("/api/batches").expect(201)
    const signed = await agent
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(201)
    const upload = signed.body.uploads[0]
    expect(upload.upload_url).toMatch(
      /^https:\/\/storage\.test\/upload\?token=/,
    )
    expect(JSON.stringify(upload.job)).not.toContain("source_storage_key")
    await agent
      .post(
        `/api/batches/${batch.body.id}/jobs/${upload.job.id}/complete-upload`,
      )
      .expect(202)
    expect(store.jobs.get(upload.job.id)?.status).toBe("queued")
  })

  it("rejects missing and size-mismatched direct uploads before queueing", async () => {
    const store = new MemoryApiStore()
    const agent = request.agent(createApp(testConfig, store))

    const missingBatch = await agent.post("/api/batches").expect(201)
    const missingSigned = await agent
      .post(`/api/batches/${missingBatch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(201)
    const missingJob = store.jobs.get(missingSigned.body.uploads[0].job.id)!
    store.objectSizes.delete(missingJob.source_storage_key)
    const missing = await agent
      .post(
        `/api/batches/${missingBatch.body.id}/jobs/${missingJob.id}/complete-upload`,
      )
      .expect(409)
    expect(missing.body.code).toBe("UPLOAD_MISSING")
    expect(missingJob.status).toBe("uploading")

    const mismatchBatch = await agent.post("/api/batches").expect(201)
    const mismatchSigned = await agent
      .post(`/api/batches/${mismatchBatch.body.id}/upload-urls`)
      .send({ files: [video(2)] })
      .expect(201)
    const mismatchJob = store.jobs.get(mismatchSigned.body.uploads[0].job.id)!
    store.objectSizes.set(
      mismatchJob.source_storage_key,
      mismatchJob.source_size_bytes + 1,
    )
    const mismatch = await agent
      .post(
        `/api/batches/${mismatchBatch.body.id}/jobs/${mismatchJob.id}/complete-upload`,
      )
      .expect(400)
    expect(mismatch.body.code).toBe("UPLOAD_SIZE_MISMATCH")
    expect(mismatchJob.status).toBe("cancelled")
    expect(store.objectSizes.has(mismatchJob.source_storage_key)).toBe(false)
  })

  it("never accepts a client-controlled storage path or modified ownership identifiers", async () => {
    const store = new MemoryApiStore()
    const app = createApp(testConfig, store)
    const owner = request.agent(app)
    const stranger = request.agent(app)
    const batch = await owner.post("/api/batches").expect(201)
    const signed = await owner
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({
        files: [
          {
            ...video(1),
            name: "../../untrusted.mp4",
            source_storage_key: "public/attacker-controlled.mp4",
          },
        ],
      })
      .expect(201)
    const job = store.jobs.get(signed.body.uploads[0].job.id)!
    expect(job.source_storage_key).toMatch(
      new RegExp(`^sessions/[a-f0-9]{16}/${batch.body.id}/${job.id}\\.mp4$`),
    )
    expect(job.source_storage_key).not.toContain("attacker-controlled")
    await stranger
      .post(`/api/batches/${batch.body.id}/jobs/${job.id}/complete-upload`)
      .expect(404)
    expect(job.status).toBe("uploading")
  })

  it("rejects oversized files and oversized fallback batches before signing", async () => {
    const store = new MemoryApiStore()
    const agent = request.agent(
      createApp(
        { ...testConfig, maxFileSizeBytes: 10_000, maxBatchSizeBytes: 15_000 },
        store,
      ),
    )
    const oversizedBatch = await agent.post("/api/batches").expect(201)
    await agent
      .post(`/api/batches/${oversizedBatch.body.id}/upload-urls`)
      .send({ files: [{ ...video(1), size: 10_001 }] })
      .expect(413)

    const totalBatch = await agent.post("/api/batches").expect(201)
    const response = await agent
      .post(`/api/batches/${totalBatch.body.id}/upload-urls`)
      .send({
        files: [
          { ...video(1), size: 8_000 },
          { ...video(2), size: 8_000 },
        ],
      })
      .expect(413)
    expect(response.body.code).toBe("BATCH_TOO_LARGE")
    expect(store.capacityRequests).toHaveLength(0)
  })

  it.each([
    ["hourly IP quota", "rate_limited", "FALLBACK_RATE_LIMITED"],
    ["daily IP quota", "rate_limited", "FALLBACK_RATE_LIMITED"],
    [
      "concurrent processing quota",
      "concurrent_limit",
      "CONCURRENT_FALLBACK_LIMIT",
    ],
  ] as const)("enforces the %s", async (_label, decision, code) => {
    const store = new MemoryApiStore()
    store.capacityDecision = decision
    const agent = request.agent(createApp(testConfig, store))
    const batch = await agent.post("/api/batches").expect(201)
    const response = await agent
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(429)
    expect(response.body.code).toBe(code)
    expect(store.jobs.size).toBe(0)
  })

  it("requires and verifies Turnstile only after suspicious fallback usage", async () => {
    const store = new MemoryApiStore()
    store.capacityDecision = "captcha_required"
    const verifyCaptcha = vi.fn(
      async (token: string) => token === "valid-token",
    )
    const agent = request.agent(
      createApp(
        { ...testConfig, turnstileSecretKey: "turnstile-test-secret" },
        store,
        verifyCaptcha,
      ),
    )
    const firstBatch = await agent.post("/api/batches").expect(201)
    const required = await agent
      .post(`/api/batches/${firstBatch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(403)
    expect(required.body.code).toBe("CAPTCHA_REQUIRED")
    expect(verifyCaptcha).not.toHaveBeenCalled()

    const secondBatch = await agent.post("/api/batches").expect(201)
    await agent
      .post(`/api/batches/${secondBatch.body.id}/upload-urls`)
      .send({ files: [video(2)], captchaToken: "valid-token" })
      .expect(201)
    expect(verifyCaptcha).toHaveBeenCalledWith(
      "valid-token",
      expect.any(String),
    )
    expect(store.capacityRequests.at(-1)?.captchaVerified).toBe(true)
  })

  it("reserves quota for each issued fallback even when earlier work fails", async () => {
    const store = new MemoryApiStore()
    const agent = request.agent(createApp(testConfig, store))
    for (let index = 0; index < 2; index += 1) {
      const batch = await agent.post("/api/batches").expect(201)
      await agent
        .post(`/api/batches/${batch.body.id}/upload-urls`)
        .send({ files: [video(index)] })
        .expect(201)
    }
    expect(store.capacityRequests.map((item) => item.count)).toEqual([1, 1])
  })

  it("downloads one PNG from localhost by redirecting navigation to a private signed URL", async () => {
    const store = new MemoryApiStore()
    const owner = request.agent(createApp(testConfig, store))
    const batch = await owner.post("/api/batches").expect(201)
    const signed = await owner
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({
        files: [
          {
            name: "original-video-name.mp4",
            size: 1_024,
            type: "video/mp4",
          },
        ],
      })
      .expect(201)
    const job = store.jobs.get(signed.body.uploads[0].job.id)!
    job.status = "ready"
    job.progress = 100
    job.width = 1920
    job.height = 1080
    job.output_size_bytes = 512

    const response = await owner
      .get(`/api/jobs/${job.id}/download`)
      .redirects(0)
      .expect(302)

    expect(response.headers.location).toMatch(
      /^https:\/\/storage\.test\/output\?token=/,
    )
    expect(store.signedOutputRequests.at(-1)?.downloadName).toBe(
      "original-video-name-first-frame.png",
    )
    expect(store.signedOutputRequests.at(-1)?.expiresIn).toBe(
      testConfig.previewUrlTtlSeconds,
    )
  })

  it("streams an owned fallback PNG for the browser-side ZIP", async () => {
    const store = new MemoryApiStore()
    const owner = request.agent(createApp(testConfig, store))
    const batch = await owner.post("/api/batches").expect(201)
    const signed = await owner
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(201)
    const job = store.jobs.get(signed.body.uploads[0].job.id)!
    job.status = "ready"
    const response = await owner
      .get(`/api/jobs/${job.id}/content`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200)
    expect(response.headers["content-type"]).toContain("image/png")
    expect(response.headers["cache-control"]).toBe("private, no-store")
    expect(response.body.toString()).toBe("png")
  })

  it("does not mint or expose signed preview URLs during status polling", async () => {
    const store = new MemoryApiStore()
    const owner = request.agent(createApp(testConfig, store))
    const batch = await owner.post("/api/batches").expect(201)
    const signed = await owner
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(201)
    store.jobs.get(signed.body.uploads[0].job.id)!.status = "ready"

    const polled = await owner.get(`/api/batches/${batch.body.id}`).expect(200)
    expect(polled.body.jobs[0].preview_url).toBeUndefined()
    expect(store.signedOutputRequests).toHaveLength(0)
  })

  it("returns 403 when another guest tries either download route", async () => {
    const store = new MemoryApiStore()
    const app = createApp(testConfig, store)
    const owner = request.agent(app)
    const stranger = request.agent(app)
    const batch = await owner.post("/api/batches").expect(201)
    const signed = await owner
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(201)
    const job = store.jobs.get(signed.body.uploads[0].job.id)!
    job.status = "ready"

    await stranger.get(`/api/jobs/${job.id}/download`).expect(403)
    await stranger.get(`/api/jobs/${job.id}/content`).expect(403)
  })
})
