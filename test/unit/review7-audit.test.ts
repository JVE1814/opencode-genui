import { describe, expect, test } from "bun:test"
import { createComponent, createRoot, type Context, type JSX } from "solid-js"
import { createStateStore, type Spec } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import { CODE_PART_UNITS, domUnits } from "../../src/gui/costs.ts"
import {
  buildRegistry,
  createElementRenderer,
  createRenderBudget,
  elementUnits,
  guardDirectives,
  MAX_DEPTH,
  RENDER_UNITS,
  RenderBudgetContext,
  type ElementImpl,
} from "../../src/gui/element.ts"
import { listCut } from "../../src/gui/issues.ts"
import { codeBlocks, MAX_CODE_PARTS, splitMarkdown } from "../../src/gui/components/markdown.ts"
import { compileSpec } from "../../src/protocol/compile.ts"
import { foldCanvases, MAX_CANVASES, type CanvasBlock } from "../../src/protocol/fold.ts"
import { MAX_ELEMENT_PROPS, MAX_WATCH_PATHS, normalizeSpec } from "../../src/protocol/normalize.ts"
import {
  applyPatch,
  applyPatches,
  EMPTY_SPEC,
  MAX_POINTER_DEPTH,
  MAX_POINTER_LENGTH,
  parsePointer,
} from "../../src/protocol/patch.ts"
import { parseBlock } from "../../src/protocol/surface.ts"
import { createTrackedStore } from "../../src/runtime/state.ts"

// Regression tests for the seventh review's cost audit ([review7#R7A-<n>]): work a spec of about 100 KB could give the
// window that no bound counted. See test/e2e/review7-audit.spec.ts for the same in the playground.

const globals = globalThis as { window?: unknown }
globals.window = { document: { addEventListener() {} } }
const solid = await import("@json-render/solid")
delete globals.window
const { JSONUIProvider, Renderer } = solid
type RenderErrorReport = (error: unknown, type: unknown) => void
const { RenderErrorContext } = solid as unknown as {
  readonly RenderErrorContext: Context<RenderErrorReport | undefined>
}

const flatten = (value: unknown): unknown[] =>
  typeof value === "function"
    ? flatten((value as () => unknown)())
    : Array.isArray(value)
      ? value.flatMap(flatten)
      : value === null || value === undefined
        ? []
        : [value]

/** Renders `spec` with genui's element renderer inside a surface's render budget; `report` hears render errors. */
function render(spec: Spec, report?: RenderErrorReport) {
  const components: Record<string, ElementImpl> = {
    Box: (ctx) => (() => ctx.children) as never,
    Text: (ctx) => (() => String(ctx.props.text ?? "")) as never,
    Boom: () => {
      throw new Error("the component broke")
    },
  }
  const element = createElementRenderer(components, () => "unknown" as unknown as JSX.Element)
  const registry = buildRegistry(Object.keys(components), element)
  const budget = createRenderBudget()
  return createRoot((dispose) => {
    const tree = createComponent(RenderBudgetContext.Provider, {
      value: budget,
      get children() {
        return createComponent(JSONUIProvider, {
          registry,
          store: createStateStore({}),
          directives: guardDirectives(standardDirectives),
          get children() {
            return createComponent(RenderErrorContext.Provider, {
              value: report,
              get children() {
                return createComponent(Renderer, { spec, registry, fallback: element })
              },
            })
          },
        })
      },
    })
    return { text: () => flatten(tree).map(String).join(" "), budget, dispose }
  })
}

const timed = <T>(run: () => T): { readonly ms: number; readonly value: T } => {
  const started = performance.now()
  const value = run()
  return { ms: performance.now() - started, value }
}

