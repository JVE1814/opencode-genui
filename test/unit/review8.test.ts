import { afterEach, describe, expect, test } from "bun:test"
import { createDirectiveRegistry, resolvePropValue, runValidation } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import {
  CELLS_PER_UNIT,
  domUnits,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  tableRows,
  tableWidth,
} from "../../src/gui/costs.ts"
import { MAX_PARSED_TEXT, numberOf, primitiveOf } from "../../src/gui/directives.ts"
import { elementUnits, guardDirectives, RENDER_UNITS, TEXT_PER_UNIT, unitsOf } from "../../src/gui/element.ts"
import { modalRefusal, noteModal, noteModalShown } from "../../src/gui/outward.ts"
import { createTrackedStore, groupEditsBy, MAX_STORED_SIZE } from "../../src/runtime/state.ts"
import { joinInlinePool, POOL_SURFACES, windowPool } from "../../src/runtime/budget.ts"
import { MAX_ENTRY_BYTES, readSurfaceOverrides, utf8Length, writeSurfaceOverrides } from "../../src/runtime/snapshot.ts"

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const warn = console.warn
afterEach(() => {
  console.warn = warn
})
const quiet = () => {
  console.warn = () => {}
}

// Regression tests for the eighth review's findings ([review8#<id>]): work a spec can give the window that the earlier
// bounds did not count.

describe("a component's DOM counts in its units [review8#R6S2-2]", () => {
  const digits = (count: number) => Array.from({ length: count }, (_, index) => String(index % 10))

  test("a Table is charged for its rows × columns cells, not only for its props' size", () => {
    // 500 empty rows and 1,000 one-character columns: 5.8 KB of spec that drew 500,000 cells for about 11 units.
    const props = { columns: digits(1000), rows: Array.from({ length: 500 }, () => []) }
    expect(unitsOf(props)).toBeLessThan(15)
    const cells = tableRows(500, tableWidth(props.columns, props.rows)) * MAX_TABLE_COLUMNS
    expect(cells).toBeLessThanOrEqual(MAX_TABLE_CELLS)
    expect(elementUnits({ type: "Table", props })).toBeGreaterThanOrEqual(cells / CELLS_PER_UNIT)
    // So two such tables never fit in one surface's budget, and the pool of tool output holds two at most.
    expect(2 * elementUnits({ type: "Table", props })).toBeGreaterThan(RENDER_UNITS)
  })

  test("a Table shows at most MAX_TABLE_COLUMNS columns and MAX_TABLE_CELLS cells, a narrow one its first 500 rows", () => {
    expect(tableWidth(digits(1000), [])).toBe(MAX_TABLE_COLUMNS)
    expect(tableWidth(["a", { key: "b" }, { label: "c" }, { align: "end" }, null], [])).toBe(3)
    expect(tableWidth([], [{ a: 1, b: 2 }, { c: 3 }])).toBe(3)
    expect(tableWidth(undefined, [[1, 2, 3, 4]])).toBe(4)
    expect(tableWidth([], [Object.fromEntries(digits(300).map((_, index) => [`k${index}`, index]))])).toBe(
      MAX_TABLE_COLUMNS,
    )
    expect(tableRows(7000, 4)).toBe(MAX_TABLE_ROWS)
    expect(tableRows(7000, 50)).toBe(MAX_TABLE_CELLS / 50)
    expect(tableRows(3, 50)).toBe(3)
  })

  test("an ordinary table costs a few units, and other components nothing extra", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ name: `svc-${index}`, status: "ok", latency: index }))
    expect(domUnits("Table", { columns: ["name", "status", "latency"], rows })).toBe(6)
    expect(domUnits("Text", { text: "hello" })).toBe(0)
    expect(domUnits("Table", undefined)).toBe(0)
  })

  test("a Chart is charged for its labels × series points", () => {
    // 500 labels and six empty series drew 3,000 points (and 3,000 cells of its screen-reader table) for 3 units.
    const props = { labels: digits(500), series: Array.from({ length: 6 }, () => ({ values: [] })) }
    expect(unitsOf(props)).toBeLessThan(10)
    expect(domUnits("Chart", props)).toBe((2 * 500 * 6) / CELLS_PER_UNIT)
    expect(domUnits("Chart", { series: [{ values: [1, 2, 3] }] })).toBe(1)
  })

  test("an object's keys count in its size, as a cell or a Text shows the object as JSON with its keys", () => {
    // One key of a million characters cost nothing before, and 2,000 Texts showing it built 2 GB of text.
    const big = { ["k".repeat(1_000_000)]: 1 }
    expect(unitsOf({ text: big })).toBeGreaterThan(RENDER_UNITS)
    expect(unitsOf({ text: { ["k".repeat(TEXT_PER_UNIT * 4)]: 1 } })).toBe(5)
  })
})

