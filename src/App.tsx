import { useCallback, useEffect, useRef, useState } from "react"
import type { JobStatus } from "../shared/contracts"
import {
  downloadBlob,
  downloadFromApi,
  FirstFrameApiError,
  firstFrameApi,
  SERVER_FALLBACK_ENABLED,
  uploadToSignedUrl,
} from "./lib/api"
import {
  asServerJob,
  collectReadyZipEntries,
  type ClientFrameJob,
  createLocalPlaceholder,
  mergeServerJobs,
  pngDownloadName,
} from "./lib/client-jobs"
import {
  extractLocalFirstFrame,
  LocalExtractionError,
  processSequentially,
} from "./lib/local-frame"

const MAX_VIDEOS = 10
const MAX_FILE_SIZE = Number(
  import.meta.env.VITE_MAX_FILE_SIZE_BYTES ?? 524_288_000,
)
const MAX_BATCH_SIZE = Number(
  import.meta.env.VITE_MAX_BATCH_SIZE_BYTES ?? 1_073_741_824,
)
const ACTIVE_STATUSES: JobStatus[] = ["uploading", "queued", "processing"]
const ACCEPTED_TYPES: Record<string, string[]> = {
  ".mp4": ["video/mp4", "application/mp4"],
  ".mov": ["video/quicktime"],
  ".m4v": ["video/x-m4v", "video/mp4"],
  ".webm": ["video/webm"],
}

function PixelBtn({
  children,
  variant = "orange",
  small = false,
  onClick,
  fullWidth = false,
  disabled = false,
}: {
  children: React.ReactNode
  variant?: "orange" | "cobalt" | "ghost"
  small?: boolean
  onClick?: () => void
  fullWidth?: boolean
  disabled?: boolean
}) {
  const base =
    variant === "orange"
      ? {
          bg: "#ff6b1a",
          border: "#ff9a5c #c44400 #c44400 #ff9a5c",
          shadow: "inset -2px -2px 0 #8b3000, inset 2px 2px 0 #ffaa70",
          text: "#fff",
        }
      : variant === "cobalt"
        ? {
            bg: "#1e5aaa",
            border: "#3d80d0 #0a2d60 #0a2d60 #3d80d0",
            shadow: "inset -2px -2px 0 #08204a, inset 2px 2px 0 #4a90e0",
            text: "#f0e6cc",
          }
        : {
            bg: "#0f2640",
            border: "#2a7fc1 #081828 #081828 #2a7fc1",
            shadow: "inset -2px -2px 0 #060e18, inset 2px 2px 0 #3a9fd1",
            text: "#2a7fc1",
          }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: base.bg,
        border: "3px solid",
        borderColor: base.border,
        boxShadow: base.shadow,
        color: base.text,
        fontFamily: "'Press Start 2P', monospace",
        fontSize: small ? 8 : 10,
        padding: small ? "6px 10px" : "12px 24px",
        cursor: disabled ? "not-allowed" : "pointer",
        imageRendering: "pixelated",
        letterSpacing: ".05em",
        lineHeight: 1.4,
        userSelect: "none",
        width: fullWidth ? "100%" : undefined,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  )
}

function FilmReel({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="20"
        cy="20"
        r="18"
        stroke="#ff6b1a"
        strokeWidth="3"
        fill="#0d1b2a"
      />
      <circle cx="20" cy="20" r="5" fill="#ff6b1a" />
      {[0, 60, 120, 180, 240, 300].map((degrees) => {
        const radians = (degrees * Math.PI) / 180
        return (
          <line
            key={degrees}
            x1={20 + 5 * Math.cos(radians)}
            y1={20 + 5 * Math.sin(radians)}
            x2={20 + 13 * Math.cos(radians)}
            y2={20 + 13 * Math.sin(radians)}
            stroke="#ff6b1a"
            strokeWidth="2.5"
          />
        )
      })}
      {[30, 90, 150, 210, 270, 330].map((degrees) => {
        const radians = (degrees * Math.PI) / 180
        return (
          <circle
            key={degrees}
            cx={20 + 14 * Math.cos(radians)}
            cy={20 + 14 * Math.sin(radians)}
            r="2.2"
            fill="#ff6b1a"
          />
        )
      })}
      <circle cx="20" cy="20" r="2" fill="#0d1b2a" />
    </svg>
  )
}

