import { createApp } from "./app.js"
import { loadConfig } from "./config.js"
import { SupabaseApiStore } from "./store.js"

const config = loadConfig()
const store = new SupabaseApiStore(config)
const app = createApp(config, store)

app.listen(config.apiPort, () => {
  console.log(`FirstFrame API listening on http://localhost:${config.apiPort}`)
})