describe("what one expression node costs is bounded [review8#R6S2-3]", () => {
  const directives = createDirectiveRegistry(guardDirectives(standardDirectives))
  const ctx = (stateModel: Record<string, unknown>) => ({ stateModel, directives })
  const digits = "1".repeat(1_000_000)

  test("a number or a date is read from at most MAX_PARSED_TEXT characters", () => {
    const started = performance.now()
    for (let index = 0; index < 1000; index++) {
      expect(numberOf(digits)).toBeNaN()
      expect(numberOf([digits])).toBeNaN()
      expect(primitiveOf(digits)).toBeNaN()
    }
    // Number() of a million digits takes milliseconds; a thousand of them took seconds.
    expect(performance.now() - started).toBeLessThan(100)
    expect(numberOf(" 12.5 ")).toBe(12.5)
    expect(numberOf("1".repeat(MAX_PARSED_TEXT))).toBe(Number("1".repeat(MAX_PARSED_TEXT)))
    expect(numberOf("1".repeat(MAX_PARSED_TEXT + 1))).toBeNaN()
    expect(primitiveOf("2024-05-01")).toBe("2024-05-01")
    expect(primitiveOf(["2024-05-01"])).toBe("2024-05-01")
  })

  test("a tree of copies that reads one long text a thousand times evaluates in milliseconds", async () => {
    // The shape of a 14 KB block: `copy` doubles a subtree, so 2^K leaves of {$math: abs, a: {$state: /big}}, each of
    // which parsed the million digits of /big (2.5 ms): 2.6 s here for 2^10, 42 s per key press for 2^14.
    quiet()
    await nextTask()
    let tree: unknown = { $math: "abs", a: { $state: "/big" } }
    for (let level = 0; level < 10; level++) tree = { $math: "add", a: tree, b: tree }
    const started = performance.now()
    expect(resolvePropValue(tree, ctx({ big: digits }))).toBe(0)
    expect(performance.now() - started).toBeLessThan(300)
    // So do $pluralize and $format.
    await nextTask()
    const formats = Array.from({ length: 1000 }, (_, index) =>
      index % 2
        ? { $pluralize: { $state: "/big" }, one: "x", other: "y" }
        : { $format: "number", value: { $state: "/big" } },
    )
    const again = performance.now()
    expect(resolvePropValue({ $concat: formats }, ctx({ big: digits }))).toContain("NaN")
    expect(performance.now() - again).toBeLessThan(300)
  })

  test("validation checks parse bounded text and give the same answers on ordinary values", async () => {
    // 1,024 `lessThan` checks against a million digits on one field: 2.6 s per click.
    await nextTask()
    const checks = Array.from({ length: 1024 }, () => ({
      type: "lessThan",
      message: "Too many",
      args: { other: { $state: "/big" } },
    }))
    const started = performance.now()
    const result = runValidation({ checks }, { value: 3, stateModel: { big: digits } } as never)
    expect(performance.now() - started).toBeLessThan(300)
    expect(result.valid).toBe(false)
    const check = (type: string, value: unknown, args?: Record<string, unknown>) =>
      runValidation({ checks: [{ type, message: "no", ...(args ? { args } : {}) }] }, {
        value,
        stateModel: {},
      } as never).valid
    expect(check("lessThan", "3", { other: 5 })).toBe(true)
    expect(check("lessThan", [3], { other: "5" })).toBe(true)
    expect(check("greaterThan", "7", { other: 5 })).toBe(true)
    expect(check("greaterThan", "1".repeat(600), { other: 5 })).toBe(false)
    expect(check("numeric", "42")).toBe(true)
    expect(check("numeric", "1".repeat(600))).toBe(false)
    expect(check("min", "12", { min: 10 })).toBe(true)
    expect(check("max", "1".repeat(600), { max: 10 })).toBe(false)
    expect(check("url", "https://example.com/a")).toBe(true)
    expect(check("url", `https://example.com/${"a".repeat(10_000)}`)).toBe(false)
  })

  test("a field whose checks run past the evaluation bound counts as invalid, with its first message", async () => {
    quiet()
    await nextTask()
    const checks = Array.from({ length: 150_000 }, () => ({ type: "required", message: "Fill it in" }))
    const result = runValidation({ checks }, { value: "x", stateModel: {} } as never)
    expect(result).toEqual({ valid: false, errors: ["Fill it in"], checks: [] })
  })
})