function CornerBracket({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
  const paths = {
    tl: "M 20 0 L 0 0 L 0 20",
    tr: "M 0 0 L 20 0 L 20 20",
    bl: "M 0 0 L 0 20 L 20 20",
    br: "M 0 20 L 20 20 L 20 0",
  }
  const positions: Record<string, React.CSSProperties> = {
    tl: { top: -2, left: -2 },
    tr: { top: -2, right: -2 },
    bl: { bottom: -2, left: -2 },
    br: { bottom: -2, right: -2 },
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      style={{ position: "absolute", ...positions[position] }}
      aria-hidden="true"
    >
      <path d={paths[position]} stroke="#2a7fc1" strokeWidth="3" fill="none" />
    </svg>
  )
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "—"
  const units = ["B", "KB", "MB", "GB"]
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

function statusLabel(status: JobStatus) {
  return status === "processing" ? "EXTRACTING" : status.toUpperCase()
}

function Badge({ status }: { status: JobStatus }) {
  const color =
    status === "ready"
      ? "#3dd68c"
      : status === "processing"
        ? "#ff6b1a"
        : status === "failed" || status === "cancelled"
          ? "#e84855"
          : "#2a7fc1"
  return (
    <span
      style={{
        fontFamily: "'Press Start 2P', monospace",
        fontSize: 7,
        color,
        border: `2px solid ${color}`,
        padding: "3px 6px",
        background: `${color}18`,
        whiteSpace: "nowrap",
      }}
    >
      {statusLabel(status)}
    </span>
  )
}

function PlaceholderThumb({
  id,
  width = 52,
  height = 34,
}: {
  id: string
  width?: number
  height?: number
}) {
  const hue =
    Array.from(id.slice(0, 6)).reduce(
      (total, character) => total + character.charCodeAt(0),
      0,
    ) % 180
  return (
    <div
      style={{
        width,
        height,
        background: `linear-gradient(135deg, hsl(${hue + 180} 55% 22%), hsl(${hue + 220} 60% 12%))`,
        border: "2px solid #2a7fc1",
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        color: "rgba(255,255,255,.35)",
      }}
    >
      ▶
    </div>
  )
}

function ClipRow({
  job,
  uploadProgress,
  localError,
  onRemove,
}: {
  job: ClientFrameJob
  uploadProgress?: number
  localError?: string
  onRemove: () => void
}) {
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "#0a1e35",
        border: "2px solid #1a3a5c",
        marginBottom: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {job.preview_url ? (
          <img
            src={job.preview_url}
            alt=""
            style={{
              width: 52,
              height: 34,
              objectFit: "cover",
              border: "2px solid #2a7fc1",
            }}
          />
        ) : (
          <PlaceholderThumb id={job.id} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "#f0e6cc",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginBottom: 4,
            }}
          >
            {job.original_name}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <Badge status={job.status} />
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: "#c8b89a",
              }}
            >
              {formatBytes(job.source_size_bytes)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          style={{
            background: "none",
            border: "none",
            color: "#e84855",
            cursor: "pointer",
            fontSize: 14,
          }}
          title="Remove video"
        >
          ✕
        </button>
      </div>
      {(job.status === "uploading" || job.status === "processing") && (
        <div
          style={{
            marginTop: 7,
            height: 5,
            border: "1px solid #2a7fc1",
            background: "#081828",
          }}
        >
          <div
            style={{
              width: `${
                job.status === "uploading"
                  ? (uploadProgress ?? 0)
                  : job.progress
              }%`,
              height: "100%",
              background: job.status === "uploading" ? "#2a7fc1" : "#ff6b1a",
              transition: "width .2s",
            }}
          />
        </div>
      )}
      {(localError || job.error_message) && (
        <div
          style={{
            marginTop: 6,
            color: "#e84855",
            font: "9px/1.5 'JetBrains Mono', monospace",
          }}
        >
          {localError || job.error_message}
        </div>
      )}
    </div>
  )
}

function FramePreviewCard({
  job,
  onSave,
}: {
  job: ClientFrameJob
  onSave: () => void
}) {
  const baseName = job.original_name.replace(/\.[^.]+$/, "")
  return (
    <div
      style={{
        background: "#0a1e35",
        border: "3px solid #1e5aaa",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ height: 190, background: "#081828", position: "relative" }}>
        {job.preview_url && (
          <img
            src={job.preview_url}
            alt={`First frame extracted from ${job.original_name}`}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        )}
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            background: "#0d1b2acc",
            border: "2px solid #2a7fc1",
            font: "7px 'Press Start 2P', monospace",
            color: "#2a7fc1",
            padding: "3px 6px",
          }}
        >
          FRAME 0001
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            background: "#0d1b2acc",
            border: "2px solid #ff6b1a",
            font: "9px 'JetBrains Mono', monospace",
            color: "#ff6b1a",
            padding: "2px 5px",
          }}
        >
          {job.width} × {job.height}
        </div>
      </div>
      <div
        style={{
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              font: "10px 'JetBrains Mono', monospace",
              color: "#f0e6cc",
              marginBottom: 4,
            }}
          >
            {baseName}.png
          </div>
          <span
            style={{
              font: "7px 'Press Start 2P', monospace",
              color: "#3dd68c",
              border: "2px solid #3dd68c",
              padding: "2px 5px",
              background: "#3dd68c18",
            }}
          >
            PNG READY · {formatBytes(job.output_size_bytes)}
          </span>
        </div>
        <PixelBtn variant="orange" small onClick={onSave}>
          SAVE PNG
        </PixelBtn>
      </div>
    </div>
  )
}

