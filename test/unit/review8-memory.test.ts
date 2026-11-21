import { describe, expect, test } from "bun:test"
import { createComponent, createRoot, type Context, type JSX } from "solid-js"
import * as core from "@json-render/core"
import { createStateStore, type Spec, type StateStore } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import {
  buildRegistry,
  builtOf,
  childSlots,
  createElementRenderer,
  createKeptLedger,
  createRenderBudget,
  guardDirectives,
  RenderBudgetContext,
  SpecElementsContext,
  textBound,
  type ChildReads,
  type ElementImpl,
  type JsonRenderHooks,
  type KeptLedger,
  type RenderBudget,
} from "../../src/gui/element.ts"
import {
  createMeter,
  joinInlinePool,
  KEPT_PER_SURFACE,
  keptMeter,
  POOL_SURFACES,
  windowPool,
  type Meter,
} from "../../src/runtime/budget.ts"
import { valuesCut } from "../../src/gui/issues.ts"
import { RENDER_UNITS, SLOT_UNITS, TEXT_PER_UNIT } from "../../src/shared/constants.ts"
import { evaluationsDone } from "./evaluations.ts"

// Regression tests for the eighth review's memory findings ([review8#R7S2-1], [review7#R7A-5]): what rendered element
// instances keep of their resolved props is bounded (the kept ledger), and a child whose expressions would build
// megabytes is refused at its parent before json-render builds it. See test/e2e/review8-memory.spec.ts for the same in
// the playground.

const globals = globalThis as { window?: unknown }
globals.window = { document: { addEventListener() {} } }
const solid = await import("@json-render/solid")
delete globals.window
const { JSONUIProvider, Renderer, useRepeatScope, useStateStore } = solid
const { RepeatRowsContext } = solid as unknown as Pick<JsonRenderHooks, "RepeatRowsContext">
const { KeptValuesContext } = solid as unknown as { readonly KeptValuesContext: Context<KeptLedger | undefined> }
const { withEvaluation } = core as unknown as {
  readonly withEvaluation: <T>(
    deferrable: boolean,
    run: () => T,
    keep?: { room: number; kept: number; cut: boolean },
  ) => T
}

const flatten = (value: unknown): unknown[] =>
  typeof value === "function"
    ? flatten((value as () => unknown)())
    : Array.isArray(value)
      ? value.flatMap(flatten)
      : value === null || value === undefined
        ? []
        : [value]

/** A spec of elements given as `[key, type, props, children, extra]`, rooted at the first. */
function spec(
  ...elements: Array<[string, string, Record<string, unknown>, string[]?, Record<string, unknown>?]>
): Spec {
  return {
    root: elements[0]![0],
    elements: Object.fromEntries(
      elements.map(([key, type, props, children = [], extra = {}]) => [key, { type, props, children, ...extra }]),
    ),
  } as unknown as Spec
}

interface Mounted {
  /** The text each rendered Text shows (its `text` prop, then its other props' lengths). */
  readonly texts: () => string[]
  readonly store: StateStore
  /** How many element renderers json-render built (each resolved its props). */
  readonly built: () => number
  readonly cuts: Array<{ readonly pooled: boolean; readonly elementKey: string | undefined; withdrawn: boolean }>
  readonly dispose: () => void
}

/**
 * Renders `spec` with genui's element renderer, json-render's hooks and genui's guarded directives, as a surface does,
 * with a kept ledger over `budget`'s meters (KeptValuesContext; none when `kept` is false) and, when `render` is set, the
 * render budget itself (RenderBudgetContext) and the spec's elements (so parents charge their children).
 */
