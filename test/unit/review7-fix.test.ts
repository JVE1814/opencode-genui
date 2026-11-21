import { describe, expect, test } from "bun:test"
import { createComponent, createRoot, type Component, type JSX } from "solid-js"
import { createStateStore, type Spec } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import {
  buildRegistry,
  childSlots,
  createElementRenderer,
  createRenderBudget,
  guardDirectives,
  RenderBudgetContext,
  slotsOf,
  SpecElementsContext,
  type ElementImpl,
  type JsonRenderHooks,
} from "../../src/gui/element.ts"
import { evaluationsDone } from "./evaluations.ts"
import { codeBlocks, MAX_PARAGRAPH, shownLength } from "../../src/gui/components/markdown.ts"
import { textCodeUnits } from "../../src/gui/costs.ts"
import {
  foldCanvases,
  jsonEqual,
  MAX_CANVASES,
  type CanvasBlock,
  type CanvasSnapshot,
} from "../../src/protocol/fold.ts"
import { parseBlock } from "../../src/protocol/surface.ts"
import { createTrackedStore, jsonLength, Matcher } from "../../src/runtime/state.ts"
import { SLOT_UNITS, TEXT_PER_UNIT } from "../../src/shared/constants.ts"
import { seeded } from "./random.ts"

const globals = globalThis as { window?: unknown }
globals.window = { document: { addEventListener() {} } }
const solid = await import("@json-render/solid")
delete globals.window
const { JSONUIProvider, Renderer, useRepeatScope, useStateStore } = solid
const { RepeatRowsContext } = solid as unknown as Pick<JsonRenderHooks, "RepeatRowsContext">

// Regression tests for the seventh review's rechecks ([review7#R7S1-<n>], [review7#R7F1-<n>]). See
// test/e2e/review7-fix.spec.ts for the same in the playground.

const timed = <T>(run: () => T): { readonly ms: number; readonly value: T } => {
  const started = performance.now()
  const value = run()
  return { ms: performance.now() - started, value }
}

/** An array whose item reads are counted (through a Proxy): how often the code under test walks it. */
function counted<T>(items: T[]): { readonly list: T[]; readonly reads: () => number } {
  let reads = 0
  const list = new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    },
  })
  return { list, reads: () => reads }
}