describe("spec validation checks repeat paths in time linear in the spec [review7#R7A-1]", () => {
  // Two repeating Stacks per layer, each listing both elements of the next layer, with relative repeat paths: json-render's
  // validateSpec visited each element once per distinct base path from the root, 2^L of them (a 6 KB block froze the
  // window for 23 s on arrival, and a streamed canvas paid it again on every delta).
  const lattice = (layers: number, state: Record<string, unknown> = { x: [] }): Spec => {
    const elements: Record<string, unknown> = {
      root: { type: "Stack", props: {}, children: ["a1", "b1"], repeat: { statePath: "/x" } },
      leaf: { type: "Text", props: { text: "leaf" }, children: [] },
    }
    for (let layer = 1; layer <= layers; layer++) {
      const children = layer < layers ? [`a${layer + 1}`, `b${layer + 1}`] : ["leaf"]
      elements[`a${layer}`] = { type: "Stack", props: {}, children, repeat: { statePath: { $item: "a" } } }
      elements[`b${layer}`] = { type: "Stack", props: {}, children, repeat: { statePath: { $item: "b" } } }
    }
    return { root: "root", elements, state } as unknown as Spec
  }
  const codes = (spec: Spec) =>
    compileSpec(spec)
      .issues.map((issue) => `${issue.code}:${issue.elementKey ?? ""}`)
      .sort()

  test("a lattice of 20 layers compiles in milliseconds, with the issues of a lattice of 3", () => {
    // HEAD: about 9 s for 20 layers in bun.
    const { ms, value } = timed(() => codes(lattice(20)))
    expect(ms).toBeLessThan(100)
    expect(value).toEqual(codes(lattice(3)))
  })

  test("the sample check still follows real lists in state", () => {
    // A state that holds the lists along `a` (not `b`): every b_i repeats over a path that holds no list.
    let nested: unknown[] = []
    for (let layer = 0; layer < 6; layer++) nested = [{ a: nested, b: "not a list" }]
    const issues = compileSpec(lattice(6, { x: nested })).issues.filter(
      (issue) => issue.code === "repeat_state_mismatch",
    )
    expect(issues.map((issue) => issue.elementKey).sort()).toEqual(["b1", "b2", "b3", "b4", "b5", "b6"])
    expect(issues.find((issue) => issue.elementKey === "b2")?.message).toContain('"/x/0/a/0/b"')
  })
})

describe("a JSON pointer has at most MAX_POINTER_DEPTH segments and MAX_POINTER_LENGTH characters [review7#R7A-3]", () => {
  const deep = (depth: number) => "/a".repeat(depth)

  test("a 50,000-segment pointer is refused in microseconds, wherever it is parsed", () => {
    // HEAD: setAt and removeAt recursed once per segment, copying the rest of the path at each level: 6.4 s and 1.3 GB
    // on arrival, then a stack overflow (and a renderer crash on a click).
    const path = deep(50_000)
    expect(parsePointer(path)).toBeUndefined()
    const spec = { root: "t", elements: {}, state: {} }
    const added = timed(() => applyPatch(spec, { op: "add", path: `/state${path}`, value: 1 }))
    expect(added.ms).toBeLessThan(20)
    expect(added.value).toBe(spec)
    expect(timed(() => applyPatches(EMPTY_SPEC, [{ op: "remove", path: `/state${path}` }])).ms).toBeLessThan(20)

    const store = createTrackedStore()
    store.setBase({ a: 1 })
    expect(timed(() => store.set(path, 1)).ms).toBeLessThan(20)
    expect(timed(() => store.update({ [path]: 1 })).ms).toBeLessThan(20)
    expect(store.getSnapshot()).toEqual({ a: 1 })
    expect(store.overrides()).toEqual([])
  })

  test("a patch line with such a pointer is a line error, and the block's other lines still apply", () => {
    const block = parseBlock(
      [
        JSON.stringify({ op: "add", path: "/root", value: "t" }),
        JSON.stringify({ op: "add", path: `/state${deep(MAX_POINTER_DEPTH)}`, value: 1 }),
        JSON.stringify({ op: "copy", from: `/state/${"x".repeat(MAX_POINTER_LENGTH)}`, path: "/state/b" }),
        JSON.stringify({
          op: "add",
          path: "/elements/t",
          value: { type: "Text", props: { text: "ok" }, children: [] },
        }),
      ].join("\n"),
    )
    expect(block.patches.map((patch) => patch.path)).toEqual(["/root", "/elements/t"])
    expect(block.errors.map((error) => error.line)).toEqual([2, 3])
    expect(block.errors[0]!.message).toContain(`${MAX_POINTER_DEPTH}`)
  })

  test("the validator reports a state path the spec writes out that is too deep or long", () => {
    const spec = (statePath: string) =>
      ({
        root: "b",
        elements: {
          b: {
            type: "Button",
            props: { label: "Go" },
            children: [],
            on: { press: { action: "setState", params: { statePath, value: 1 } } },
          },
        },
      }) as unknown as Spec
    const issue = compileSpec(spec(deep(MAX_POINTER_DEPTH + 1))).issues.find((found) => found.code === "path_too_large")
    expect(issue?.elementKey).toBe("b")
    expect(issue?.message).toContain("on.press's statePath")
    expect(compileSpec(spec("/a/b")).issues.some((found) => found.code === "path_too_large")).toBe(false)
  })

  test("pointers within the bounds work as before, at the bound too", () => {
    const path = deep(MAX_POINTER_DEPTH - 1)
    expect(parsePointer(path)?.length).toBe(MAX_POINTER_DEPTH - 1)
    const spec = applyPatch({ state: {} } as Record<string, unknown>, { op: "add", path: `/state${path}`, value: 7 })
    let node: unknown = (spec as { state: unknown }).state
    for (let level = 0; level < MAX_POINTER_DEPTH - 1; level++) node = (node as { a: unknown }).a
    expect(node).toBe(7)
    const removed = applyPatch(spec, { op: "remove", path: `/state${path}` })
    expect(JSON.stringify(removed)).not.toContain("7")
    expect(parsePointer(`/${"k".repeat(MAX_POINTER_LENGTH - 1)}`)).toEqual(["k".repeat(MAX_POINTER_LENGTH - 1)])
    expect(parsePointer(`/${"k".repeat(MAX_POINTER_LENGTH)}`)).toBeUndefined()

    const store = createTrackedStore()
    store.setBase({})
    store.set(deep(10), true)
    expect(store.get(deep(10))).toBe(true)
  })

  test("an agent canvas patch with such a pointer folds without throwing", () => {
    const blocks: CanvasBlock[] = [
      `{"canvas":"d"}\n{"op":"add","path":"/root","value":"t"}\n{"op":"add","path":"/elements/t","value":{"type":"Text","props":{},"children":[]}}`,
      `{"canvas":"d"}\n${JSON.stringify({ op: "add", path: `/state${deep(50_000)}`, value: 1 })}`,
    ].map((body, index) => ({
      ref: { messageID: `msg_${index}`, part: 0, ordinal: 0 },
      canvas: "d",
      block: parseBlock(body),
      closed: true,
      complete: true,
    }))
    const { ms, value } = timed(() => foldCanvases({}, blocks))
    expect(ms).toBeLessThan(50)
    expect(value.canvases.get("d")?.lineErrors.length).toBe(1)
  })
})

