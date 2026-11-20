import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createComponent, createRoot, type JSX } from "solid-js"
import { createStateStore, type Spec, type StateStore } from "@json-render/core"
import type { BaseComponentProps, ComponentRegistry } from "@json-render/solid"
import {
  buildRegistry,
  createElementRenderer,
  createRenderBudget,
  RENDER_UNITS,
  RenderBudgetContext,
  SLOT_UNITS,
  type ElementImpl,
  type JsonRenderHooks,
  type RenderBudget,
} from "../../src/gui/element.ts"
import { createMeter, POOL_SURFACES, TASK_UNITS, waiting, windowPool } from "../../src/runtime/budget.ts"
import { itemKeys } from "../../src/runtime/item-keys.ts"
import { evaluationsDone } from "./evaluations.ts"
import { poolKind, tooLarge } from "../../src/gui/issues.ts"

// Regression tests for the sixth review's rendering findings ([review6#R<n>]): the render budget shared across
// surfaces, slots, task slices, and elements that come back once room is freed.

// json-render's real renderer without a DOM, as in render.test.ts: @json-render/solid only touches the DOM at load.
const globals = globalThis as { window?: unknown }
globals.window = { document: { addEventListener() {} } }
const solid = await import("@json-render/solid")
const { JSONUIProvider, Renderer, useStateStore, useRepeatScope } = solid
const { RepeatRowsContext } = solid as unknown as Pick<JsonRenderHooks, "RepeatRowsContext">
delete globals.window

const flatten = (value: unknown): unknown[] =>
  typeof value === "function"
    ? flatten((value as () => unknown)())
    : Array.isArray(value)
      ? value.flatMap(flatten)
      : value === null || value === undefined
        ? []
        : [value]

interface Mounted {
  readonly text: () => string[]
  readonly store: StateStore
  readonly mounts: string[]
  readonly dispose: () => void
}

/** Renders `spec` with genui's element renderer (and json-render's hooks, as registry.tsx passes them). */
function render(spec: Spec, state: Record<string, unknown>, budget: RenderBudget): Mounted {
  const mounts: string[] = []
  const recorded = Object.fromEntries(
    Object.entries(COMPONENTS).map(([name, impl]): [string, ElementImpl] => [
      name,
      (ctx) => {
        mounts.push(name)
        return impl(ctx)
      },
    ]),
  )
  const unknown = () => "unknown" as unknown as JSX.Element
  const element = createElementRenderer(recorded, unknown, { useStateStore, useRepeatScope, RepeatRowsContext })
  const registry: ComponentRegistry = buildRegistry(Object.keys(COMPONENTS), element)
  const store = createStateStore(state)
  return createRoot((dispose) => {
    const tree = createComponent(RenderBudgetContext.Provider, {
      value: budget,
      get children() {
        return createComponent(JSONUIProvider, {
          registry,
          store,
          get children() {
            return createComponent(Renderer, { spec, registry, fallback: element })
          },
        })
      },
    })
    return { text: () => flatten(tree).map(String), store, mounts, dispose }
  })
}

const str = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? ""))
const Box: ElementImpl = (ctx: BaseComponentProps) => (() => [`<${str(ctx.props.title)}>`, ctx.children]) as never
const Field: ElementImpl = (ctx: BaseComponentProps) => (() => `${str(ctx.props.label)}`) as never
const COMPONENTS = { Box, Field }

const count = (mounts: readonly string[], name: string) => mounts.filter((mount) => mount === name).length
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const range = (length: number) => Array.from({ length }, (_, index) => index)

/** A list of `rows` Fields: one unit each, plus the list's one. */
const list = (rows: number): [Spec, Record<string, unknown>] => [
  {
    root: "list",
    elements: {
      list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
      row: { type: "Field", props: { label: "r" }, children: [] },
    },
  },
  { rows: range(rows) },
]