describe("what an edit costs does not grow with the size of its item [review7#R7S1-1, review7#R7S1-2]", () => {
  // One row of an 84 KB state: a list f the user's select-all wrote below (4 edits per entry) and a long list pad the
  // edits never touch. Each edit compared and hashed the whole row on every agent patch (45 s for 7,600 edits), and
  // checked and wrote out the whole row each time the edits were saved (3.6 s).
  const shape = (entries: number, fields: readonly string[], padLength: number) => {
    const pad = counted(Array.from({ length: padLength }, () => 0))
    const row = (c: number) => ({ f: Array.from({ length: entries }, () => 0), pad: pad.list, c })
    const store = createTrackedStore()
    store.setBase({ all: false, rows: [row(0)] })
    for (let entry = 0; entry < entries; entry++)
      for (const field of fields) store.set(`/rows/0/f/${entry}/${field}`, 1)
    return { store, row, pad }
  }

  test("an agent patch to the row reads its long list a few times, not once per edit", () => {
    const { store, row, pad } = shape(1900, ["v", "w", "x", "y"], 40_000)
    const before = pad.reads()
    // The agent changes c, and sends f again as an equal copy (pad is the same list).
    const { ms } = timed(() => store.setBase({ all: false, rows: [row(1)] }))
    expect(pad.reads() - before).toBeLessThanOrEqual(2 * 40_000)
    expect(ms).toBeLessThan(2000)
    const after = store.getSnapshot() as { rows: { f: unknown[]; c: number }[] }
    expect(after.rows[0]!.c).toBe(1)
    expect(after.rows[0]!.f[0]).toEqual({ v: 1, w: 1, x: 1, y: 1 })
    expect(after.rows[0]!.f[1899]).toEqual({ v: 1, w: 1, x: 1, y: 1 })
    expect(store.overrides()).toHaveLength(7600)
    expect(store.editsUnmatched()).toBe(false)
  })

  test("an agent patch keeps the snapshot's objects where their content is the same", () => {
    // The renderer compares by identity: composed anew, every entry the edits are under was a new object after each
    // agent patch, and json-render updated every row of the list (1,900 rows: a quarter of a second per patch).
    const { store, row } = shape(1900, ["v"], 10)
    const before = store.getSnapshot() as { rows: { f: unknown[]; pad: unknown[]; c: number }[] }
    store.setBase({ all: false, rows: [row(1)] })
    const after = store.getSnapshot() as typeof before
    expect(after.rows[0]!.c).toBe(1)
    expect(after.rows[0]!.f).toBe(before.rows[0]!.f)
    expect(after.rows[0]!.pad).toBe(before.rows[0]!.pad)
    // What changed is new: an edit, then the agent's change below an edited entry.
    store.set("/rows/0/f/3/v", 2)
    const edited = store.getSnapshot() as typeof before
    expect(edited.rows[0]!.f[3]).toEqual({ v: 2 })
    expect(edited.rows[0]!.f[4]).toBe(after.rows[0]!.f[4])
    store.setBase({ all: true, rows: [row(1)] })
    const next = store.getSnapshot() as typeof before & { all: boolean }
    expect(next.all).toBe(true)
    expect(next.rows).toBe(edited.rows)
  })

  test("saving the edits reads the row's long list at most as far as the stored levels' bound", () => {
    const { store, pad } = shape(1900, ["v", "w", "x", "y"], 40_000)
    const before = pad.reads()
    const { ms, value } = timed(() => store.overrides())
    // The row's JSON is longer than an edit's stored levels may be (2,048 characters): it is not stored, and finding
    // that out reads the list only that far, once for all 7,600 edits.
    expect(pad.reads() - before).toBeLessThanOrEqual(2048)
    expect(ms).toBeLessThan(1000)
    expect(value).toHaveLength(7600)
    expect(value[0]).toEqual(["/rows/0/f/0/v", 1, {}])
  })

  test("stored levels are written as before: short items whole, keyed items by their key, long items left out", () => {
    const store = createTrackedStore()
    store.setItemKeys([{ path: "/keyed", key: "id" }])
    store.setBase({
      short: [{ a: 1, b: "two" }],
      keyed: [{ id: "k1", body: "x".repeat(5000) }],
      long: [{ text: "y".repeat(3000) }],
    })
    store.set("/short/0/a", 2)
    store.set("/keyed/0/body", "z")
    store.set("/long/0/text", "w")
    const entries = store.overrides()
    expect(entries[0]).toEqual(["/short/0/a", 2, { b: 1, i: [[1, { a: 1, b: "two" }, 1]] }])
    expect(entries[1]).toEqual(["/keyed/0/body", "z", { b: "x".repeat(5000), i: [[1, { id: "k1" }, 1]] }])
    expect(entries[2]).toEqual(["/long/0/text", "w", { b: "y".repeat(3000) }])
  })

  test("jsonLength is JSON.stringify's length up to the cap, and stops early past it", () => {
    const draw = seeded(7)
    const value = (depth: number): unknown => {
      const kind = draw(depth > 3 ? 4 : 6)
      if (kind === 0) return draw(1000) - 500
      if (kind === 1) return ['a"b', "é\n", "\u0001", "plain", "\ud800"][draw(5)]
      if (kind === 2) return [true, false, null][draw(3)]
      if (kind === 3) return draw(10) / 7
      if (kind === 4) return Array.from({ length: draw(5) }, () => value(depth + 1))
      return Object.fromEntries(Array.from({ length: draw(5) }, (_, index) => [`k${index}"`, value(depth + 1)]))
    }
    for (let round = 0; round < 2000; round++) {
      const item = value(0)
      const length = JSON.stringify(item).length
      expect(jsonLength(item, 2048)).toBe(length)
      expect(jsonLength(item, 10)).toBe(length > 10 ? 11 : length)
    }
    expect(jsonLength({ a: Number.NaN }, 2048)).toBe(-1)
    expect(jsonLength({ a: undefined, b: 1 }, 2048)).toBe(JSON.stringify({ b: 1 }).length)
    const long = counted(Array.from({ length: 100_000 }, () => 1))
    expect(jsonLength(long.list, 2048)).toBe(2049)
    expect(long.reads()).toBeLessThanOrEqual(2048)
  })
})

