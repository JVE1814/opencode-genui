import { describe, expect, test } from "bun:test"
import type { CanvasSnapshot } from "../../src/protocol/fold.ts"
import {
  EMPTY_PERSISTED,
  MAX_ENTRY_BYTES,
  MAX_SURFACE_ENTRIES,
  readCanvasSnapshots,
  readSurfaceOverrides,
  writeCanvasSnapshot,
  writeSurfaceOverrides,
  type PersistedSession,
} from "../../src/runtime/snapshot.ts"

const snapshot = (text = "hi", generation = 1): CanvasSnapshot => ({
  title: "Board",
  spec: { root: "main", elements: { main: { type: "Text", props: { text }, children: [] } }, state: { a: 1 } },
  after: { messageID: "msg_01", part: 0, ordinal: 2 },
  generation,
  first: { messageID: "msg_00", part: 1, ordinal: 0 },
})

describe("canvas snapshots", () => {
  test("round trip", () => {
    const written = writeCanvasSnapshot(undefined, "main", snapshot())
    expect(written.v).toBe(1)
    expect(typeof written.canvases.main).toBe("string")
    expect(readCanvasSnapshots(written)).toEqual({ main: snapshot() })
  })

  test("an unchanged entry reads back as the same object", () => {
    const first = writeCanvasSnapshot(undefined, "main", snapshot())
    const second = writeSurfaceOverrides(writeCanvasSnapshot(first, "other", snapshot("o")), "s", [["/a", 1]], 1)
    expect(readCanvasSnapshots(second).main).toBe(readCanvasSnapshots(first).main!)
    const changed = writeCanvasSnapshot(second, "main", snapshot("new"))
    expect(readCanvasSnapshots(changed).main).not.toBe(readCanvasSnapshots(first).main!)
  })

  test("returns the input itself when nothing changes", () => {
    const written = writeCanvasSnapshot(EMPTY_PERSISTED, "main", snapshot())
    expect(writeCanvasSnapshot(written, "main", snapshot())).toBe(written)
    expect(writeCanvasSnapshot(written, "other", undefined)).toBe(written)
    expect(writeCanvasSnapshot(undefined, "other", undefined)).toBe(EMPTY_PERSISTED)
  })

  test("never mutates its input", () => {
    const written = writeCanvasSnapshot(undefined, "main", snapshot())
    const frozen = JSON.parse(JSON.stringify(written)) as PersistedSession
    writeCanvasSnapshot(written, "main", snapshot("changed"))
    writeCanvasSnapshot(written, "main", undefined)
    expect(written).toEqual(frozen)
    expect(EMPTY_PERSISTED).toEqual({ v: 1, canvases: {}, surfaces: {} })
  })

  test("undefined deletes", () => {
    const written = writeCanvasSnapshot(writeCanvasSnapshot(undefined, "a", snapshot()), "b", snapshot())
    const deleted = writeCanvasSnapshot(written, "a", undefined)
    expect(Object.keys(deleted.canvases)).toEqual(["b"])
  })

  test("keeps the old snapshot when the new one is too big", () => {
    const written = writeCanvasSnapshot(undefined, "main", snapshot())
    const huge = snapshot("x".repeat(MAX_ENTRY_BYTES))
    expect(writeCanvasSnapshot(written, "main", huge)).toBe(written)
    // Multi-byte characters count by their UTF-8 size.
    const wide = snapshot("é".repeat(MAX_ENTRY_BYTES / 2))
    expect(writeCanvasSnapshot(written, "main", wide)).toBe(written)
  })

  test("drops invalid entries and tolerates malformed values", () => {
    const valid = JSON.stringify(snapshot())
    const p = {
      v: 1,
      canvases: {
        ok: valid,
        broken: "{not json",
        number: 5,
        nospec: JSON.stringify({ ...snapshot(), spec: { root: 1, elements: {} } }),
        badref: JSON.stringify({ ...snapshot(), after: { messageID: "m", part: -1, ordinal: 0 } }),
        badgen: JSON.stringify({ ...snapshot(), generation: 1.5 }),
        badtitle: JSON.stringify({ ...snapshot(), title: 3 }),
        badfirst: JSON.stringify({ ...snapshot(), first: "x" }),
      },
      surfaces: {},
    } as unknown as PersistedSession
    const read = readCanvasSnapshots(p)
    expect(Object.keys(read).sort()).toEqual(["badfirst", "ok"])
    expect(read.badfirst!.first).toBeUndefined()
    expect(readCanvasSnapshots(undefined)).toEqual({})
    expect(readCanvasSnapshots({ v: 1, canvases: null, surfaces: null } as unknown as PersistedSession)).toEqual({})
  })

  test("any canvas id is a safe key", () => {
    let p = writeCanvasSnapshot(undefined, "__proto__", snapshot())
    p = writeCanvasSnapshot(p, "constructor", snapshot("c"))
    expect(Object.keys(p.canvases).sort()).toEqual(["__proto__", "constructor"])
    const read = readCanvasSnapshots(JSON.parse(JSON.stringify(p)) as PersistedSession)
    expect(Object.keys(read).sort()).toEqual(["__proto__", "constructor"])
    expect(read.__proto__?.generation).toBe(1)
    expect(readCanvasSnapshots(undefined).constructor).toBeUndefined()
    expect(({} as Record<string, unknown>).generation).toBeUndefined()
  })
})