describe("render budget across surfaces [review6#R3]", () => {
  test("surfaces of one pool share it: the second renders what the first left, the rest once room is freed", async () => {
    // One surface's worth, like the pool all blocks outside the agent's reply share.
    const pool = createMeter(RENDER_UNITS, SLOT_UNITS)
    const [spec, state] = list(1500)
    const first = render(spec, state, createRenderBudget({ pool: () => pool }))
    first.text()
    // (Rows whose props take more than a task to evaluate are evaluated in the next tasks.)
    await evaluationsDone()
    expect(count(first.mounts, "Field")).toBe(1500)
    const secondBudget = createRenderBudget({ pool: () => pool })
    const second = render(spec, state, secondBudget)
    second.text()
    await evaluationsDone()
    // Twenty copies of a block that fills a budget rendered twenty times as much: now they share one.
    expect(count(second.mounts, "Field")).toBe(RENDER_UNITS - 1501 - 1)
    expect(pool.units).toBe(RENDER_UNITS)
    expect(secondBudget.skipped()).toBe(1500 - (RENDER_UNITS - 1502))
    // Every one of them would fit in its own budget: the pool cut them, so the UI is not told to shrink [R6F1-2].
    expect(secondBudget.pooled()).toBe(secondBudget.skipped())
    // The first goes away: the second's rows that did not fit render, a task later.
    first.dispose()
    await nextTask()
    second.text()
    expect(secondBudget.skipped()).toBe(0)
    expect(count(second.mounts, "Field")).toBe(1500)
    second.dispose()
    expect(pool.units).toBe(0)
    expect(pool.slots).toBe(0)
  })

  test("the window has one pool per kind, whatever surface asks for it", () => {
    expect(windowPool("untrusted")).toBe(windowPool("untrusted"))
    expect(windowPool("untrusted")).not.toBe(windowPool("inline"))
    expect(windowPool("untrusted").maxUnits).toBe(POOL_SURFACES.untrusted * RENDER_UNITS)
    expect(windowPool("inline").maxUnits).toBe(POOL_SURFACES.inline * RENDER_UNITS)
  })
})

describe("what a surface reports, and which pool it charges [R6F1-2, R6F1-6]", () => {
  test("the issue quotes the room of the surface's own pool, and does not ask to shrink a UI the pool cut", () => {
    // It quoted the agent's inline UIs' 6,000 for every surface: three times what blocks in tool output share.
    expect(tooLarge("untrusted").message).toContain("tool output and files in view share about 2,000 elements")
    expect(tooLarge("canvas").message).toContain("canvases in view share about 4,000 elements")
    expect(tooLarge("inline").message).toContain("agent's UIs in view share about 6,000 elements")
    expect(tooLarge("superseded").message).toContain("older copies of UIs sent again share about 2,000 elements")
    expect(tooLarge("inline").message).toContain("show fewer items or less text")
    expect(tooLarge("inline", true).message).not.toContain("show fewer items")
    expect(tooLarge("inline", true).message).toContain("other UIs hold that room now")
  })

  test("older copies of an inline UI the agent sent again charge a pool of their own, not the newest copy's", () => {
    // Older copies kept their room in the agent's pool, so the newest copy, with the live state, was cut.
    expect(poolKind({ kind: "inline", trusted: true }, true)).toBe("superseded")
    expect(poolKind({ kind: "inline", trusted: true })).toBe("inline")
    expect(poolKind({ kind: "inline", trusted: false }, true)).toBe("untrusted")
    expect(poolKind({ kind: "canvas", trusted: true })).toBe("canvas")
    expect(windowPool("superseded")).not.toBe(windowPool("inline"))
    expect(windowPool("superseded").maxUnits).toBe(POOL_SURFACES.superseded * RENDER_UNITS)
  })
})