describe("edits left unmatched by a bound are reported [review7#R7S1-1]", () => {
  test("past MAX_HASHED_ITEMS, edits are not looked up, the store says so until the agent's next state", () => {
    // 1,000 rows; each row's edit names a field of its own, so each asks for a way of comparing of its own, and each way
    // hashes the whole list: past 200,000 items hashed, the rest are not looked up.
    const rows = (extra: number) => [
      ...Array.from({ length: extra }, (_, index) => ({ id: -1 - index, f: {} })),
      ...Array.from({ length: 1000 }, (_, index) => ({ id: index, f: {} })),
    ]
    const store = createTrackedStore()
    store.setBase({ rows: rows(0) })
    for (let index = 0; index < 1000; index++) store.set(`/rows/${index}/f/k${index}`, true)
    let heard = 0
    store.onSkippedWork(() => heard++)
    // A row inserted at the front: every edit's row moved.
    store.setBase({ rows: rows(1) })
    expect(store.editsUnmatched()).toBe(true)
    expect(heard).toBe(1)
    const after = (store.getSnapshot() as { rows: { id: number; f: Record<string, boolean> }[] }).rows
    // The first edits looked up found their rows; the rest (their list changed length) were dropped.
    expect(after[1]).toEqual({ id: 0, f: { k0: true } })
    const kept = after.filter((row) => Object.keys(row.f).length > 0).length
    expect(kept).toBeGreaterThan(150)
    expect(kept).toBeLessThan(250)
    for (const row of after) for (const key of Object.keys(row.f)) expect(key).toBe(`k${row.id}`)
    // The agent's next state needs no lookup: the issue goes.
    store.setBase({ rows: rows(1), other: 1 })
    expect(store.editsUnmatched()).toBe(false)
    expect(heard).toBe(2)
  })
})

describe("edits left unmatched by MAX_RECONCILE_WORK are reported too [review7#R7S1-1]", () => {
  test("past 4 million values visited, an item is not compared or looked up, and the store says so", () => {
    // The agent sends the row's list of 2.1 million numbers again as an equal copy: hashing both copies passes the
    // bound before they are compared.
    const row = (x: number) => ({ big: new Array(2_100_000).fill(0), x })
    const store = createTrackedStore()
    store.setBase({ rows: [row(0)] })
    store.set("/rows/0/y", "mine")
    store.setBase({ rows: [row(1)] })
    expect(store.editsUnmatched()).toBe(true)
    // The list kept its length and nothing about the edit is left to compare: it stays at its index.
    expect((store.getSnapshot() as { rows: { y?: string }[] }).rows[0]!.y).toBe("mine")
  })
})

