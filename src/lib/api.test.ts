import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadBlob, downloadFromApi } from "./api"

describe("browser downloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
})
