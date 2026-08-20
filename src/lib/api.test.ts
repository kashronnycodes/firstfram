import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadFromApi } from "./api"

describe("browser downloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    "/api/jobs/00000000-0000-4000-8000-000000000001/download",
    "/api/batches/00000000-0000-4000-8000-000000000002/download-all",
  ])("uses normal navigation instead of fetch for %s", (path) => {
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
})