function mount(
  rendered: Spec,
  state: Record<string, unknown>,
  budget: Pick<RenderBudget, "meter" | "pool">,
  options: { readonly kept?: boolean; readonly render?: RenderBudget } = {},
): Mounted {
  const components: Record<string, ElementImpl> = {
    Stack: (ctx) => (() => ctx.children) as never,
    Text: (ctx) =>
      (() =>
        Object.entries(ctx.props)
          .map(([key, value]) => (key === "text" ? String(value ?? "") : `${key}:${String(value ?? "").length}`))
          .join("|")) as never,
  }
  const unknown = () => "unknown" as unknown as JSX.Element
  const element = createElementRenderer(components, unknown, { useStateStore, useRepeatScope, RepeatRowsContext })
  let built = 0
  const counting = ((props: Parameters<typeof element>[0]) => {
    built++
    return element(props)
  }) as typeof element
  const registry = buildRegistry(Object.keys(components), counting)
  const store = createStateStore(state)
  const cuts: Mounted["cuts"] = []
  return createRoot((dispose) => {
    const renderer = () =>
      createComponent(SpecElementsContext.Provider, {
        value: () => rendered.elements as Record<string, unknown>,
        get children() {
          return createComponent(Renderer, { spec: rendered, registry, fallback: counting })
        },
      })
    const withKept = () => {
      if (options.kept === false) return renderer()
      const ledger = createKeptLedger(budget, (pooled, elementKey) => {
        const cut = { pooled, elementKey, withdrawn: false }
        cuts.push(cut)
        return () => void (cut.withdrawn = true)
      })
      return createComponent(KeptValuesContext.Provider, {
        value: ledger,
        get children() {
          return renderer()
        },
      })
    }
    const provider = () =>
      createComponent(JSONUIProvider, {
        registry,
        store,
        directives: guardDirectives(standardDirectives),
        get children() {
          return withKept()
        },
      })
    const tree = options.render
      ? createComponent(RenderBudgetContext.Provider, {
          value: options.render,
          get children() {
            return provider()
          },
        })
      : provider()
    return {
      texts: () => flatten(tree).map(String),
      store,
      built: () => built,
      cuts,
      dispose,
    }
  })
}

/** A budget of its own (no pool) whose kept meter holds `max` characters. */
function keptBudget(max: number): Pick<RenderBudget, "meter" | "pool"> {
  return { meter: createMeter((max / KEPT_PER_SURFACE) * RENDER_UNITS, SLOT_UNITS) }
}

const used = (meter: Meter) => keptMeter(meter).used

describe("what an evaluation keeps is counted against the room it is given [review8#R7S2-1]", () => {
  const directives = core.createDirectiveRegistry(guardDirectives(standardDirectives))
  const ctx = (state: Record<string, unknown>) => ({ stateModel: state, directives })
  const resolve = (value: unknown, state: Record<string, unknown>, room = Infinity) => {
    const keep = { room, kept: 0, cut: false }
    let result: unknown
    let error: unknown
    try {
      result = withEvaluation(true, () => core.resolvePropValue(value as never, ctx(state) as never), keep)
    } catch (thrown) {
      error = thrown
    }
    return { result, error: error as { readonly expansionLimit?: boolean } | undefined, keep }
  }

  test("the characters a $template, $concat or $join builds count; a reference or a value without expressions does not", () => {
    const s = "x".repeat(1000)
    expect(resolve({ $template: "${/s}${/s}" }, { s }).keep.kept).toBe(10 + 2000)
    expect(resolve({ $concat: [{ $state: "/s" }, "!", { $state: "/s" }] }, { s }).keep.kept).toBe(2001)
    expect(resolve({ $join: { $state: "/l" }, separator: "-" }, { l: [s, s, s] }).keep.kept).toBe(3002)
    expect(resolve({ $state: "/s" }, { s }).keep.kept).toBe(0)
    const fixed = { list: Array.from({ length: 500 }, () => 1) }
    expect(resolve(fixed, {}).keep.kept).toBe(0)
  })

  test("the lists and objects an expression's value is built into count one per entry", () => {
    // A list holding an expression is resolved into a list of its own for every instance.
    const value = [{ $state: "/a" }, ...Array.from({ length: 999 }, () => 0)]
    expect(resolve(value, { a: 1 }).keep.kept).toBe(1000)
    expect(resolve({ a: { $state: "/a" }, b: 1, c: 2 }, { a: 1 }).keep.kept).toBe(3)
  })

  test("the text a directive returns counts", () => {
    const parts = Array.from({ length: 20 }, () => "y".repeat(100))
    const { keep, result } = resolve({ $truncate: { $state: "/l" }, length: 5000 }, { l: parts })
    expect(typeof result).toBe("string")
    expect(keep.kept).toBe((result as string).length)
  })

  test("past its room, the expression stops before building more, as an expansion limit, and marks the evaluation cut", () => {
    const s = "x".repeat(90_000)
    const { error, keep, result } = resolve({ $template: "${/s}".repeat(11) }, { s }, 200_000)
    expect(result).toBeUndefined()
    expect(error?.expansionLimit).toBe(true)
    expect(keep.cut).toBe(true)
    expect(keep.kept).toBeLessThanOrEqual(200_000)
  })
})

