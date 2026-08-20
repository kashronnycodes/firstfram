import request from "supertest"
import { describe, expect, it } from "vitest"
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

  it("accepts only the first 10 videos and reports skipped files", async () => {
    const store = new MemoryApiStore()
    const agent = request.agent(createApp(testConfig, store))
    const batch = await agent.post("/api/batches").expect(201)
    const response = await agent
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: Array.from({ length: 11 }, (_, index) => video(index)) })
      .expect(201)
    expect(response.body.uploads).toHaveLength(10)
    expect(response.body.skipped).toBe(1)
    expect(response.body.message).toContain("1 video was skipped")
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
  })

  it("streams Save All as an attachment ZIP", async () => {
    const store = new MemoryApiStore()
    const owner = request.agent(createApp(testConfig, store))
    const batch = await owner.post("/api/batches").expect(201)
    const signed = await owner
      .post(`/api/batches/${batch.body.id}/upload-urls`)
      .send({ files: [video(1)] })
      .expect(201)
    const job = store.jobs.get(signed.body.uploads[0].job.id)!
    job.status = "ready"
    job.progress = 100
    job.width = 1280
    job.height = 720
    job.output_size_bytes = 3

    const response = await owner
      .get(`/api/batches/${batch.body.id}/download-all`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200)

    expect(response.headers["content-type"]).toContain("application/zip")
    expect(response.headers["content-disposition"]).toContain("attachment;")
    expect(Buffer.isBuffer(response.body)).toBe(true)
    expect(response.body.subarray(0, 2).toString("ascii")).toBe("PK")
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
    await stranger
      .get(`/api/batches/${batch.body.id}/download-all`)
      .expect(403)
  })
})
