# FirstFrame

FirstFrame accepts up to 10 MP4, MOV, M4V, or WebM videos and extracts the actual first decoded video frame from each as a PNG. It processes compatible videos entirely in the browser and automatically uses the existing private Supabase + FFmpeg path only when browser decoding fails.

## Architecture

- `src/` — React/Vite frontend. It attempts sequential native video/canvas extraction first. Local videos and PNGs remain in browser memory. Mixed Download All ZIPs are built lazily in the browser with STORE/no recompression.
- `server/` — Node/Express API. It owns the HTTP-only guest cookie, validates ownership and fallback limits, optionally verifies Turnstile, creates signed direct-upload URLs, and streams owned fallback PNGs.
- `worker/` — long-running Node process. It atomically claims one queued job at a time, streams the source into an isolated temporary directory, validates it once with FFprobe, extracts exactly one PNG with bundled FFmpeg, immediately deletes the source, and always removes local temporary files.
- `supabase/migrations/` — Postgres tables, private Storage buckets, RLS lockdown, queue/session concurrency controls, indexes, and atomic per-session/IP fallback quota reservation.

The Supabase service-role key is used only by the API and worker. It must never be exposed in a `VITE_` environment variable.

## 1. Configure Supabase

1. Create a Supabase project.
2. Install/login to the Supabase CLI, link the project, and run:

   ```bash
   supabase db push
   ```

   This applies the base schema and the local-first optimization migration, creates both private buckets, enables RLS, and grants the queue/rate-limit functions only to `service_role`.

3. If you change `MAX_FILE_SIZE_BYTES`, also update the `source-videos` bucket file-size limit in the migration or Supabase dashboard. Storage should reject oversized objects before the worker sees them.

## 2. Environment

Copy `.env.example` to `.env` and fill in the Supabase URL, service-role key, and a random `SESSION_SECRET` of at least 32 characters.

For production:

- set `SECURE_COOKIES=true`;
- set `CLIENT_ORIGIN` to the exact HTTPS frontend origin;
- set `VITE_API_BASE_URL` at frontend build time to the public HTTPS API origin (or proxy `/api` to the API on the same origin);
- keep the source and output buckets private;
- keep API and worker configuration limits aligned;
- optionally configure `VITE_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`; the widget is lazy-loaded only after elevated fallback usage requires it.

`vercel.json` gives hashed Vite assets a one-year immutable CDN cache while retaining security headers on the frontend shell.

The default fallback limits are 500 MB per file, 1 GB per batch, 60 minutes per video, 2 simultaneous processing jobs per guest session, 25 attempts per IP/hour, 75 per IP/day, and 50 per session/day. Signed-upload issuance reserves quota, so upload, codec, corrupt-media, and FFmpeg failures still count. Change the corresponding environment values together with the Storage bucket limit when tuning them.

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

`Dockerfile.api` and `Dockerfile.worker` are separate deployment targets. Give both the same server-only Supabase and limit variables. Each worker processes exactly one video at a time; the atomic database claim also caps simultaneous work per guest session across multiple workers.

## Cleanup and privacy

- Browser-compatible sources never leave the device. Fallback source videos are removed immediately after successful extraction and are also removed when processing fails.
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
GET    /api/jobs/:jobId/content
```

All batch/job routes enforce guest ownership. Storage paths and the service-role key are never returned in public job responses.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm build:all
```

The suite covers local MP4/MOV/M4V/WebM extraction, 4K dimensions, 10-file sequential processing, cancellation and timeout cleanup, mixed browser ZIPs, automatic fallback behavior, signed-upload validation, fallback quotas and Turnstile escalation, guest ownership, CORS-safe secure downloads, FFmpeg timeout/failure cleanup, immediate source deletion, retention selection, and a real FFmpeg/FFprobe smoke test.