describe("the kept ledger bounds what element instances keep [review8#R7S2-1, review7#R7A-5]", () => {
  test("an instance charges what its props built, a recompute replaces it, and it is given back as the instance goes", async () => {
    const budget = keptBudget(100_000)
    const view = mount(spec(["t", "Text", { text: { $template: "${/s}${/s}" } }]), { s: "x".repeat(1000) }, budget)
    await evaluationsDone()
    expect(view.texts()).toEqual(["x".repeat(2000)])
    expect(used(budget.meter)).toBe(10 + 2000)
    view.store.set("/s", "y".repeat(10))
    await evaluationsDone()
    expect(view.texts()).toEqual(["y".repeat(20)])
    expect(used(budget.meter)).toBe(10 + 20)
    view.dispose()
    expect(used(budget.meter)).toBe(0)
  })

  test("past the room, the prop is left empty and reported until the instance goes; the props before it stay", async () => {
    const budget = keptBudget(100_000)
    const props = { text: { $template: "${/s}" }, p1: { $template: "${/s}" }, p2: { $template: "${/s}" } }
    const view = mount(spec(["t", "Text", props]), { s: "x".repeat(40_000) }, budget)
    await evaluationsDone()
    expect(view.texts()).toEqual([`${"x".repeat(40_000)}|p1:40000|p2:0`])
    expect(used(budget.meter)).toBe(2 * 40_005)
    expect(view.cuts).toEqual([{ pooled: false, elementKey: "t", withdrawn: false }])
    view.dispose()
    expect(view.cuts[0]!.withdrawn).toBe(true)
    expect(used(budget.meter)).toBe(0)
  })

  test("a repeat's rows keep no more than the room: 2,000 rows whose props each build 4 million characters", async () => {
    // The R7S2-1 shape, without the render budget that refuses such rows at their parent: every row is built, so only
    // the ledger stands between them and the window's memory (before, every row kept its 4 million characters).
    const budget = keptBudget(KEPT_PER_SURFACE)
    const big = { $template: "${/big}".repeat(11) }
    const view = mount(
      spec(
        ["s", "Stack", {}, ["w"], { repeat: { statePath: "/rows" } }],
        ["w", "Text", { text: big, p1: big, p2: big, p3: big }],
      ),
      { big: "x".repeat(90_000), rows: Array.from({ length: 2000 }, () => 0) },
      budget,
    )
    await evaluationsDone()
    expect(view.built()).toBe(2001)
    expect(used(budget.meter)).toBeLessThanOrEqual(KEPT_PER_SURFACE)
    const kept = view.texts().reduce((total, text) => total + text.length, 0)
    expect(kept).toBeLessThan(KEPT_PER_SURFACE + 2000 * 40)
    expect(view.cuts.length).toBe(2000)
    view.dispose()
    expect(used(budget.meter)).toBe(0)
  })

  test("an instance that left a prop empty keeps it once room is freed", async () => {
    const budget = keptBudget(50_000)
    const first = mount(spec(["a", "Text", { text: { $template: "${/s}" } }]), { s: "a".repeat(40_000) }, budget)
    await evaluationsDone()
    const second = mount(spec(["b", "Text", { text: { $template: "${/s}" } }]), { s: "b".repeat(30_000) }, budget)
    await evaluationsDone()
    expect(second.texts()).toEqual([""])
    expect(second.cuts).toEqual([{ pooled: false, elementKey: "b", withdrawn: false }])
    first.dispose()
    // Room freed is told in a later task.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await evaluationsDone()
    expect(second.texts()).toEqual(["b".repeat(30_000)])
    expect(second.cuts[0]!.withdrawn).toBe(true)
    expect(used(budget.meter)).toBe(30_005)
    second.dispose()
  })

  test("a window-wide pool is charged once per instance: a remount gives back before it takes again", async () => {
    const pool = createMeter(RENDER_UNITS, SLOT_UNITS)
    const surface = () => ({ meter: createMeter(RENDER_UNITS, SLOT_UNITS), pool: () => pool })
    const shape = spec(["t", "Text", { text: { $template: "${/s}" } }])
    let view = mount(shape, { s: "x".repeat(1000) }, surface())
    await evaluationsDone()
    expect(used(pool)).toBe(1005)
    for (let round = 0; round < 3; round++) {
      view.dispose()
      view = mount(shape, { s: "x".repeat(1000) }, surface())
      await evaluationsDone()
      expect(used(pool)).toBe(1005)
    }
    // A second surface of the same pool adds its own; the pool's room is shared, so a third one that would pass it is
    // cut, and says the room went to other surfaces.
    const big = spec(["t", "Text", { text: { $template: "${/s}" } }])
    const second = mount(big, { s: "y".repeat(990_000) }, surface())
    await evaluationsDone()
    const third = mount(big, { s: "z".repeat(990_000) }, surface())
    await evaluationsDone()
    expect(used(pool)).toBe(1005 + 990_005 + 990_005)
    const fourth = mount(big, { s: "w".repeat(990_000) }, surface())
    await evaluationsDone()
    expect(fourth.texts()).toEqual([""])
    expect(fourth.cuts).toEqual([{ pooled: true, elementKey: "t", withdrawn: false }])
    for (const mounted of [view, second, third, fourth]) mounted.dispose()
    expect(used(pool)).toBe(0)
  })

  test("the agent's newest inline UI keeps a surface's worth however much older ones keep", async () => {
    // Each UI's element keeps 1.9 million characters (two props of 950,000). Three older UIs would hold 5.7 million of the
    // inline pool's 6 million; the older ones may hold only 4 million, so the newest still keeps all of its own.
    const inline = windowPool("inline")
    expect(keptMeter(inline).max).toBe(POOL_SURFACES.inline * KEPT_PER_SURFACE)
    const shape = spec(["t", "Text", { text: { $template: "${/s}" }, p1: { $template: "${/s}" } }])
    const surfaces: Array<{ readonly view: Mounted; readonly leave: () => void }> = []
    for (let index = 0; index < 4; index++) {
      const member = createRoot(() => joinInlinePool())
      const view = mount(
        shape,
        { s: String(index).repeat(950_000) },
        {
          meter: createMeter(RENDER_UNITS, SLOT_UNITS),
          pool: () => member.meters(),
        },
      )
      surfaces.push({ view, leave: member.leave })
      await evaluationsDone()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await evaluationsDone()
    }
    const [first, second, third, newest] = surfaces.map(({ view }) => view)
    expect(first!.texts()).toEqual([`${"0".repeat(950_000)}|p1:950000`])
    expect(second!.texts()).toEqual([`${"1".repeat(950_000)}|p1:950000`])
    // The third was the newest when it rendered; when the fourth came, its hold no longer fit in the older UIs' share,
    // so it was evaluated again with the room left there.
    expect(third!.texts()).toEqual(["|p1:0"])
    expect(third!.cuts.at(-1)).toEqual({ pooled: true, elementKey: "t", withdrawn: false })
    expect(newest!.texts()).toEqual([`${"3".repeat(950_000)}|p1:950000`])
    expect(newest!.cuts).toEqual([])
    expect(keptMeter(inline).used).toBeLessThanOrEqual(keptMeter(inline).max)
    for (const { view, leave } of surfaces.reverse()) {
      view.dispose()
      leave()
    }
    expect(keptMeter(inline).used).toBe(0)
  })
})

