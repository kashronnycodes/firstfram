# FirstFrame

FirstFrame accepts up to 10 MP4, MOV, M4V, or WebM videos and extracts the actual first decoded video frame from each as a PNG. The original pixel-art Figma interface is connected to a private Supabase database/storage backend and a separate sequential FFmpeg worker.

## Architecture

- `src/` — React/Vite frontend. It creates a guest-owned batch, requests signed upload links, uploads directly to private storage, polls job state, and downloads signed PNG/ZIP results.
- `server/` — Node/Express API. It owns the HTTP-only guest cookie, validates ownership and limits, creates signed URLs, verifies completed uploads, and streams secure downloads.
- `worker/` — long-running Node process. It atomically claims one queued job at a time, streams the source into an isolated temporary directory, validates it with FFprobe, extracts a PNG with bundled FFmpeg, uploads the result, and deletes the source and local files.
- `supabase/migrations/` — Postgres tables, private Storage buckets, RLS lockdown, atomic queue claiming, and per-session/IP capacity reservation.

The Supabase service-role key is used only by the API and worker. It must never be exposed in a `VITE_` environment variable.

## 1. Configure Supabase

1. Create a Supabase project.
2. Install/login to the Supabase CLI, link the project, and run:

   ```bash
   supabase db push
   ```

   This applies `supabase/migrations/20260819000000_firstframe.sql`, creates both private buckets, enables RLS, and grants the queue/rate-limit functions only to `service_role`.

3. If you change `MAX_FILE_SIZE_BYTES`, also update the `source-videos` bucket file-size limit in the migration or Supabase dashboard. Storage should reject oversized objects before the worker sees them.

## 2. Environment

Copy `.env.example` to `.env` and fill in the Supabase URL, service-role key, and a random `SESSION_SECRET` of at least 32 characters.

For production:

- set `SECURE_COOKIES=true`;
- set `CLIENT_ORIGIN` to the exact HTTPS frontend origin;
- set `VITE_API_BASE_URL` at frontend build time to the public HTTPS API origin (or proxy `/api` to the API on the same origin);
- keep the source and output buckets private;
- keep API and worker configuration limits aligned.

## 3. Local development

Install packages once:

```bash
pnpm install
```

Run the three processes in separate terminals:

```bash
pnpm dev
pnpm dev:api
pnpm dev:worker
```

The frontend defaults to `http://localhost:8443` and the API to `http://localhost:8787`.

## 4. Production processes

Build the frontend and Node services:

```bash
pnpm build:all
```

Run the compiled API and the worker as separate services:

```bash
node build/server/index.js
node build/worker/index.js
```

`Dockerfile.api` and `Dockerfile.worker` are separate deployment targets. Give both the same server-only Supabase and limit variables. Run exactly one job at a time per worker instance; add worker instances only when the host has enough CPU, memory, and temporary disk.

## Cleanup and privacy

- Source videos are removed immediately after successful extraction and are also removed when processing fails.
- Every worker performs expired-batch cleanup on startup and hourly.
- `pnpm cleanup` is a one-shot cleanup command suitable for an external scheduler.
- Output PNGs, remaining objects, database rows, and stale rate events are removed after the configured retention period (24 hours by default).
- Cancel/remove/clear endpoints verify the HTTP-only guest session before changing records or deleting objects.

## API

```text
POST   /api/batches
POST   /api/batches/:batchId/upload-urls
POST   /api/batches/:batchId/jobs/:jobId/complete-upload
GET    /api/batches/:batchId
POST   /api/jobs/:jobId/cancel
DELETE /api/jobs/:jobId
POST   /api/batches/:batchId/clear
GET    /api/jobs/:jobId/download
GET    /api/batches/:batchId/download-all
```

All batch/job routes enforce guest ownership. Storage paths and the service-role key are never returned in public job responses.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm build:all
```

The suite covers the 10-video limit, guest ownership, signed-upload completion, valid state transitions, duplicate output names, failed media processing, retention selection, temporary-file cleanup, and a real FFmpeg/FFprobe smoke test that verifies a PNG is generated from a sample video.
