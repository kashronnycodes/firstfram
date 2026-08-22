export interface LocalFrameResult {
  png: Blob
  width: number
  height: number
}

export interface LocalFrameOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export class LocalExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: "aborted" | "decode_failed" | "no_frame" | "timeout",
  ) {
    super(message)
  }
}

function abortError(): LocalExtractionError {
  return new LocalExtractionError(
    "Local video processing was cancelled.",
    "aborted",
  )
}

async function waitForDecodedFrame(
  video: FrameCallbackVideo,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let frameHandle: number | undefined
    let loaded = video.readyState >= 2
    let framePresented = !video.requestVideoFrameCallback
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener("loadeddata", onLoaded)
      video.removeEventListener("error", onError)
      signal?.removeEventListener("abort", onAbort)
      if (!framePresented && frameHandle !== undefined)
        video.cancelVideoFrameCallback?.(frameHandle)
      error ? reject(error) : resolve()
    }
    const finishWhenReady = () => {
      if (loaded && framePresented) finish()
    }
    const onLoaded = () => {
      loaded = true
      finishWhenReady()
    }
    const onError = () =>
      finish(
        new LocalExtractionError(
          "This browser could not decode the video locally.",
          "decode_failed",
        ),
      )
    const onAbort = () => finish(abortError())
    const timer = setTimeout(
      () =>
        finish(
          new LocalExtractionError(
            "Local video decoding timed out.",
            "timeout",
          ),
        ),
      timeoutMs,
    )

    video.addEventListener("loadeddata", onLoaded, { once: true })
    video.addEventListener("error", onError, { once: true })
    signal?.addEventListener("abort", onAbort, { once: true })
    if (video.requestVideoFrameCallback)
      frameHandle = video.requestVideoFrameCallback(() => {
        framePresented = true
        finishWhenReady()
      })
    if (signal?.aborted) onAbort()
    else finishWhenReady()
  })
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else
        reject(
          new LocalExtractionError(
            "The browser decoded the video but could not create a PNG.",
            "no_frame",
          ),
        )
    }, "image/png")
  })
}

export async function extractLocalFirstFrame(
  file: File,
  options: LocalFrameOptions = {},
): Promise<LocalFrameResult> {
  const video = document.createElement("video") as FrameCallbackVideo
  const canvas = document.createElement("canvas")
  const sourceUrl = URL.createObjectURL(file)
  video.preload = "auto"
  video.muted = true
  video.playsInline = true
  video.crossOrigin = "anonymous"

  try {
    if (options.signal?.aborted) throw abortError()
    video.src = sourceUrl
    const decodedFrame = waitForDecodedFrame(
      video,
      options.signal,
      options.timeoutMs ?? 12_000,
    )
    video.load()
    await decodedFrame
    const width = video.videoWidth
    const height = video.videoHeight
    if (
      !Number.isInteger(width) ||
      width <= 0 ||
      !Number.isInteger(height) ||
      height <= 0
    ) {
      throw new LocalExtractionError(
        "No valid video frame appeared during local decoding.",
        "no_frame",
      )
    }
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d", { alpha: false })
    if (!context)
      throw new LocalExtractionError(
        "This browser could not create a frame canvas.",
        "no_frame",
      )
    context.drawImage(video, 0, 0, width, height)
    const png = await canvasPng(canvas)
    return { png, width, height }
  } catch (error) {
    if (error instanceof LocalExtractionError) throw error
    throw new LocalExtractionError(
      "This browser could not decode the video locally.",
      "decode_failed",
    )
  } finally {
    video.pause()
    video.removeAttribute("src")
    video.load()
    URL.revokeObjectURL(sourceUrl)
    canvas.width = 0
    canvas.height = 0
  }
}

export async function processSequentially<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  onSettled: (
    result: PromiseSettledResult<R>,
    item: T,
    index: number,
  ) => void | Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    let result: PromiseSettledResult<R>
    try {
      result = { status: "fulfilled", value: await worker(items[index], index) }
    } catch (reason) {
      result = { status: "rejected", reason }
    }
    await onSettled(result, items[index], index)
  }
}