describe("Matcher compares and hashes as the comparisons it replaces [review7#R7S1-1]", () => {
  // The comparisons reconcile made before, item by item: jsonEqual, and the same apart from the member at `rest`.
  const own = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null && Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key]
      : undefined
  function sameExcept(a: unknown, b: unknown, rest: readonly string[]): boolean {
    if (rest.length === 0) return jsonEqual(a, b)
    if (Object.is(a, b)) return true
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false
    const [head, ...tail] = rest
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key !== head) {
        if (!jsonEqual(own(a, key), own(b, key))) return false
      } else if (tail.length > 0 && !sameExcept(own(a, key), own(b, key), tail)) return false
    }
    return true
  }

  test("on random values with shared and copied parts, equal and sameExcept agree, and hashes follow them", () => {
    const draw = seeded(11)
    const keys = ["a", "b", "c"]
    const shared: unknown[] = []
    const value = (depth: number): unknown => {
      const kind = draw(depth > 3 ? 3 : 6)
      if (kind === 0) return draw(3)
      if (kind === 1) return ["x", "y"][draw(2)]
      if (kind === 2 && shared.length > 0) return shared[draw(shared.length)]
      if (kind === 2) return null
      const made =
        kind === 3
          ? Array.from({ length: draw(3) }, () => value(depth + 1))
          : Object.fromEntries(keys.slice(0, 1 + draw(3)).map((key) => [key, value(depth + 1)]))
      if (draw(3) === 0) shared.push(made)
      return made
    }
    // A copy that may change one member somewhere, or nothing.
    const variant = (input: unknown, depth = 0): unknown => {
      if (typeof input !== "object" || input === null) return draw(6) === 0 ? value(3) : input
      if (draw(4) === 0) return input
      if (Array.isArray(input)) return input.map((item) => variant(item, depth + 1))
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, variant(item, depth + 1)]))
    }
    const rests = [[], ["a"], ["b"], ["0"], ["a", "b"], ["a", "0"], ["0", "a"], ["b", "c", "a"]]
    let same = 0
    for (let round = 0; round < 4000; round++) {
      const a = value(0)
      const b = draw(3) === 0 ? value(0) : variant(a)
      const matcher = new Matcher()
      expect(matcher.equal(a, b)).toBe(jsonEqual(a, b))
      if (jsonEqual(a, b)) expect(matcher.hash(a)).toBe(matcher.hash(b))
      for (const rest of rests) {
        const expected = sameExcept(a, b, rest)
        expect(matcher.sameExcept(a, b, rest)).toBe(expected)
        if (expected && rest.length > 0) {
          same++
          expect(matcher.hashExcept(a, rest)).toBe(matcher.hashExcept(b, rest))
        }
      }
    }
    expect(same).toBeGreaterThan(1000)
  })

  test("values deeper than the compared height cost no stack, and the very same deep value is still equal", () => {
    let chain: unknown = 0
    for (let level = 0; level < 50_000; level++) chain = [chain]
    let copy: unknown = 0
    for (let level = 0; level < 50_000; level++) copy = [copy]
    const matcher = new Matcher()
    expect(matcher.equal(chain, chain)).toBe(true)
    expect(matcher.equal({ deep: chain, x: 1 }, { deep: chain, x: 1 })).toBe(true)
    expect(matcher.equal(chain, copy)).toBe(false)
    expect(matcher.hash({ deep: chain, x: 1 })).toBe(matcher.hash({ deep: copy, x: 1 }))
    expect(matcher.sameExcept({ deep: chain, x: 1 }, { deep: chain, x: 2 }, ["x"])).toBe(true)
    expect(matcher.hashExcept({ deep: chain, x: 1 }, ["x"])).toBe(matcher.hashExcept({ deep: chain, x: 2 }, ["x"]))
  })
})

