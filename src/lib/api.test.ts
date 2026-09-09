import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadBlob, downloadFromApi, uploadToSignedUrl } from "./api"

class FakeXmlHttpRequest {
  static instances: FakeXmlHttpRequest[] = []

  status = 0
  upload: {
    onprogress: ((event: ProgressEvent) => void) | null
  } = { onprogress: null }
  onerror: (() => void) | null = null
  onload: (() => void) | null = null
  open = vi.fn()
  setRequestHeader = vi.fn()
  send = vi.fn()

  constructor() {
    FakeXmlHttpRequest.instances.push(this)
  }
}

describe("browser downloads", () => {
  afterEach(() => {
    FakeXmlHttpRequest.instances = []
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("uses normal navigation instead of fetch for an individual PNG", () => {
    const path = "/api/jobs/00000000-0000-4000-8000-000000000001/download"
    const click = vi.fn()
    const remove = vi.fn()
    const appendChild = vi.fn()
    const link = { href: "", target: "", style: { display: "" }, click, remove }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("document", {
      createElement: vi.fn(() => link),
      body: { appendChild },
    })

    downloadFromApi(path)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(link.href).toBe(`http://localhost:8787${path}`)
    expect(link.target).toBe("_self")
    expect(appendChild).toHaveBeenCalledWith(link)
    expect(click).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
  })

  it("downloads an individual local PNG without an API call", () => {
    const click = vi.fn()
    const remove = vi.fn()
    const appendChild = vi.fn()
    const revokeObjectURL = vi.fn()
    const link = {
      href: "",
      download: "",
      style: { display: "" },
      click,
      remove,
    }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:local-png"),
      revokeObjectURL,
    })
    vi.stubGlobal("document", {
      createElement: vi.fn(() => link),
      body: { appendChild },
    })
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback()
        return 1
      },
    })

    downloadBlob(new Blob(["png"]), "clip-first-frame.png")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(link.href).toBe("blob:local-png")
    expect(link.download).toBe("clip-first-frame.png")
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-png")
  })

  it("blocks backend navigation in the browser-only public build", async () => {
    vi.stubEnv("VITE_SERVER_FALLBACK_ENABLED", "false")
    vi.resetModules()
    const { downloadFromApi: downloadWithoutBackend } = await import("./api")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    expect(() => downloadWithoutBackend("/api/jobs/example/download")).toThrow(
      "The public version processes videos only on your device.",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("signed fallback uploads", () => {
  afterEach(() => {
    FakeXmlHttpRequest.instances = []
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("reports a non-success storage response and preserves the fallback MIME type", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest)
    const progress = vi.fn()
    const file = new Blob(["mov"], { type: "video/quicktime" }) as File
    const pending = uploadToSignedUrl(
      "https://storage.test/signed-upload",
      file,
      progress,
      "video/quicktime",
    )
    const request = FakeXmlHttpRequest.instances[0]
    request.upload.onprogress?.({
      lengthComputable: true,
      loaded: 1,
      total: 2,
    } as ProgressEvent)
    request.status = 503
    const rejection = expect(pending).rejects.toThrow(
      "The direct video upload failed (503).",
    )
    request.onload?.()

    await rejection
    expect(request.open).toHaveBeenCalledWith(
      "PUT",
      "https://storage.test/signed-upload",
    )
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      "Content-Type",
      "video/quicktime",
    )
    expect(request.send).toHaveBeenCalledWith(file)
    expect(progress).toHaveBeenCalledWith(50)
  })

  it("reports an interrupted direct upload", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest)
    const pending = uploadToSignedUrl(
      "https://storage.test/signed-upload",
      new Blob(["video"], { type: "video/mp4" }) as File,
      vi.fn(),
    )
    const rejection = expect(pending).rejects.toThrow(
      "The direct video upload was interrupted.",
    )
    FakeXmlHttpRequest.instances[0].onerror?.()
    await rejection
  })
})