describe("what json-render does per instance of an element is bounded by the element's size [review7#R7A-2, R7A-5]", () => {
  test("an element watches at most MAX_WATCH_PATHS paths; the rest are dropped and reported", () => {
    // json-render subscribed every watched path for every instance (each child entry, each row), hidden or not: 4,000
    // entries of an element watching 7,000 paths froze the window for 11 s.
    const watch = Object.fromEntries(Array.from({ length: 7000 }, (_, index) => [`/p${index}`, {}]))
    const spec = {
      root: "s",
      elements: {
        s: { type: "Stack", props: {}, children: ["w", "w"] },
        w: { type: "Text", props: { text: "x" }, children: [], watch },
      },
    } as unknown as Spec
    const normalized = normalizeSpec(spec)
    expect(Object.keys((normalized.elements.w as { watch: object }).watch)).toEqual(
      Array.from({ length: MAX_WATCH_PATHS }, (_, index) => `/p${index}`),
    )
    const issue = compileSpec(spec).issues.find((found) => found.code === "too_many_watches")
    expect(issue?.elementKey).toBe("w")
    expect(issue?.message).toContain("7,000")
  })

  test("an element keeps at most MAX_ELEMENT_PROPS props, its component's own first; the rest are dropped and reported", () => {
    // Every instance resolved every prop into a props object of its own before genui's budget refused it: 4,000 entries
    // of a Text with 7,000 props took 5.7 s in one task and 850 MB.
    const props: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 7000 }, (_, index) => [`k${index}`, 0]),
    )
    props.text = "shown"
    const spec = {
      root: "w",
      elements: { w: { type: "Text", props, children: [] } },
    } as unknown as Spec
    const kept = (normalizeSpec(spec).elements.w as { props: Record<string, unknown> }).props
    expect(Object.keys(kept).length).toBe(MAX_ELEMENT_PROPS)
    expect(kept.text).toBe("shown")
    const issue = compileSpec(spec).issues.find((found) => found.code === "too_many_props")
    expect(issue?.elementKey).toBe("w")
    expect(issue?.message).toContain("7,001")
  })

  test("ordinary elements keep all their props and watched paths", () => {
    const props = Object.fromEntries(Array.from({ length: MAX_ELEMENT_PROPS }, (_, index) => [`k${index}`, index]))
    const watch = Object.fromEntries(Array.from({ length: MAX_WATCH_PATHS }, (_, index) => [`/p${index}`, {}]))
    const spec = { root: "w", elements: { w: { type: "Text", props, children: [], watch } } } as unknown as Spec
    const element = normalizeSpec(spec).elements.w as { props: object; watch: object }
    expect(element.props).toBe(props)
    expect(Object.keys(element.watch)).toEqual(Object.keys(watch))
    expect(compileSpec(spec).issues.filter((issue) => issue.code.startsWith("too_many"))).toEqual([])
  })
})