function NavBar() {
  return (
    <nav
      style={{
        background: "#1a4a8a",
        borderBottom: "4px solid #2d6bbf",
        boxShadow: "0 4px 24px rgba(26,74,138,.5)",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "0 24px",
          minHeight: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 20,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <FilmReel size={36} />
          <div>
            <div
              style={{
                font: "14px 'Press Start 2P', monospace",
                color: "#f0e6cc",
                letterSpacing: ".06em",
                textShadow: "2px 2px #0a2d60",
              }}
            >
              FIRSTFRAME
            </div>
            <div
              style={{
                font: "7px 'Press Start 2P', monospace",
                color: "#ff6b1a",
                marginTop: 2,
              }}
            >
              // FRAME LAB
            </div>
          </div>
        </div>
        <div className="nav-items">
          <a href="#how" className="nav-link">
            HOW IT WORKS
          </a>
          <a href="#privacy" className="nav-link">
            PRIVACY
          </a>
          <div
            style={{
              font: "7px 'Press Start 2P', monospace",
              color: "#3dd68c",
              border: "2px solid #3dd68c",
              padding: "5px 10px",
              background: "#3dd68c10",
            }}
          >
            🔒 PRIVATE CLOUD
          </div>
        </div>
      </div>
    </nav>
  )
}

function Hero() {
  const scrollToWorkspace = () =>
    document.getElementById("workspace")?.scrollIntoView({ behavior: "smooth" })
  return (
    <section
      style={{
        background: "#0a1e35",
        borderBottom: "4px solid #1a4a8a",
        padding: "64px 24px",
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div className="pixel-grid" />
      <div className="scanner" />
      <div style={{ position: "relative", maxWidth: 800, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 20,
            marginBottom: 28,
          }}
        >
          <FilmReel size={52} />
          <FilmReel size={52} />
          <FilmReel size={52} />
        </div>
        <div
          style={{
            display: "inline-block",
            background: "#0d1b2a",
            border: "4px solid #ff6b1a",
            boxShadow:
              "inset -3px -3px #8b3000, inset 3px 3px #ffaa70, 0 0 40px rgba(255,107,26,.2)",
            padding: "16px 32px",
            marginBottom: 24,
          }}
        >
          <div
            style={{
              font: "26px/1.4 'Press Start 2P', monospace",
              color: "#f0e6cc",
              textShadow: "3px 3px #0a2d60",
            }}
          >
            FIRSTFRAME
          </div>
          <div
            style={{
              font: "11px 'Press Start 2P', monospace",
              color: "#ff6b1a",
              marginTop: 6,
            }}
          >
            // FRAME LAB
          </div>
        </div>
        <p
          style={{
            font: "14px/1.8 'JetBrains Mono', monospace",
            color: "#c8b89a",
            maxWidth: 600,
            margin: "0 auto 32px",
          }}
        >
          Upload up to <span style={{ color: "#ff6b1a" }}>10 videos</span> and
          receive the actual first decoded frame from each as a{" "}
          <span style={{ color: "#3dd68c" }}>high-quality PNG</span>. No account
          required.
        </p>
        <PixelBtn onClick={scrollToWorkspace}>⬇ GET STARTED FREE</PixelBtn>
        <div
          style={{
            display: "flex",
            gap: 20,
            justifyContent: "center",
            marginTop: 40,
            flexWrap: "wrap",
          }}
        >
          {[
            ["10", "MAX VIDEOS"],
            ["24H", "AUTO DELETE"],
            ["1×", "SAFE QUEUE"],
            ["PNG", "OUTPUT FORMAT"],
          ].map(([value, label]) => (
            <div
              key={label}
              style={{
                border: "2px solid #1a4a8a",
                padding: "12px 20px",
                background: "#0d1b2a",
              }}
            >
              <div
                style={{
                  font: "18px 'Press Start 2P', monospace",
                  color: "#ff6b1a",
                  marginBottom: 6,
                }}
              >
                {value}
              </div>
              <div
                style={{
                  font: "7px 'Press Start 2P', monospace",
                  color: "#2a7fc1",
                }}
              >
                {label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Workspace({
  jobs,
  uploadProgress,
  localErrors,
  notice,
  busy,
  onFiles,
  onRemove,
  onClear,
  onSaveAll,
}: {
  jobs: ClientFrameJob[]
  uploadProgress: Record<string, number>
  localErrors: Record<string, string>
  notice: string
  busy: boolean
  onFiles: (files: FileList) => void
  onRemove: (id: string) => void
  onClear: () => void
  onSaveAll: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const ready = jobs.filter((job) => job.status === "ready").length
  return (
    <section
      id="workspace"
      style={{ maxWidth: 1280, margin: "0 auto", padding: "40px 24px" }}
    >
      <div className="section-label">
        ▼ WORKSPACE
        <div />
      </div>
      <div
        style={{
          border: "8px solid #1a4a8a",
          boxShadow: "inset 0 0 0 2px #2d6bbf, 0 0 60px rgba(26,74,138,.4)",
          background: "#0d1b2a",
        }}
      >
        <div
          style={{
            background: "#1a4a8a",
            borderBottom: "4px solid #2d6bbf",
            padding: "10px 20px",
            display: "flex",
            justifyContent: "space-between",
            gap: 15,
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            {["#e84855", "#ff6b1a", "#3dd68c"].map((color) => (
              <span
                key={color}
                style={{
                  width: 12,
                  height: 12,
                  background: color,
                  border: "2px solid rgba(0,0,0,.3)",
                }}
              />
            ))}
          </div>
          <div style={{ font: "9px 'Press Start 2P', monospace" }}>
            FIRSTFRAME.APP — CAPTURE BAY
          </div>
          <div
            style={{
              font: "9px 'JetBrains Mono', monospace",
              color: "#2a7fc1",
            }}
          >
            v2.0.0
          </div>
        </div>
        <div className="workspace-body">
          <div className="toolbar">
            <span>⬆</span>
            <span>🎞</span>
            <span>⚙</span>
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="ruler" />
            <div
              className="drop-shell"
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = "copy"
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (event.dataTransfer.files.length)
                  onFiles(event.dataTransfer.files)
              }}
            >
              <div className="pixel-grid" />
              <div className="drop-box">
                {(["tl", "tr", "bl", "br"] as const).map((position) => (
                  <CornerBracket key={position} position={position} />
                ))}
                <FilmReel size={48} />
                <div
                  style={{
                    font: "11px/1.8 'Press Start 2P', monospace",
                    textAlign: "center",
                  }}
                >
                  DROP UP TO 10 VIDEOS HERE
                </div>
                <div
                  style={{
                    font: "10px 'JetBrains Mono', monospace",
                    color: "#2a7fc1",
                  }}
                >
                  MP4 · MOV · M4V · WEBM
                </div>
                <input
                  ref={input}
                  type="file"
                  accept=".mp4,.mov,.m4v,.webm,video/mp4,video/quicktime,video/x-m4v,video/webm"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.target.files?.length) onFiles(event.target.files)
                    event.currentTarget.value = ""
                  }}
                />
                <PixelBtn
                  onClick={() => input.current?.click()}
                  disabled={busy || jobs.length >= MAX_VIDEOS}
                >
                  {busy ? "PROCESSING…" : "⬆ CHOOSE VIDEOS"}
                </PixelBtn>
                <div
                  style={{
                    font: "9px/1.5 'JetBrains Mono', monospace",
                    color: "#3dd68c",
                    textAlign: "center",
                  }}
                >
                  Videos are processed on your device whenever possible.
                </div>
              </div>
              <div className="slots">SLOTS: {jobs.length} / 10 USED</div>
            </div>
          </div>
          <aside className="queue">
            <div className="queue-head">
              <div
                style={{
                  font: "9px 'Press Start 2P', monospace",
                  marginBottom: 6,
                }}
              >
                CLIP QUEUE
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span
                  style={{
                    font: "14px 'Press Start 2P', monospace",
                    color: "#ff6b1a",
                  }}
                >
                  {String(jobs.length).padStart(2, "0")} / 10
                </span>
                <span
                  style={{
                    font: "9px 'JetBrains Mono', monospace",
                    color: "#3dd68c",
                  }}
                >
                  {ready} ready
                </span>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: "10px 12px",
                overflowY: "auto",
                maxHeight: 390,
              }}
            >
              {jobs.map((job) => (
                <ClipRow
                  key={job.id}
                  job={job}
                  uploadProgress={uploadProgress[job.id]}
                  localError={localErrors[job.id]}
                  onRemove={() => onRemove(job.id)}
                />
              ))}
              {jobs.length === 0 && (
                <div className="empty">
                  QUEUE EMPTY
                  <br />
                  <br />
                  Your videos will appear here.
                </div>
              )}
            </div>
            <div
              style={{
                padding: 10,
                borderTop: "2px solid #1a3a5c",
                display: "grid",
                gap: 8,
              }}
            >
              <PixelBtn
                variant="cobalt"
                small
                onClick={() => input.current?.click()}
                disabled={busy || jobs.length >= MAX_VIDEOS}
              >
                + ADD MORE
              </PixelBtn>
              {jobs.length > 0 && (
                <PixelBtn variant="ghost" small onClick={onClear}>
                  CLEAR ALL
                </PixelBtn>
              )}
            </div>
          </aside>
        </div>
        {notice && (
          <div
            role="status"
            style={{
              background: "#2a7fc118",
              borderTop: "2px solid #2a7fc1",
              padding: "9px 16px",
              color: "#c8b89a",
              font: "10px/1.5 'JetBrains Mono', monospace",
            }}
          >
            {notice}
          </div>
        )}
        <div className="status-bar">
          <div
            style={{
              font: "8px 'Press Start 2P', monospace",
              color: ready ? "#3dd68c" : "#2a7fc1",
              border: `2px solid ${ready ? "#3dd68c" : "#2a7fc1"}`,
              padding: "5px 10px",
            }}
          >
            ● {ready} FRAMES READY
          </div>
          <div
            style={{
              flex: 1,
              font: "10px 'JetBrains Mono', monospace",
              color: "#c8b89a",
            }}
          >
            LOCAL WHEN POSSIBLE · FALLBACK SOURCES DELETED AFTER PROCESSING
          </div>
          <div
            style={{
              font: "6px/1.7 'Press Start 2P', monospace",
              color: "#2a7fc1",
              border: "2px solid #2a7fc140",
              padding: "4px 8px",
              textAlign: "center",
            }}
          >
            🔒 PRIVATE · AUTO-DELETED IN 24H
          </div>
          <PixelBtn onClick={onSaveAll} disabled={!ready}>
            💾 SAVE ALL PNGs
          </PixelBtn>
        </div>
      </div>
    </section>
  )
}

function ExtractedFrames({
  jobs,
  onSave,
}: {
  jobs: ClientFrameJob[]
  onSave: (job: ClientFrameJob) => void
}) {
  const ready = jobs.filter((job) => job.status === "ready")
  return (
    <section
      style={{ maxWidth: 1280, margin: "0 auto", padding: "0 24px 60px" }}
    >
      <div className="section-label">
        ▼ EXTRACTED FRAMES <span>— {ready.length} frames captured</span>
        <div />
      </div>
      {ready.length ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 16,
          }}
        >
          {ready.map((job) => (
            <FramePreviewCard
              key={job.id}
              job={job}
              onSave={() => onSave(job)}
            />
          ))}
        </div>
      ) : (
        <div
          style={{
            border: "3px dashed #1a4a8a",
            padding: "36px",
            textAlign: "center",
            color: "#2a7fc1",
            font: "9px/1.8 'Press Start 2P', monospace",
          }}
        >
          READY FRAMES WILL APPEAR HERE
        </div>
      )}
    </section>
  )
}

function HowItWorks() {
  const steps = [
    {
      num: "01",
      title: "UPLOAD",
      desc: "Choose up to 10 MP4, MOV, M4V, or WebM files. FirstFrame tries private on-device extraction first.",
    },
    {
      num: "02",
      title: "EXTRACT",
      desc: "Compatible videos stay on your device. Only videos your browser cannot decode use the private FFmpeg fallback.",
    },
    {
      num: "03",
      title: "SAVE PNG",
      desc: "Preview and securely download each PNG, or package every ready frame into one ZIP.",
    },
  ]
  return (
    <section
      id="how"
      style={{
        background: "#0a1e35",
        borderBlock: "4px solid #1a4a8a",
        padding: "60px 24px",
        position: "relative",
      }}
    >
      <div className="pixel-grid" />
      <div style={{ maxWidth: 1280, margin: "0 auto", position: "relative" }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div
            style={{
              font: "14px 'Press Start 2P', monospace",
              marginBottom: 12,
            }}
          >
            HOW IT WORKS
          </div>
          <div
            style={{
              font: "12px 'JetBrains Mono', monospace",
              color: "#2a7fc1",
            }}
          >
            Three steps. No account. Real FFmpeg processing.
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 24,
          }}
        >
          {steps.map((step) => (
            <div
              key={step.num}
              style={{
                background: "#0d1b2a",
                border: "3px solid #1a4a8a",
                padding: "28px 24px",
                position: "relative",
              }}
            >
              <div
                style={{
                  font: "32px 'Press Start 2P', monospace",
                  color: "#ff6b1a18",
                  position: "absolute",
                  top: 12,
                  right: 16,
                }}
              >
                {step.num}
              </div>
              <div
                style={{
                  font: "10px 'Press Start 2P', monospace",
                  color: "#ff6b1a",
                  marginBottom: 16,
                }}
              >
                {step.num} — {step.title}
              </div>
              <div
                style={{ font: "13px/1.7 Inter, sans-serif", color: "#c8b89a" }}
              >
                {step.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function PrivacyBanner() {
  return (
    <section
      id="privacy"
      style={{ maxWidth: 1280, margin: "0 auto", padding: "60px 24px" }}
    >
      <div
        style={{
          background: "#0a1e35",
          border: "4px solid #2a7fc1",
          padding: "40px 48px",
          display: "flex",
          alignItems: "center",
          gap: 40,
          flexWrap: "wrap",
          position: "relative",
        }}
      >
        {(["tl", "tr", "bl", "br"] as const).map((position) => (
          <CornerBracket key={position} position={position} />
        ))}
        <div style={{ fontSize: 48 }}>🔒</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div
            style={{
              font: "11px 'Press Start 2P', monospace",
              color: "#3dd68c",
              marginBottom: 12,
            }}
          >
            PRIVATE & TEMPORARY
          </div>
          <div style={{ font: "14px/1.8 Inter, sans-serif", color: "#c8b89a" }}>
            Videos are processed on your device whenever possible. Compatibility
            fallbacks use short-lived signed uploads to private storage; source
            files are deleted immediately after extraction and temporary PNGs
            expire automatically.
          </div>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {[
            "Private buckets",
            "No account",
            "Short-lived links",
            "24-hour cleanup",
          ].map((item) => (
            <div
              key={item}
              style={{
                font: "11px 'JetBrains Mono', monospace",
                color: "#c8b89a",
              }}
            >
              <span style={{ color: "#3dd68c" }}>✓</span> {item}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer
      style={{
        background: "#0a1228",
        borderTop: "4px solid #1a4a8a",
        padding: "32px 24px",
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <FilmReel size={28} />
          <strong style={{ font: "10px 'Press Start 2P', monospace" }}>
            FIRSTFRAME
          </strong>
        </div>
        <div
          style={{ font: "10px 'JetBrains Mono', monospace", color: "#2a7fc1" }}
        >
          Real first frames. Private temporary processing.
        </div>
        <div
          style={{
            font: "7px 'Press Start 2P', monospace",
            color: "#c8b89a",
            opacity: 0.5,
          }}
        >
          v2.0.0 © 2026
        </div>
      </div>
    </footer>
  )
}

type FallbackCandidate = { file: File placeholderId: string }

function acceptedVideo(file: File): boolean {
  const dot = file.name.lastIndexOf(".")
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : ""
  const accepted = ACCEPTED_TYPES[extension]
  return Boolean(
    accepted && (!file.type || accepted.includes(file.type.toLowerCase())),
  )
}

function fallbackMimeType(file: File): string {
  const dot = file.name.lastIndexOf(".")
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : ""
  return (
    file.type || ACCEPTED_TYPES[extension]?.[0] || "application/octet-stream"
  )
}

export default function App() {
  const [batchId, setBatchId] = useState<string | null>(() =>
    SERVER_FALLBACK_ENABLED ? sessionStorage.getItem("firstframe_batch") : null,
  )
  const batchIdRef = useRef(batchId)
  const [jobs, setJobs] = useState<ClientFrameJob[]>([])
  const jobsRef = useRef<ClientFrameJob[]>([])
  const localControllers = useRef(new Map<string, AbortController>())
  const localPreviewUrls = useRef(new Map<string, string>())
  const pollStartedAt = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(
    "Videos are processed on your device whenever possible.",
  )
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
    {},
  )
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({})

  const updateJobs = useCallback(
    (updater: (current: ClientFrameJob[]) => ClientFrameJob[]) => {
      setJobs((current) => {
        const next = updater(current)
        jobsRef.current = next
        return next
      })
    },
    [],
  )

  const refresh = useCallback(
    async (id: string) => {
      try {
        const batch = await firstFrameApi.getBatch(id)
        updateJobs((current) =>
          mergeServerJobs(current, batch.jobs, firstFrameApi.outputContentUrl),
        )
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "This fallback batch is no longer available.",
        )
        sessionStorage.removeItem("firstframe_batch")
        batchIdRef.current = null
        setBatchId(null)
        updateJobs((current) =>
          current.filter((job) => job.processingMode === "local"),
        )
      }
    },
    [updateJobs],
  )

  useEffect(() => {
    if (batchId) void refresh(batchId)
  }, [batchId, refresh])

  const hasActiveFallback = jobs.some(
    (job) =>
      job.processingMode === "server" &&
      job.batch_id !== "local" &&
      ACTIVE_STATUSES.includes(job.status),
  )
  useEffect(() => {
    if (!batchId || !hasActiveFallback) {
      pollStartedAt.current = null
      return
    }
    pollStartedAt.current ??= Date.now()
    let cancelled = false
    let timer = 0
    const poll = async () => {
      await refresh(batchId)
      if (cancelled) return
      const elapsed = Date.now() - (pollStartedAt.current ?? Date.now())
      const delay = elapsed < 10_000 ? 1_500 : elapsed < 30_000 ? 3_000 : 5_000
      timer = window.setTimeout(poll, delay)
    }
    timer = window.setTimeout(poll, 1_500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [batchId, hasActiveFallback, refresh])

  useEffect(
    () => () => {
      for (const controller of localControllers.current.values())
        controller.abort()
      for (const url of localPreviewUrls.current.values())
        URL.revokeObjectURL(url)
    },
    [],
  )

  const ensureBatch = async () => {
    if (batchIdRef.current) return batchIdRef.current
    const batch = await firstFrameApi.createBatch()
    batchIdRef.current = batch.id
    setBatchId(batch.id)
    sessionStorage.setItem("firstframe_batch", batch.id)
    return batch.id
  }

  const failPlaceholders = (
    candidates: readonly FallbackCandidate[],
    message: string,
  ) => {
    const ids = new Set(candidates.map((item) => item.placeholderId))
    updateJobs((current) =>
      current.map((job) =>
        ids.has(job.id)
          ? {
              ...job,
              status: "failed",
              progress: 0,
              error_message: message,
              completed_at: new Date().toISOString(),
            }
          : job,
      ),
    )
  }

  const uploadFallbacks = async (
    fallbackCandidates: readonly FallbackCandidate[],
    captchaToken?: string,
  ) => {
    const oversized = fallbackCandidates.filter(
      (candidate) => candidate.file.size > MAX_FILE_SIZE,
    )
    if (oversized.length)
      failPlaceholders(
        oversized,
        "This video is too large for the compatibility fallback.",
      )
    const accepted = fallbackCandidates.filter(
      (candidate) => candidate.file.size <= MAX_FILE_SIZE,
    )
    if (!accepted.length) return
    const existingFallbackBytes = jobsRef.current
      .filter(
        (job) =>
          job.processingMode === "server" &&
          !accepted.some((candidate) => candidate.placeholderId === job.id),
      )
      .reduce((sum, job) => sum + job.source_size_bytes, 0)
    const newFallbackBytes = accepted.reduce(
      (sum, candidate) => sum + candidate.file.size,
      0,
    )
    if (existingFallbackBytes + newFallbackBytes > MAX_BATCH_SIZE) {
      failPlaceholders(
        accepted,
        "These compatibility fallbacks exceed the 1 GB batch upload limit.",
      )
      return
    }

    const id = await ensureBatch()
    const result = await firstFrameApi.createUploadUrls(
      id,
      accepted.map(({ file }) => ({
        name: file.name,
        size: file.size,
        type: fallbackMimeType(file),
      })),
      captchaToken,
    )
    const bindings = result.uploads.map((upload, index) => ({
      upload,
      file: accepted[index].file,
      placeholderId: accepted[index].placeholderId,
    }))
    const replacements = new Map(
      bindings.map(({ placeholderId, upload }) => [
        placeholderId,
        asServerJob(upload.job),
      ]),
    )
    updateJobs((current) =>
      current.map((job) => replacements.get(job.id) ?? job),
    )

    await processSequentially(
      bindings,
      async ({ upload, file }) => {
        await uploadToSignedUrl(
          upload.upload_url,
          file,
          (percent) =>
            setUploadProgress((current) => ({
              ...current,
              [upload.job.id]: percent,
            })),
          fallbackMimeType(file),
        )
        await firstFrameApi.completeUpload(id, upload.job.id)
      },
      async (result, { upload }) => {
        if (result.status === "fulfilled") return
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : "Upload failed."
        setLocalErrors((current) => ({
          ...current,
          [upload.job.id]: message,
        }))
        await firstFrameApi.cancelJob(upload.job.id).catch(() => undefined)
      },
    )
    await refresh(id)
  }

  const handleFiles = async (fileList: FileList) => {
    if (busy) return
    const candidates = Array.from(fileList)
    const remaining = MAX_VIDEOS - jobsRef.current.length
    if (remaining <= 0) {
      setNotice("This batch already contains 10 videos.")
      return
    }
    const invalid = candidates.find((file) => !acceptedVideo(file))
    if (invalid) {
      setNotice(
        `${invalid.name} is not a supported MP4, MOV, M4V, or WebM video.`,
      )
      return
    }
    const selected = candidates.slice(0, remaining)
    const skipped = candidates.length - selected.length
    const placeholders = selected.map((file, index) =>
      createLocalPlaceholder(file, jobsRef.current.length + index),
    )
    updateJobs((current) => [...current, ...placeholders])
    setBusy(true)
    const fallbacks: FallbackCandidate[] = []
    try {
      setNotice("Extracting first frames privately on your device…")
      await processSequentially(
        selected,
        async (file, index) => {
          const placeholder = placeholders[index]
          const controller = new AbortController()
          localControllers.current.set(placeholder.id, controller)
          return extractLocalFirstFrame(file, { signal: controller.signal })
        },
        (result, file, index) => {
          const placeholder = placeholders[index]
          localControllers.current.delete(placeholder.id)
          if (result.status === "fulfilled") {
            const previewUrl = URL.createObjectURL(result.value.png)
            localPreviewUrls.current.set(placeholder.id, previewUrl)
            updateJobs((current) =>
              current.map((job) =>
                job.id === placeholder.id
                  ? {
                      ...job,
                      status: "ready",
                      progress: 100,
                      width: result.value.width,
                      height: result.value.height,
                      output_size_bytes: result.value.png.size,
                      preview_url: previewUrl,
                      localOutput: result.value.png,
                      completed_at: new Date().toISOString(),
                    }
                  : job,
              ),
            )
            return
          }
          if (
            result.reason instanceof LocalExtractionError &&
            result.reason.code === "aborted"
          )
            return
          fallbacks.push({ file, placeholderId: placeholder.id })
          updateJobs((current) =>
            current.map((job) =>
              job.id === placeholder.id
                ? {
                    ...job,
                    processingMode: "server",
                    status: "uploading",
                    progress: 0,
                  }
                : job,
            ),
          )
        },
      )

      if (fallbacks.length) {
        if (!SERVER_FALLBACK_ENABLED) {
          const message =
            "This video cannot be decoded by this browser. The public version processes videos only on your device."
          failPlaceholders(fallbacks, message)
          setNotice(message)
        } else {
          setNotice(
            `${fallbacks.length} video${
              fallbacks.length === 1 ? " needs" : "s need"
            } the secure compatibility fallback…`,
          )
          await uploadFallbacks(fallbacks)
          setNotice(
            "Local frames are ready. Compatibility fallbacks are extracting one at a time.",
          )
        }
      } else {
        setNotice("Processed privately on your device. Nothing was uploaded.")
      }
      if (skipped)
        setNotice(
          `${skipped} video${
            skipped === 1 ? " was" : "s were"
          } skipped; each visible batch accepts 10.`,
        )
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Processing could not be started."
      if (
        error instanceof FirstFrameApiError &&
        error.code === "CAPTCHA_REQUIRED" &&
        fallbacks.length
      ) {
        try {
          const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim()
          if (!siteKey)
            throw new Error(
              "Fallback verification is required but is not configured.",
            )
          setNotice("Please complete verification to continue server fallback.")
          const { requestTurnstileToken } = await import("./lib/turnstile")
          const token = await requestTurnstileToken(siteKey)
          await uploadFallbacks(fallbacks, token)
          setNotice(
            "Verification complete. Compatibility fallbacks are extracting.",
          )
        } catch (challengeError) {
          const challengeMessage =
            challengeError instanceof Error
              ? challengeError.message
              : "Verification failed."
          setNotice(challengeMessage)
          failPlaceholders(fallbacks, challengeMessage)
        }
      } else {
        setNotice(message)
        failPlaceholders(fallbacks, message)
      }
    } finally {
      setBusy(false)
    }
  }

  const removeJob = async (jobId: string) => {
    const job = jobsRef.current.find((candidate) => candidate.id === jobId)
    if (!job) return
    try {
      localControllers.current.get(jobId)?.abort()
      localControllers.current.delete(jobId)
      const previewUrl = localPreviewUrls.current.get(jobId)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      localPreviewUrls.current.delete(jobId)
      if (job.processingMode === "server" && job.batch_id !== "local")
        await firstFrameApi.deleteJob(jobId)
      updateJobs((current) => current.filter((item) => item.id !== jobId))
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The video could not be removed.",
      )
    }
  }

  const clearAll = async () => {
    try {
      for (const controller of localControllers.current.values())
        controller.abort()
      if (batchId) await firstFrameApi.clearBatch(batchId)
      for (const url of localPreviewUrls.current.values())
        URL.revokeObjectURL(url)
      localControllers.current.clear()
      localPreviewUrls.current.clear()
      updateJobs(() => [])
      batchIdRef.current = null
      setBatchId(null)
      sessionStorage.removeItem("firstframe_batch")
      setNotice("The queue and all temporary results were cleared.")
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The batch could not be cleared.",
      )
    }
  }

  const saveOne = async (job: ClientFrameJob) => {
    try {
      if (job.processingMode === "local" && job.localOutput) {
        downloadBlob(job.localOutput, pngDownloadName(job.original_name))
        return
      }
      downloadFromApi(`/api/jobs/${job.id}/download`)
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The PNG could not be downloaded.",
      )
    }
  }

  const saveAll = async () => {
    const ready = jobsRef.current.filter((job) => job.status === "ready")
    if (!ready.length) return
    try {
      setNotice("Preparing the ZIP in your browser…")
      const { createStoredZip } = await import("./lib/zip")
      const entries = await collectReadyZipEntries(
        ready,
        firstFrameApi.fetchOutput,
      )
      const zip = await createStoredZip(entries)
      downloadBlob(zip, `firstframe-${batchId?.slice(0, 8) ?? "local"}.zip`)
      setNotice("ZIP created locally. No ZIP was uploaded or stored.")
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "The ZIP could not be created.",
      )
    }
  }

  return (
    <div
      style={{ background: "#0d1b2a", minHeight: "100vh", color: "#f0e6cc" }}
    >
      <NavBar />
      <Hero />
      <Workspace
        jobs={jobs}
        uploadProgress={uploadProgress}
        localErrors={localErrors}
        notice={notice}
        busy={busy}
        onFiles={handleFiles}
        onRemove={removeJob}
        onClear={clearAll}
        onSaveAll={saveAll}
      />
      <ExtractedFrames jobs={jobs} onSave={saveOne} />
      <HowItWorks />
      <PrivacyBanner />
      <Footer />
    </div>
  )
}