describe("a child whose expressions build megabytes is refused at its parent [review8#R7S2-1]", () => {
  const reads = (state: Record<string, unknown>, items: readonly unknown[] = []): ChildReads => ({
    state: () => state,
    itemText: (path) =>
      items.length === 0
        ? 0
        : Math.ceil(
            items.reduce((total: number, item) => total + textBound(core.getByPath(item as never, path)), 0) /
              items.length,
          ),
    wholeItem: () => (items.length === 0 ? 0 : Math.ceil(textBound(items) / items.length)),
  })
  const text = (props: Record<string, unknown>) => ({ type: "Text", props, children: [] })

  test("a template counts the current size of each state value it references", () => {
    const child = text({ text: { $template: "Total: ${/a} and ${/b}" } })
    expect(builtOf(child, reads({ a: "x".repeat(2000), b: 12345 }))).toBe(2000 + 5)
    // Written in 80 characters, four of them read a text of 90,000 characters eleven times each.
    const big = text({ text: { $template: "${/big}".repeat(11) } })
    expect(childSlots(big)).toBe(1)
    // Counted up to just past what a surface holds in all (RENDER_UNITS × TEXT_PER_UNIT).
    expect(childSlots(big, reads({ big: "x".repeat(90_000) }))).toBe(
      1 + Math.floor((RENDER_UNITS * TEXT_PER_UNIT + 1) / TEXT_PER_UNIT),
    )
    expect(childSlots(big, reads({ big: "x".repeat(9_000) }))).toBe(1 + Math.floor(99_000 / TEXT_PER_UNIT))
    const four = text(
      Object.fromEntries(["text", "p1", "p2", "p3"].map((key) => [key, { $template: "${/big}".repeat(11) }])),
    )
    expect(childSlots(four, reads({ big: "x".repeat(90_000) }))).toBeGreaterThan(SLOT_UNITS / 2)
  })

  test("$concat, $join and $truncate count what they read; a reference alone does not", () => {
    const state = { s: "x".repeat(10_000), list: ["a".repeat(3000), "b".repeat(3000)], n: [123456, 789] }
    expect(builtOf(text({ text: { $concat: [{ $state: "/s" }, "-", { $state: "/s" }] } }), reads(state))).toBe(20_000)
    expect(builtOf(text({ text: { $join: { $state: "/list" }, separator: ", " } }), reads(state))).toBe(3 * 6002)
    expect(builtOf(text({ text: { $truncate: { $state: "/s" }, length: 40 } }), reads(state))).toBe(43)
    // A list counts an entry for each comma (an upper bound).
    expect(builtOf(text({ text: { $template: "${/n}" } }), reads(state))).toBe(11)
    expect(builtOf(text({ text: { $state: "/s" } }), reads(state))).toBe(0)
  })

  test("an expression that surely builds more than a million characters keeps nothing, so it is not charged", () => {
    // json-render's core leaves such a prop empty (with the rest of it) before building more than a million: a block
    // whose templates read a 30 KB text 2,000 times each renders the rest of its UI (review6-watch.spec.ts).
    const state = { doc: "d".repeat(30_000), mid: "x".repeat(9000) }
    const huge = { $template: "${/doc}".repeat(2000) }
    const large = { $template: "${/mid}".repeat(11) }
    expect(builtOf(text({ text: huge }), reads(state))).toBe(0)
    expect(
      builtOf(text({ text: { $concat: [{ $state: "/doc" }, ...Array(40).fill({ $state: "/doc" })] } }), reads(state)),
    ).toBe(0)
    // The whole prop is left empty, another expression in it too.
    expect(builtOf(text({ items: [large, huge] }), reads(state))).toBe(0)
    expect(builtOf(text({ text: large, items: [large, huge] }), reads(state))).toBe(99_000)
    // One that may not be evaluated at all (a branch of a condition) is no reason: the other branch may build.
    const either = text({ text: { $cond: { $state: "/flag" }, $then: huge, $else: large } })
    expect(builtOf(either, reads({ ...state, flag: false }))).toBeGreaterThanOrEqual(99_000)
  })

  test("a row's template is counted by what its rows read on average, not by the whole items", () => {
    // Items with a short name and a long description: rows that show the name are charged the name.
    const items = Array.from({ length: 200 }, (_, index) => ({ name: `item ${index}`, description: "d".repeat(400) }))
    const child = text({ text: { $template: "${name}" } })
    expect(childSlots(child, reads({ rows: items }, items))).toBe(1)
    expect(builtOf(child, reads({ rows: items }, items))).toBeLessThan(10)
    const long = text({ text: { $template: "${description}${description}" } })
    expect(builtOf(long, reads({ rows: items }, items))).toBe(800)
    expect(childSlots(long, reads({ rows: items }, items))).toBeGreaterThan(
      childSlots(child, reads({ rows: items }, items)),
    )
  })

  test("2,000 rows whose props would build megabytes are refused before json-render builds them", async () => {
    const big = { $template: "${/big}".repeat(11) }
    const rendered = spec(
      ["s", "Stack", {}, ["w"], { repeat: { statePath: "/rows" } }],
      ["w", "Text", { text: big, p1: big, p2: big, p3: big }],
    )
    const state = { big: "x".repeat(90_000), rows: Array.from({ length: 2000 }, () => 0) }
    const budget = createRenderBudget()
    const view = mount(rendered, state, budget, { kept: false, render: budget })
    await evaluationsDone()
    // The Stack, and at most the one row whose slots fit; before, all 2,000 rows were built.
    expect(view.built()).toBeLessThanOrEqual(2)
    expect(budget.skipped()).toBeGreaterThan(0)
    view.dispose()
  })

  test("2,000 rows of short templated strings all render, as before", async () => {
    const rows = Array.from({ length: 1998 }, (_, index) => ({ name: `item ${index}`, price: index }))
    const rendered = spec(
      ["s", "Stack", {}, ["w"], { repeat: { statePath: "/rows" } }],
      ["w", "Text", { text: { $template: "${name}: ${price} ${/cur}" } }],
    )
    const budget = createRenderBudget()
    const view = mount(rendered, { rows, cur: "EUR" }, budget, { render: budget })
    await evaluationsDone()
    expect(view.texts().length).toBe(1998)
    expect(view.texts()[1997]).toBe("item 1997: 1997 EUR")
    expect(budget.skipped()).toBe(0)
    expect(view.cuts).toEqual([])
    view.dispose()
  })
})

describe("the issue an element that left props empty reports [review8#R7S2-1]", () => {
  test("says what is bounded, and whether other UIs hold the room", () => {
    expect(valuesCut(false).message).toContain("2,000,000 characters")
    expect(valuesCut(false).message).toContain("$template")
    expect(valuesCut(true).message).toContain("other UIs hold that room")
  })
})