describe("reconciling the user's edits costs the same per edit, however long the list [review8#R6S2-5]", () => {
  const timed = (run: () => void) => {
    const started = performance.now()
    run()
    return performance.now() - started
  }

  test("2,000 edits of a select-all follow 7,000 rows the agent moves, in milliseconds", () => {
    // Each edit whose row moved scanned the whole list for it: 7.5 s per agent patch (one per streamed line).
    const rows = Array.from({ length: 7000 }, (_, index) => [index, false])
    const store = createTrackedStore()
    store.setBase({ all: false, rows })
    for (let index = 0; index < 2000; index++) store.set(`/rows/${index}/1`, true)
    for (let patch = 1; patch <= 3; patch++) {
      const moved = [...Array.from({ length: patch }, (_, index) => [-1 - index, false]), ...rows]
      expect(timed(() => store.setBase({ all: false, rows: moved }))).toBeLessThan(150)
      const snapshot = store.getSnapshot() as { rows: [number, boolean][] }
      // Every checked row is still checked, at its new place.
      expect(snapshot.rows.filter((row) => row[1]).length).toBe(2000)
      expect(snapshot.rows[patch]).toEqual([0, true])
      expect(snapshot.rows[patch + 2000]).toEqual([2000, false])
    }
    // Removing the edited rows drops their edits, as fast.
    expect(timed(() => store.setBase({ all: false, rows: rows.slice(2000) }))).toBeLessThan(150)
    expect(store.overrides()).toEqual([])
  })

  test("equal rows keep each edit at the nearest one, keyed rows follow their key", () => {
    const store = createTrackedStore()
    store.setBase({ rows: [{ c: false }, { c: false }, { c: false }] })
    store.set("/rows/1/c", true)
    // An equal row is inserted before it: the edit stays where it was (the nearest equal row).
    store.setBase({ rows: [{ c: false }, { c: false }, { c: false }, { c: false }] })
    expect((store.getSnapshot() as { rows: { c: boolean }[] }).rows.map((row) => row.c)).toEqual([
      false,
      true,
      false,
      false,
    ])

    const keyed = createTrackedStore()
    keyed.setItemKeys([{ path: "/rows", key: "id" }])
    const many = Array.from({ length: 5000 }, (_, index) => ({ id: `r${index}`, c: false }))
    keyed.setBase({ rows: many })
    for (let index = 0; index < 2000; index++) keyed.set(`/rows/${index}/c`, true)
    const reversed = [...many].reverse()
    expect(timed(() => keyed.setBase({ rows: reversed }))).toBeLessThan(150)
    const after = (keyed.getSnapshot() as { rows: { id: string; c: boolean }[] }).rows
    expect(after[4999]).toEqual({ id: "r0", c: true })
    expect(after[0]).toEqual({ id: "r4999", c: false })
  })
})