describe("a child renderer is charged its element's size where it is built [review7#R7S1-3]", () => {
  const flatten = (value: unknown): unknown[] =>
    typeof value === "function"
      ? flatten((value as () => unknown)())
      : Array.isArray(value)
        ? value.flatMap(flatten)
        : value === null || value === undefined
          ? []
          : [value]

  /**
   * Renders `spec` with genui's element renderer inside a surface's render budget, with the spec's elements provided
   * (as each surface does) or not, until no evaluation waits; counts the element renderers json-render built (each
   * resolved its props first).
   */
  async function render(spec: Spec, provided: boolean, state: Record<string, unknown> = {}) {
    const components: Record<string, ElementImpl> = {
      Stack: (ctx) => (() => ctx.children) as never,
      Text: (ctx) => (() => String(ctx.props.text ?? "")) as never,
    }
    const unknown = () => "unknown" as unknown as JSX.Element
    const element = createElementRenderer(components, unknown, { useStateStore, useRepeatScope, RepeatRowsContext })
    let built = 0
    const counting: Component<Parameters<typeof element>[0]> = (props) => {
      built++
      return element(props)
    }
    const registry = buildRegistry(Object.keys(components), counting)
    const budget = createRenderBudget()
    const view = createRoot((dispose) => {
      const renderer = () => createComponent(Renderer, { spec, registry, fallback: counting })
      const tree = createComponent(RenderBudgetContext.Provider, {
        value: budget,
        get children() {
          return createComponent(JSONUIProvider, {
            registry,
            store: createStateStore(state),
            directives: guardDirectives(standardDirectives),
            get children() {
              return provided
                ? createComponent(SpecElementsContext.Provider, {
                    value: () => spec.elements as Record<string, unknown>,
                    get children() {
                      return renderer()
                    },
                  })
                : renderer()
            },
          })
        },
      })
      return { built: () => built, budget, dispose, text: () => flatten(tree).map(String).join(" ") }
    })
    view.text()
    await evaluationsDone()
    view.text()
    return view
  }

  // A child whose one prop holds 40,000 numbers and one expression: json-render resolves it into a list of its own for
  // every instance.
  const big = { type: "Text", props: { text: "x", data: [{ $state: "/a" }, ...Array(40_000).fill(0)] }, children: [] }

  test("a child listed 4,000 times is refused at its parent, before any instance is built", async () => {
    const spec = {
      root: "s",
      elements: { s: { type: "Stack", props: {}, children: Array(4000).fill("w") }, w: big },
    } as unknown as Spec
    const charged = await render(spec, true, { a: 1 })
    expect(charged.built()).toBe(1)
    expect(charged.budget.skipped()).toBe(1)
    charged.dispose()
    // Charged one slot each, every instance is built (each holding a list of 40,000 items) before most are refused.
    const fewer = {
      ...spec,
      elements: { ...spec.elements, s: { type: "Stack", props: {}, children: Array(400).fill("w") } },
    }
    const uncharged = await render(fewer as unknown as Spec, false, { a: 1 })
    expect(uncharged.built()).toBe(401)
    uncharged.dispose()
  })

  test("a repeat of such a child renders only the rows its size fits in", async () => {
    const spec = {
      root: "s",
      elements: { s: { type: "Stack", props: {}, children: ["w"], repeat: { statePath: "/rows" } }, w: big },
    } as unknown as Spec
    const charged = await render(spec, true, { a: 1, rows: Array(1999).fill(0) })
    const perRow = childSlots(big)
    expect(perRow).toBe(1 + Math.floor((40_001 + 4 + 1 + 1 + 4 + 5 + 5 + 9 + 4 + 1 + 1 + 8) / TEXT_PER_UNIT))
    // The rows built are those the child slots hold (of which the render budget then shows some); the rest wait.
    expect(charged.built()).toBe(1 + Math.floor(SLOT_UNITS / perRow))
    expect(charged.budget.skipped()).toBeGreaterThan(0)
    charged.dispose()
  })

  test("ordinary children cost about one slot each, and a small repeat all its rows", async () => {
    const small = { type: "Text", props: { text: "a short label" }, children: [] }
    expect(childSlots(small)).toBe(1)
    expect(slotsOf({ children: ["a", "b", "c"] }, 0, () => 1)).toBe(3)
    expect(slotsOf({ children: ["a"], repeat: { statePath: "/x" } }, 500, () => 2)).toBe(1000)
    expect(slotsOf({ children: [], repeat: { statePath: "/x" } }, 500)).toBe(500)
    const spec = {
      root: "s",
      elements: { s: { type: "Stack", props: {}, children: ["w"], repeat: { statePath: "/rows" } }, w: small },
    } as unknown as Spec
    const charged = await render(spec, true, { rows: Array(1500).fill(0) })
    expect(charged.built()).toBe(1501)
    expect(charged.budget.skipped()).toBe(0)
    charged.dispose()
  })
})

