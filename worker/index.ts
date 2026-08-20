import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { loadConfig } from "../server/config.js"
import { processFrameJob } from "./processor.js"
import { SupabaseWorkerStore } from "./store.js"

const config = loadConfig()
const store = new SupabaseWorkerStore(config)
const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`
let stopping = false

process.once("SIGINT", () => (stopping = true))
process.once("SIGTERM", () => (stopping = true))

async function runSequentialWorker() {
  console.log(`FirstFrame worker ${workerId} started (one video at a time).`)
  while (!stopping) {
    try {
      const job = await store.claim(workerId)
      if (!job) {
        await delay(config.workerPollMs)
        continue
      }
      await processFrameJob(job, store, config)
    } catch (error) {
      console.error("Worker loop error", error)
      await delay(Math.max(config.workerPollMs, 2_000))
    }
  }
}

const cleanupTimer = setInterval(
  () => {
    store
      .cleanupExpired()
      .catch((error) => console.error("Scheduled cleanup failed", error))
  },
  60 * 60 * 1_000,
)
cleanupTimer.unref()

await store.cleanupExpired()
await runSequentialWorker()