describe("the stored edits always fit what is written, and never go stale [review8#R6F2-1]", () => {
  const id = "inline/trusted/x"
  let work: object | undefined
  const act = (run: () => void) => {
    work = {}
    run()
  }
  const entryBytes = (session: { readonly surfaces: Readonly<Record<string, string>> }) =>
    utf8Length(session.surfaces[id] ?? "")

  test("a select-all whose rows write twice, then an untick: the reload sees the untick", () => {
    // The stored copy was chosen in characters without the action numbers: 268,224 characters passed the 262,144 bytes
    // written, the old entry stayed, and a reload brought row 5 back ticked.
    groupEditsBy(() => work)
    try {
      const rows = Array.from({ length: 1990 }, (_, index) => ({ id: `r${index}`, checked: false }))
      const store = createTrackedStore()
      store.setItemKeys([{ path: "/rows", key: "id" }])
      store.setBase({ all: false, rows })
      act(() => {
        store.set("/all", true)
        for (let index = 0; index < rows.length; index++) {
          store.set(`/rows/${index}/checked`, true)
          store.set(`/rows/${index}/f0`, true)
        }
      })
      const session = writeSurfaceOverrides(undefined, id, store.overrides())
      expect(entryBytes(session)).toBeGreaterThan(200_000)
      expect(entryBytes(session)).toBeLessThanOrEqual(MAX_ENTRY_BYTES)
      act(() => store.set("/rows/5/checked", false))
      const next = writeSurfaceOverrides(session, id, store.overrides())
      expect(next).not.toBe(session)
      expect(entryBytes(next)).toBeLessThanOrEqual(MAX_ENTRY_BYTES)
      const reloaded = readSurfaceOverrides(next, id)
      // Both actions are stored (the first edit of each run of an action's edits records its number, not every edit), and
      // the reload sees the untick on top of the select-all.
      expect(reloaded.find(([path]) => path === "/rows/5/checked")?.[1]).toBe(false)
      expect(reloaded.find(([path]) => path === "/rows/6/checked")?.[1]).toBe(true)
      const reloadedStore = createTrackedStore()
      reloadedStore.setItemKeys([{ path: "/rows", key: "id" }])
      reloadedStore.setBase({ all: false, rows })
      reloadedStore.loadOverrides(reloaded as never)
      const after = reloadedStore.getSnapshot() as { rows: { checked: boolean }[] }
      expect(after.rows.filter((row) => row.checked).length).toBe(rows.length - 1)
      expect(after.rows[5]!.checked).toBe(false)
    } finally {
      groupEditsBy(undefined)
    }
  })

  test("a text of 90,000 CJK characters, then a short edit: the reload sees the short edit", () => {
    // 90,064 characters but 270,000 bytes: not written, the old entry stayed, and nothing later was stored.
    groupEditsBy(() => work)
    try {
      const store = createTrackedStore()
      store.setBase({ notes: "", title: "" })
      act(() => store.set("/title", "Draft"))
      let session = writeSurfaceOverrides(undefined, id, store.overrides())
      act(() => store.set("/notes", "汉".repeat(90_000)))
      session = writeSurfaceOverrides(session, id, store.overrides())
      expect(readSurfaceOverrides(session, id).some(([path]) => path === "/title")).toBe(false)
      act(() => store.set("/title", "Final title"))
      session = writeSurfaceOverrides(session, id, store.overrides())
      expect(readSurfaceOverrides(session, id).find(([path]) => path === "/title")?.[1]).toBe("Final title")
    } finally {
      groupEditsBy(undefined)
    }
  })

  test("each run of an action's edits records its action once, and a reload groups them as before", () => {
    groupEditsBy(() => work)
    try {
      const store = createTrackedStore()
      store.setBase({ rows: [0, 0, 0, 0], note: "" })
      const select = {}
      work = select
      store.set("/rows/0", 1)
      store.set("/rows/1", 1)
      work = {}
      store.set("/note", "x")
      work = select
      store.set("/rows/2", 1)
      store.set("/rows/3", 1)
      const stored = store.overrides()
      const marks = stored.map((entry) => (entry[2] as { a?: number } | undefined)?.a)
      expect(marks).toEqual([0, undefined, 1, 0, undefined])
      // The groups load as the edits were made: the select-all is one action across the key press.
      const reloaded = createTrackedStore()
      reloaded.setBase({ rows: [0, 0, 0, 0], note: "" })
      reloaded.loadOverrides(stored as never)
      expect(reloaded.overrides().map((entry) => (entry[2] as { a?: number } | undefined)?.a)).toEqual(marks)
      // The earlier form, with the action on every edit, loads the same.
      const everyEdit = stored.map((entry, index) => [
        entry[0],
        entry[1],
        { ...(entry[2] as object), a: [0, 0, 1, 0, 0][index] },
      ])
      const old = createTrackedStore()
      old.setBase({ rows: [0, 0, 0, 0], note: "" })
      old.loadOverrides(everyEdit as never)
      expect(old.overrides()).toEqual(stored)
    } finally {
      groupEditsBy(undefined)
    }
  })

  test("an entry that does not fit removes the stored one instead of keeping it", () => {
    const warn = console.warn
    console.warn = () => {}
    try {
      const small = writeSurfaceOverrides(undefined, id, [["/a", "x"]])
      expect(readSurfaceOverrides(small, id)).toEqual([["/a", "x"]])
      const big = writeSurfaceOverrides(small, id, [["/a", "汉".repeat(MAX_STORED_SIZE)]])
      expect(big.surfaces[id]).toBeUndefined()
      expect(readSurfaceOverrides(big, id)).toEqual([])
    } finally {
      console.warn = warn
    }
  })
})

