import { spawn } from "node:child_process"
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg"
import ffprobeInstaller from "@ffprobe-installer/ffprobe"

export interface VideoMetadata {
  durationSeconds: number
  width: number
  height: number
  codec: string
}

interface ProcessResult {
  stdout: string
  stderr: string
}

export class MediaCommandError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message)
  }
}

export function runMediaCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString("utf8")).slice(-65_536)
    child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)))
    child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(
        new MediaCommandError(
          "Video processing exceeded the configured time limit.",
          stderr,
        ),
      )
    }, timeoutMs)
    timer.unref()
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else
        reject(
          new MediaCommandError(
            `Media command exited with code ${code ?? "unknown"}.`,
            stderr,
          ),
        )
    })
  })
}

export async function probeVideo(
  inputPath: string,
  timeoutMs: number,
): Promise<VideoMetadata> {
  const { stdout } = await runMediaCommand(
    ffprobeInstaller.path,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      inputPath,
    ],
    timeoutMs,
  )
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      duration?: string
    }>
    format?: { duration?: string }
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video")
  const duration = Number(video?.duration ?? parsed.format?.duration)
  const width = Number(video?.width)
  const height = Number(video?.height)
  const codec = video?.codec_name?.toLowerCase()
  if (
    !video ||
    !codec ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    throw new MediaCommandError(
      "The file does not contain a valid decodable video stream.",
      "",
    )
  }
  return { durationSeconds: duration, width, height, codec }
}

export async function extractFirstFrame(
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<void> {
  await runMediaCommand(
    ffmpegInstaller.path,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vsync",
      "0",
      "-compression_level",
      "3",
      "-y",
      outputPath,
    ],
    timeoutMs,
  )
}

export function ffmpegPath(): string {
  return ffmpegInstaller.path
}