describe("slots: child renderers are counted before they are built [review6#R3]", () => {
  // This test expected the repeat to render nothing at all, which showed an empty list for any repeat of 3 or more
  // children and more than SLOT_UNITS / 3 rows, where it showed its first rows before (R6F1-1).
  test("a repeat of rows × many children builds only the rows that fit, before any row is built [R6F1-1]", async () => {
    // 200 rows × 100 children built 20,000 renderers (2,000 rows × 500 children: a million) to show 2,000.
    const spec: Spec = {
      root: "outer",
      elements: {
        outer: { type: "Box", props: { title: "o" }, children: range(100).map(() => "c"), repeat: { statePath: "/a" } },
        c: { type: "Field", props: { label: "x" }, children: [] },
      },
    }
    const budget = createRenderBudget()
    const view = render(spec, { a: range(200) }, budget)
    view.text()
    await evaluationsDone()
    // Its first 40 rows: 4,000 child renderers, of which the units show 1,999 (the repeat holds one).
    expect(budget.meter.slots).toBe(SLOT_UNITS)
    expect(count(view.mounts, "Field")).toBe(RENDER_UNITS - 1)
    expect(budget.skipped()).toBe(1 + (SLOT_UNITS - (RENDER_UNITS - 1)))
    // Fewer rows: all of them fit again.
    view.store.set("/a", range(10))
    view.text()
    await evaluationsDone()
    expect(budget.meter.slots).toBe(1000)
    expect(budget.skipped()).toBe(0)
    view.dispose()
    expect(budget.meter.slots).toBe(0)
  })

  test("an element listing more children than SLOT_UNITS is refused; a list that fits renders as before", async () => {
    const flat: Spec = {
      root: "outer",
      elements: {
        outer: { type: "Box", props: { title: "o" }, children: range(SLOT_UNITS + 1).map(() => "c") },
        c: { type: "Field", props: { label: "x" }, children: [] },
      },
    }
    const refused = createRenderBudget()
    const view = render(flat, {}, refused)
    view.text()
    expect(view.mounts).toEqual([])
    view.dispose()
    // 1,000 rows of two children: 2,000 slots, and as many elements as the units allow.
    const pair: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "l" }, children: ["a", "b"], repeat: { statePath: "/rows" } },
        a: { type: "Field", props: { label: "a" }, children: [] },
        b: { type: "Field", props: { label: "b" }, children: [] },
      },
    }
    const budget = createRenderBudget()
    const rows = render(pair, { rows: range(1000) }, budget)
    rows.text()
    await evaluationsDone()
    expect(budget.meter.slots).toBe(2000)
    expect(count(rows.mounts, "Field")).toBe(RENDER_UNITS - 1)
    rows.dispose()
    expect(budget.meter.slots).toBe(0)
  })
})

describe("task slices [review6#R3]", () => {
  test("a sliced budget starts about a task's worth of elements, and the rest in later tasks", async () => {
    const [spec, state] = list(1900)
    const budget = createRenderBudget({ sliced: true })
    // The first task's clock stands still, so what ends it is its units (TASK_UNITS), not a pause of the test runner
    // (a garbage collection of more than TASK_MS while the 1,900 rows were built left no Field in the first task).
    const clock = performance.now
    const frozen = clock.call(performance)
    performance.now = () => frozen
    let view: ReturnType<typeof render>
    try {
      view = render(spec, state, budget)
      view.text()
    } finally {
      performance.now = clock
    }
    const first = count(view.mounts, "Field")
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThanOrEqual(TASK_UNITS)
    expect(waiting()).toBeGreaterThan(0)
    // Elements waiting for a task are not reported as too large.
    expect(budget.skipped()).toBe(0)
    for (let task = 0; task < 200 && waiting() > 0; task++) await nextTask()
    view.text()
    expect(count(view.mounts, "Field")).toBe(1900)
    expect(budget.skipped()).toBe(0)
    view.dispose()
  })
})