describe("a Markdown text mounts at most MAX_CODE_PARTS code blocks of its own, each charged [review7#R7A-4]", () => {
  const fences = (count: number) => Array.from({ length: count }, (_, index) => `\`\`\`\nx${index}\n\`\`\``).join("\n")

  test("fences past MAX_CODE_PARTS stay in the Markdown around them, which shows them as code", () => {
    // Each fence became a host ui.Code of its own while the element was charged by its length: 3,900 fences in 40,000
    // characters built 3,900 code blocks in one element (46,800 and 1.4 s tasks for 12 such elements).
    const parts = splitMarkdown(fences(3900))
    expect(parts.filter((part) => part.kind === "code").length).toBe(MAX_CODE_PARTS)
    const rest = parts.filter((part) => part.kind === "markdown")
    expect(rest.length).toBe(1)
    expect(rest[0]!.kind === "markdown" && rest[0]!.text.split("```").length).toBe(2 * (3900 - MAX_CODE_PARTS) + 1)
    expect(rest[0]!.kind === "markdown" && rest[0]!.text.endsWith("x3899\n```")).toBe(true)
    // A few fences are code blocks as before.
    expect(splitMarkdown(`a\n${fences(3)}\nb`).map((part) => part.kind)).toEqual([
      "markdown",
      "code",
      "code",
      "code",
      "markdown",
    ])
  })

  test("each code block costs the render budget: CODE_PART_UNITS on its own, a unit in the prose", () => {
    expect(codeBlocks(fences(3900))).toEqual({ total: 3900, own: MAX_CODE_PARTS })
    expect(codeBlocks(fences(3))).toEqual({ total: 3, own: 3 })
    expect(codeBlocks("no code `here`")).toEqual({ total: 0, own: 0 })
    expect(domUnits("Markdown", { content: fences(100) })).toBe(MAX_CODE_PARTS * CODE_PART_UNITS + 100 - MAX_CODE_PARTS)
    expect(domUnits("Popover", { trigger: "t", content: fences(2) })).toBe(2 * CODE_PART_UNITS)
    const items = Array.from({ length: 10 }, () => ({ title: "t", content: fences(5) }))
    const plain = items.map((item) => ({ title: item.title }))
    expect(domUnits("Accordion", { items }) - domUnits("Accordion", { items: plain })).toBe(10 * 5 * CODE_PART_UNITS)
    expect(domUnits("Markdown", { content: "plain" })).toBe(0)
    // 3,900 fences in 40 KB are more than a surface renders: the element is refused (and the surface says so).
    expect(elementUnits({ type: "Markdown", props: { content: fences(3900) } })).toBeGreaterThan(RENDER_UNITS)
  })
})

describe("the user's edits below a list item follow it in time linear in the list [review7#R7A-6]", () => {
  test("2,000 nested edits after a select-all follow 3,500 rows the agent rewrote, in milliseconds", () => {
    // The lookup bucketed rows by their hash without the edit's first member, but accepted only rows equal below it:
    // rows that differed only there shared one bucket, and every agent patch cost edits × rows (2.2 s).
    const rows = (shift: number) => Array.from({ length: 3500 }, (_, index) => ({ a: { b: false, c: index + shift } }))
    const store = createTrackedStore()
    store.setBase({ all: true, rows: rows(0) })
    for (let index = 0; index < 2000; index++) store.set(`/rows/${index}/a/b`, true)
    for (const shift of [100_000, 200_000]) {
      const { ms } = timed(() => store.setBase({ all: true, rows: rows(shift) }))
      expect(ms).toBeLessThan(150)
    }
    // Every row's c changed, so no row is the one an edit was made on: as before, an edit stays at its index (the list
    // kept its length), and since the agent did not change b there, the user's tick stays.
    const snapshot = store.getSnapshot() as { rows: { a: { b: boolean; c: number } }[] }
    expect(snapshot.rows[0]).toEqual({ a: { b: true, c: 200_000 } })
    expect(snapshot.rows.filter((row) => row.a.b).length).toBe(2000)
  })

  test("an edit below a member follows its row when the agent moves it, also among rows that differ only there", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ a: { b: false, c: index } }))
    const store = createTrackedStore()
    store.setBase({ rows })
    store.set("/rows/10/a/b", true)
    // Two rows inserted before it: the edit's row (c = 10) is now at index 12.
    store.setBase({ rows: [{ a: { b: false, c: -1 } }, { a: { b: false, c: -2 } }, ...rows] })
    const after = (store.getSnapshot() as { rows: { a: { b: boolean; c: number } }[] }).rows
    expect(after[12]).toEqual({ a: { b: true, c: 10 } })
    expect(after.filter((row) => row.a.b).length).toBe(1)
  })
})