describe("every code block a Markdown text renders costs the render budget [review7#R7S1-5]", () => {
  const forms: Record<string, (count: number) => string> = {
    "fences left in the prose": (count) =>
      Array.from({ length: 32 }, () => "```\nown\n```").join("\n") +
      "\n" +
      Array.from({ length: count }, () => "```\nx\n```").join("\n"),
    "quoted fences": (count) => Array.from({ length: count }, () => "> ```\n> x\n> ```").join("\n\n"),
    "list-item fences": (count) => Array.from({ length: count }, () => "- ```\n  x\n  ```").join("\n"),
    "indented code blocks": (count) => `p\n\n${Array.from({ length: count }, () => "    x").join("\n\nq\n\n")}`,
  }

  test("quoted, list-item and indented code blocks cost what fences left in the prose cost", () => {
    // Only top-level fences were counted: 1,000 quoted, list-item or indented code blocks cost nothing, while the app's
    // Markdown builds each as a code block with a toolbar.
    const own = 32 * 4
    expect(textCodeUnits(forms["fences left in the prose"]!(1000))).toBe(own + 1000)
    for (const [name, text] of Object.entries(forms)) {
      if (name === "fences left in the prose") continue
      expect({ name, units: textCodeUnits(text(1000)) }).toEqual({ name, units: 1000 })
    }
  })

  test("prose is not counted, and a block of several indented lines counts once", () => {
    expect(codeBlocks("a paragraph\nanother line")).toEqual({ total: 0, own: 0 })
    // [review8] A math fence is a code block to marked, and the app's code block once past the math budget (display
    // math as well): it counts. (Not counting it let 6,500 math fences past the budget render uncharged.)
    expect(codeBlocks("```math\nx^2\n```")).toEqual({ total: 1, own: 0 })
    expect(codeBlocks("p\n\n    one\n    two\n\n    three\n\nq")).toEqual({ total: 1, own: 0 })
    expect(codeBlocks("p\n\n    one\n\nq\n\n    two")).toEqual({ total: 2, own: 0 })
    expect(codeBlocks("- item\n  - nested item\n    - deeper item")).toEqual({ total: 0, own: 0 })
  })
})

describe("the paragraph cut counts runs as marked lexes them [review7#R7F1-1]", () => {
  const item = (index: number) =>
    `Fixed issue #${1000 + index}: the scheduler no longer drops jobs whose retry window overlaps`
  const shapes: Record<string, string> = {
    "a list nested at 4 spaces": `- **Backend**\n${Array.from({ length: 300 }, (_, i) => `    - ${item(i)}`).join("\n")}`,
    "numbered sub-items": `1. **Steps**\n${Array.from({ length: 300 }, (_, i) => `    1. ${item(i)}`).join("\n")}`,
    "a third level": `- **Backend**\n  - Scheduler\n${Array.from({ length: 300 }, (_, i) => `    - ${item(i)}`).join("\n")}`,
    "a list in a quote": `> Notes:\n${Array.from({ length: 300 }, (_, i) => `> - ${item(i)}`).join("\n")}`,
    "a table": `| Package | Version | Notes |\n|---|---|---|\n${Array.from({ length: 300 }, (_, i) => `| package-${i} | ${i}.2.0 | ${item(i)} |`).join("\n")}`,
    "a quote of several paragraphs": Array.from({ length: 300 }, (_, i) => `> ${item(i)}`).join("\n>\n"),
  }

  test("nested lists, tables and quoted paragraphs of 30 KB show whole", () => {
    // Every line that did not start a top-level list item continued one run: ordinary release notes of 21 to 30 KB
    // were cut at 20,000 characters, though marked lexes each item and each row on its own.
    for (const [name, text] of Object.entries(shapes)) {
      expect(text.length).toBeGreaterThan(MAX_PARAGRAPH)
      expect({ name, cut: shownLength(text) }).toEqual({ name, cut: { shown: text.length } })
    }
  })

  test("one paragraph of 30 KB is still cut, also in a list item or a quote, or as lines marked reads as one paragraph", () => {
    const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ")
    const cut = (text: string) => shownLength(text).reason
    expect(cut(words(4000))).toBe("paragraph")
    expect(cut(`- ${words(4000)}`)).toBe("paragraph")
    expect(cut(`> ${words(4000)}`)).toBe("paragraph")
    // A marker indented 4 spaces or more past where its item's text starts continues that item's paragraph.
    expect(cut(`- x\n${Array.from({ length: 1000 }, () => `          - ${words(4)}`).join("\n")}`)).toBe("paragraph")
    // So does one outside a list, and a table row of 30 KB is cut.
    expect(cut(`Intro\n${Array.from({ length: 1000 }, () => `    - ${words(4)}`).join("\n")}`)).toBe("paragraph")
    expect(cut(`| a |\n|---|\n| ${words(4000)} |`)).toBe("paragraph")
  })
})

