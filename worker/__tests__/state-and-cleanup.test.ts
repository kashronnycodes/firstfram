import { describe, expect, it } from "vitest"
import { expiredBatchIds } from "../retention.js"
import { assertTransition, canTransition } from "../state.js"

describe("job state transitions", () => {
  it("allows the worker path and rejects terminal-state rewinds", () => {
    expect(canTransition("uploading", "queued")).toBe(true)
    expect(canTransition("queued", "processing")).toBe(true)
    expect(canTransition("processing", "ready")).toBe(true)
    expect(() => assertTransition("ready", "processing")).toThrow(
      "Invalid frame job transition",
    )
  })
})

describe("retention cleanup", () => {
  it("selects only batches whose retention deadline has passed", () => {
    const now = Date.parse("2026-08-19T12:00:00Z")
    expect(
      expiredBatchIds(
        [
          { id: "old", expires_at: "2026-08-19T11:59:59Z" },
          { id: "live", expires_at: "2026-08-19T12:00:01Z" },
        ],
        now,
      ),
    ).toEqual(["old"])
  })
})