describe("room freed [review6#R6]", () => {
  test("elements pushed out by a long text render once the text shrinks", async () => {
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "b" }, children: ["big", "f1", "f2"] },
        big: { type: "Field", props: { label: { $state: "/doc" } }, children: [] },
        f1: { type: "Field", props: { label: "footer one" }, children: [] },
        f2: { type: "Field", props: { label: "footer two" }, children: [] },
      },
    }
    const budget = createRenderBudget()
    // The box takes one unit; the text all but the last one.
    const view = render(spec, { doc: "x".repeat((RENDER_UNITS - 2) * 250) }, budget)
    expect(view.text().filter((line) => line.startsWith("footer"))).toEqual([])
    expect(budget.skipped()).toBe(2)
    view.store.set("/doc", "short")
    // Before, the footers kept their static props, so nothing asked them again: they stayed out until a remount.
    await nextTask()
    expect(view.text().filter((line) => line.startsWith("footer"))).toEqual(["footer one", "footer two"])
    expect(budget.skipped()).toBe(0)
    view.dispose()
  })
})

describe("itemKeys stays linear [review6#R3]", () => {
  test("a child listed many times, or a lattice of elements, costs little", () => {
    const repeated: Spec = {
      root: "outer",
      elements: {
        outer: { type: "Stack", props: {}, children: range(25_000).map(() => "c") },
        c: { type: "Text", props: { text: "x" }, children: [] },
      },
    }
    let started = performance.now()
    expect(itemKeys(repeated)).toEqual([])
    // A copy of the parent list per entry: 25,000² / 2 copies.
    expect(performance.now() - started).toBeLessThan(200)

    // 24 levels of two elements, each listing both of the next level: 2^24 paths from the top to the keyed list.
    const elements: Spec["elements"] = {
      top: { type: "Stack", props: {}, children: ["a0", "b0"], repeat: { statePath: "/groups" } },
    }
    for (let level = 0; level < 24; level++) {
      const next = level === 23 ? ["list"] : [`a${level + 1}`, `b${level + 1}`]
      elements[`a${level}`] = { type: "Stack", props: {}, children: next }
      elements[`b${level}`] = { type: "Stack", props: {}, children: next }
    }
    elements.list = {
      type: "Stack",
      props: {},
      children: [],
      repeat: { statePath: { $item: "todos" }, key: "id" },
    } as never
    started = performance.now()
    expect(itemKeys({ root: "top", elements })).toEqual([{ path: "/groups/*/todos", key: "id" }])
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe("the playground's dependency cache follows the patches [review6#DEV-CACHE]", () => {
  test("its digest changes with a patch's text and with the installed file it patches", async () => {
    const config = await import("../../playground/vite.config.ts")
    const root = mkdtempSync(path.join(tmpdir(), "genui-digest-"))
    try {
      mkdirSync(path.join(root, "patches"))
      mkdirSync(path.join(root, "node_modules/@scope/pkg/dist"), { recursive: true })
      const patch = path.join(root, "patches/@scope%2Fpkg@1.0.0.patch")
      const installed = path.join(root, "node_modules/@scope/pkg/dist/index.mjs")
      writeFileSync(patch, "--- a/dist/index.mjs\n+++ b/dist/index.mjs\n@@ -1 +1 @@\n-old\n+new\n")
      writeFileSync(installed, "new\n")
      const first = config.patchDigest(root)
      writeFileSync(installed, "newer\n")
      const reinstalled = config.patchDigest(root)
      expect(reinstalled).not.toBe(first)
      writeFileSync(patch, "--- a/dist/index.mjs\n+++ b/dist/index.mjs\n@@ -1 +1 @@\n-old\n+newer\n")
      expect(config.patchDigest(root)).not.toBe(reinstalled)
      writeFileSync(patch, "--- a/dist/index.mjs\n+++ b/dist/index.mjs\n@@ -1 +1 @@\n-old\n+new\n")
      writeFileSync(installed, "new\n")
      expect(config.patchDigest(root)).toBe(first)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // Vite hashes the optimizer's options: the repo's digest is in them.
    expect(JSON.stringify(config.default.optimizeDeps?.esbuildOptions)).toContain(config.patchDigest())
  })
})