describe("the canvas cap judges each block where it is [review7#R7F1-2]", () => {
  // A session of 33 agent messages, each opening canvas taskN (the 33rd is refused); then task1 closes, task33 gets a
  // patch, and task33 is sent again whole.
  const whole = (index: number) =>
    [
      JSON.stringify({ canvas: `task${index}`, title: `Task ${index}` }),
      JSON.stringify({ op: "add", path: "/root", value: "t" }),
      JSON.stringify({ op: "add", path: "/elements/t", value: { type: "Text", props: { text: `body ${index}` } } }),
    ].join("\n")
  const block = (message: number, canvas: string, body: string): CanvasBlock => ({
    ref: { messageID: `msg_${String(message).padStart(3, "0")}`, part: 0, ordinal: 0 },
    canvas,
    block: parseBlock(body),
    closed: true,
    complete: true,
  })
  const blocks: CanvasBlock[] = []
  for (let index = 1; index <= 33; index++) blocks.push(block(index, `task${index}`, whole(index)))
  blocks.push(block(34, "task1", JSON.stringify({ canvas: "task1", close: true })))
  blocks.push(
    block(
      35,
      "task33",
      [
        JSON.stringify({ canvas: "task33" }),
        JSON.stringify({ op: "replace", path: "/elements/t/props/text", value: "updated" }),
      ].join("\n"),
    ),
  )
  blocks.push(block(36, "task33", whole(33)))

  // The snapshots the app holds after each step when it loads only the newest 10 messages.
  const held = (upto: number) => {
    let base: Record<string, CanvasSnapshot> = {}
    for (let step = 1; step <= upto; step++) {
      const result = foldCanvases(base, blocks.slice(Math.max(0, step - 10), step))
      const next: Record<string, CanvasSnapshot> = { ...base }
      for (const state of result.canvases.values()) if (state.settled) next[state.id] = state.settled
      for (const id of result.removed) delete next[id]
      base = next
    }
    return base
  }

  test("after a backfill, a canvas the agent closed is not refused, and the resent canvas leaves none refused", () => {
    // Before: the backfilled fold judged task1's first block by the 32 canvases of the base, task33 among them, which
    // opened after it: task1 was refused (and then closed), and the newest canvas said one canvas was not opened.
    const backfilled = foldCanvases(held(36), blocks)
    expect([...backfilled.refused]).toEqual([])
    expect(backfilled.canvases.size).toBe(MAX_CANVASES)
    expect(backfilled.canvases.has("task33")).toBe(true)
    expect([...backfilled.removed]).toEqual(["task1"])
  })

  test("a closed canvas is never refused, and a patch to a refused canvas is refused too, not missing its base", () => {
    const loaded = (upto: number) => foldCanvases({}, blocks.slice(0, upto))
    expect([...loaded(33).refused]).toEqual(["task33"])
    // The patch after task1 closed: task33 was never opened, so the patch is not applied (it showed "missing its
    // base", with a rescan that could not help).
    const patched = loaded(35)
    expect(patched.canvases.has("task33")).toBe(false)
    expect([...patched.refused]).toEqual(["task33"])
    // Sent again whole, it opens.
    const resent = loaded(36)
    expect(resent.canvases.get("task33")?.missingBase).toBe(false)
    expect([...resent.refused]).toEqual([])
    // A refused canvas the agent then closes is not refused.
    const closedToo = foldCanvases({}, [
      ...blocks.slice(0, 33),
      block(34, "task33", JSON.stringify({ canvas: "task33", close: true })),
    ])
    expect([...closedToo.refused]).toEqual([])
  })
})