describe("surface overrides", () => {
  test("round trip", () => {
    const entries: Array<[string, unknown]> = [
      ["/a", 1],
      ["/form", { name: "x" }],
    ]
    const p = writeSurfaceOverrides(undefined, "inline/abc", entries, 1000)
    expect(JSON.parse(p.surfaces["inline/abc"]!)).toEqual({ t: 1000, o: entries })
    expect(readSurfaceOverrides(p, "inline/abc")).toEqual(entries)
    expect(readSurfaceOverrides(p, "missing")).toEqual([])
    expect(readSurfaceOverrides(undefined, "x")).toEqual([])
  })

  test("equal edits change nothing, even at a later time", () => {
    const p = writeSurfaceOverrides(undefined, "s", [["/a", 1]], 1000)
    expect(writeSurfaceOverrides(p, "s", [["/a", 1]], 2000)).toBe(p)
    const changed = writeSurfaceOverrides(p, "s", [["/a", 2]], 2000)
    expect(JSON.parse(changed.surfaces.s!).t).toBe(2000)
  })

  test("no edits deletes the entry", () => {
    const p = writeSurfaceOverrides(undefined, "s", [["/a", 1]], 1000)
    expect(writeSurfaceOverrides(p, "s", [], 2000).surfaces).toEqual({})
    expect(writeSurfaceOverrides(p, "other", [], 2000)).toBe(p)
  })

  test("keeps the most recently saved surfaces", () => {
    let p: PersistedSession | undefined
    for (let index = 0; index < MAX_SURFACE_ENTRIES + 5; index++)
      p = writeSurfaceOverrides(p, `s${index}`, [["/a", index]], index)
    const ids = Object.keys(p!.surfaces)
    expect(ids).toHaveLength(MAX_SURFACE_ENTRIES)
    expect(ids).not.toContain("s0")
    expect(ids).not.toContain("s4")
    expect(ids).toContain("s5")
    expect(ids).toContain(`s${MAX_SURFACE_ENTRIES + 4}`)
  })

  test("the surface being written survives pruning even with a skewed clock", () => {
    let p: PersistedSession | undefined
    for (let index = 0; index < MAX_SURFACE_ENTRIES; index++)
      p = writeSurfaceOverrides(p, `s${index}`, [["/a", 1]], 10_000 + index)
    p = writeSurfaceOverrides(p, "late", [["/a", 1]], 0)
    expect(Object.keys(p.surfaces)).toContain("late")
    expect(Object.keys(p.surfaces)).toHaveLength(MAX_SURFACE_ENTRIES)
  })

  test("drops malformed stored entries on read", () => {
    const p = {
      v: 1,
      canvases: {},
      surfaces: { s: JSON.stringify({ t: 1, o: [["/a", 1], ["/b"], [3, 4], "x", ["/c", null]] }), bad: "{" },
    } as PersistedSession
    expect(readSurfaceOverrides(p, "s")).toEqual([
      ["/a", 1],
      ["/c", null],
    ])
    expect(readSurfaceOverrides(p, "bad")).toEqual([])
  })

  test("keeps canvases when writing surfaces and the reverse", () => {
    const p = writeCanvasSnapshot(writeSurfaceOverrides(undefined, "s", [["/a", 1]], 1), "main", snapshot())
    expect(Object.keys(p.surfaces)).toEqual(["s"])
    expect(Object.keys(p.canvases)).toEqual(["main"])
  })
})