describe("two modals bound to one open path [review8#R6F2-2]", () => {
  const surface = { kind: "inline" as const, id: "s", trusted: true }

  test("the second asks while the first is shown: it is told so (no refusal, which wrote false and closed both)", async () => {
    await nextTask()
    const store = {}
    const first = { open: false, isConnected: true }
    expect(modalRefusal(store, "/dup", surface)).toBeUndefined()
    noteModal(store, "/dup", "opened", surface)
    first.open = true
    noteModalShown(store, "/dup", first)
    // The Drawer on the same path, in the same task: it was refused as "again" and closed the Dialog too.
    expect(modalRefusal(store, "/dup", surface)).toBe("shown")
    // A modal opened in this task that is no longer shown (a remounted Dialog), or one that closed in it, is refused.
    first.open = false
    expect(modalRefusal(store, "/dup", surface)).toBe("again")
    first.open = true
    noteModal(store, "/dup", "closed", surface)
    expect(modalRefusal(store, "/dup", surface)).toBe("again")
    noteModal(store, "/dup", "opened", surface)
    expect(modalRefusal(store, "/dup", surface)).toBe("again")
    await nextTask()
    expect(modalRefusal(store, "/dup", surface)).toBeUndefined()
  })
})

describe("the newest inline surface keeps one surface's worth of the pool [review8#R6F2-3]", () => {
  test("surfaces other than the newest also charge a share of all but one surface's worth", () => {
    const first = joinInlinePool()
    expect(first.meters()).toEqual([windowPool("inline")])
    const second = joinInlinePool()
    // The first is no longer the newest: its elements take their room again within the older share.
    expect(first.meters().length).toBe(2)
    const older = first.meters()[1]!
    expect(older.maxUnits).toBe((POOL_SURFACES.inline - 1) * RENDER_UNITS)
    expect(second.meters()).toEqual([windowPool("inline")])
    second.leave()
    expect(first.meters()).toEqual([windowPool("inline")])
    first.leave()
  })
})
