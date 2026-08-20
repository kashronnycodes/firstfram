import { loadConfig } from "../server/config.js"
import { SupabaseWorkerStore } from "./store.js"

const config = loadConfig()
const store = new SupabaseWorkerStore(config)
const count = await store.cleanupExpired()
console.log(
  `Removed ${count} expired FirstFrame batch${count === 1 ? "" : "es"}.`,
)