describe("a session shows at most MAX_CANVASES canvases at once [review7#R7A-8]", () => {
  const blocks = (count: number, close: readonly number[] = []) =>
    Array.from({ length: count }, (_, index): CanvasBlock => {
      const id = `c${index}`
      return {
        ref: { messageID: "msg_1", part: 0, ordinal: index },
        canvas: id,
        block: parseBlock(
          close.includes(index)
            ? `{"canvas":"${id}","close":true}`
            : `{"canvas":"${id}"}\n{"root":"t","elements":{"t":{"type":"Text","props":{},"children":[]}}}`,
        ),
        closed: true,
        complete: false,
      }
    })

  test("a message that opens 1,100 canvases opens the first MAX_CANVASES; the others are refused", () => {
    // A 99 KB streamed reply opened 1,100 tabs and kept the window 81% busy for 85 s.
    const { value, ms } = timed(() => foldCanvases({}, blocks(1100)))
    expect(ms).toBeLessThan(200)
    expect([...value.canvases.keys()]).toEqual(Array.from({ length: MAX_CANVASES }, (_, index) => `c${index}`))
    expect(value.refused.size).toBe(1100 - MAX_CANVASES)
    expect(value.refused.has(`c${MAX_CANVASES}`)).toBe(true)
  })

  test("a closed canvas makes room for a new one", () => {
    const all = blocks(MAX_CANVASES + 1)
    // c0 closes before the last one opens.
    const closing: CanvasBlock = {
      ref: { messageID: "msg_1", part: 0, ordinal: MAX_CANVASES - 0.5 },
      canvas: "c0",
      block: parseBlock('{"canvas":"c0","close":true}'),
      closed: true,
      complete: false,
    }
    const value = foldCanvases({}, [...all.slice(0, MAX_CANVASES), closing, all[MAX_CANVASES]!])
    expect(value.canvases.size).toBe(MAX_CANVASES)
    expect(value.canvases.has(`c${MAX_CANVASES}`)).toBe(true)
    expect(value.refused.size).toBe(0)
    expect(value.removed.has("c0")).toBe(true)
  })
})

describe("issue texts [review7]", () => {
  test("a list cut names its component with the right article", () => {
    expect(listCut("Accordion", 7000).message).toContain("an Accordion shows at most 500")
    expect(listCut("Radio", 7000).message).toContain("a Radio shows at most 200")
  })
})

describe("nesting is bounded, and an element that cannot render is said so [review7#R7A-7]", () => {
  const chain = (levels: number): Spec => {
    const elements: Record<string, unknown> = { leaf: { type: "Text", props: { text: "leaf" }, children: [] } }
    for (let level = 0; level < levels; level++)
      elements[`e${level}`] = { type: "Box", props: {}, children: [level + 1 < levels ? `e${level + 1}` : "leaf"] }
    return { root: "e0", elements } as unknown as Spec
  }

  test("elements nested deeper than MAX_DEPTH render nothing, and the surface counts them", () => {
    // Past about 50 levels the stack overflowed and the rest of the UI vanished, with nothing said.
    const deep = render(chain(100))
    expect(deep.text()).not.toContain("leaf")
    expect(deep.budget.tooDeep()).toBe(1)
    deep.dispose()
    expect(deep.budget.tooDeep()).toBe(0)
    // The leaf of a chain of MAX_DEPTH - 1 boxes is at depth MAX_DEPTH: it renders.
    const shallow = render(chain(MAX_DEPTH - 1))
    expect(shallow.text()).toContain("leaf")
    expect(shallow.budget.tooDeep()).toBe(0)
    shallow.dispose()
  })

  test("an element whose component throws is told to the host, and its siblings render", () => {
    // json-render's boundary only logged: the element vanished with no issue.
    const error = console.error
    console.error = () => {}
    try {
      const reports: [string, unknown][] = []
      const view = render(
        {
          root: "box",
          elements: {
            box: { type: "Box", props: {}, children: ["boom", "text"] },
            boom: { type: "Boom", props: {}, children: [] },
            text: { type: "Text", props: { text: "still here" }, children: [] },
          },
        } as unknown as Spec,
        (thrown, type) => reports.push([String((thrown as Error).message), type]),
      )
      expect(view.text()).toContain("still here")
      expect(reports).toEqual([["the component broke", "Boom"]])
      view.dispose()
    } finally {
      console.error = error
    }
  })
})
