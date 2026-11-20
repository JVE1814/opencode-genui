import { describe, expect, test } from "bun:test"
import { createComponent, createComputed, createRoot, createSignal, type JSX } from "solid-js"
import { createStateStore, type Spec, type StateStore } from "@json-render/core"
import type { BaseComponentProps, ComponentRegistry } from "@json-render/solid"
import { createTrackedStore, MAX_EDIT_SIZE } from "../../src/runtime/state.ts"
import {
  buildRegistry,
  createElementRenderer,
  createRenderBudget,
  RENDER_UNITS,
  RenderBudgetContext,
  TEXT_PER_UNIT,
  type ElementImpl,
  type RenderBudget,
} from "../../src/gui/element.ts"

// json-render's real renderer, without a DOM: components return strings, and the rendered tree is a nest of accessors
// and arrays that `text()` flattens. @json-render/solid only touches the DOM at load, to delegate events, so a stub
// `window.document` is in place for the import and removed right after.
const globals = globalThis as { window?: unknown }
globals.window = { document: { addEventListener() {} } }
const { JSONUIProvider, Renderer, useStateStore } = await import("@json-render/solid")
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

/** Renders `spec` with genui's element renderer over components that record each mount. */
function render(
  spec: () => Spec,
  state: Record<string, unknown>,
  components: Record<string, ElementImpl>,
  directives?: readonly unknown[],
  budget?: RenderBudget,
  given?: StateStore,
): Mounted {
  const mounts: string[] = []
  const recorded = Object.fromEntries(
    Object.entries(components).map(([name, impl]): [string, ElementImpl] => [
      name,
      (ctx) => {
        mounts.push(name)
        return impl(ctx)
      },
    ]),
  )
  const unknown = () => "unknown" as unknown as JSX.Element
  const element = createElementRenderer(recorded, unknown)
  const registry: ComponentRegistry = buildRegistry(Object.keys(components), element)
  const store = given ?? createStateStore(state)
  return createRoot((dispose) => {
    const provider = () =>
      createComponent(JSONUIProvider, {
        registry,
        store,
        ...(directives ? { directives: directives as never } : {}),
        get children() {
          return createComponent(Renderer, {
            get spec() {
              return spec()
            },
            registry,
            fallback: element,
          })
        },
      })
    const tree = budget
      ? createComponent(RenderBudgetContext.Provider, {
          value: budget,
          get children() {
            return provider()
          },
        })
      : provider()
    return { text: () => flatten(tree).map(String), store, mounts, dispose }
  })
}

/** How many times each component mounted (a container mounts after its children). */
const count = (mounts: readonly string[]) =>
  mounts.reduce<Record<string, number>>((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {})
const str = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? ""))
const Box: ElementImpl = (ctx: BaseComponentProps) => (() => [`<${str(ctx.props.title)}>`, ctx.children]) as never
const Field: ElementImpl = (ctx: BaseComponentProps) =>
  (() => `${str(ctx.props.label)}=${str(ctx.props.value)}@${ctx.bindings?.value ?? ""}`) as never

describe("rendering with json-render", () => {
  test("children stay mounted while their container's resolved props change", () => {
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: { $template: "Hello ${/name}" } }, children: ["field"] },
        field: { type: "Field", props: { label: "Name", value: { $bindState: "/name" } }, children: [] },
      },
    }
    const view = render(() => spec, { name: "" }, { Box, Field })
    for (const name of ["a", "ab", "abc"]) view.store.set("/name", name)
    expect(view.text()).toEqual(["<Hello abc>", "Name=abc@/name"])
    // Without the element renderer's stable children, every write re-created the Field (and its input).
    expect(count(view.mounts)).toEqual({ Box: 1, Field: 1 })
    view.dispose()
  })

  test("a repeat row stays mounted while the user writes to its item", () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/todos" } },
        row: { type: "Field", props: { label: { $item: "id" }, value: { $bindItem: "title" } }, children: [] },
      },
    }
    const view = render(
      () => spec,
      {
        todos: [
          { id: "a", title: "one" },
          { id: "b", title: "two" },
        ],
      },
      { Box, Field },
    )
    for (const title of ["onex", "onexy", "onexyz"]) view.store.set("/todos/0/title", title)
    expect(view.text()).toEqual(["<list>", "a=onexyz@/todos/0/title", "b=two@/todos/1/title"])
    // json-render keyed rows by item identity, so each write (a new item object) re-created the row.
    expect(count(view.mounts)).toEqual({ Box: 1, Field: 2 })
    view.dispose()
  })

  test("rows with repeat.key follow their item when the list is reordered, and write to its new index", () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/todos", key: "id" } },
        row: { type: "Field", props: { label: { $item: "id" }, value: { $bindItem: "title" } }, children: [] },
      },
    }
    const rows: string[] = []
    const Tracked: ElementImpl = (ctx) => {
      const id = str(ctx.props.label)
      createComputed(() => rows.push(`${id}:${str(ctx.props.label)}`))
      return Field(ctx)
    }
    const view = render(
      () => spec,
      {
        todos: [
          { id: "a", title: "alpha" },
          { id: "b", title: "beta" },
          { id: "c", title: "gamma" },
        ],
      },
      { Box, Field: Tracked },
    )
    view.store.set("/todos", [
      { id: "c", title: "gamma" },
      { id: "a", title: "alpha" },
      { id: "d", title: "delta" },
    ])
    expect(view.text()).toEqual([
      "<list>",
      "c=gamma@/todos/0/title",
      "a=alpha@/todos/1/title",
      "d=delta@/todos/2/title",
    ])
    // a, b and c mounted once; only d is new. Each kept row still shows its own item.
    expect(count(view.mounts)).toEqual({ Box: 1, Field: 4 })
    expect(rows.filter((row) => !row.startsWith("d")).every((row) => row.split(":")[0] === row.split(":")[1])).toBe(
      true,
    )
    view.dispose()
  })

  test("rows without a key are kept by position", () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/items" } },
        row: { type: "Field", props: { label: "item", value: { $bindItem: "name" } }, children: [] },
      },
    }
    const view = render(() => spec, { items: [{ name: "x" }, { name: "y" }, { name: "z" }] }, { Box, Field })
    view.store.set("/items", [{ name: "y" }, { name: "z" }])
    expect(view.text()).toEqual(["<list>", "item=y@/items/0/name", "item=z@/items/1/name"])
    expect(count(view.mounts)).toEqual({ Box: 1, Field: 3 })
    view.dispose()
  })

  test("a patch that changes an element's type at the same key renders the new component", () => {
    const box = { type: "Box", props: { title: "t" }, children: ["status"] }
    const [spec, setSpec] = createSignal<Spec>({
      root: "box",
      elements: { box, status: { type: "KanbanBoard", props: {}, children: [] } },
    })
    const view = render(spec, {}, { Box, Field })
    expect(view.text()).toEqual(["<t>", "unknown"])
    // The same key with a new type, as a canvas patch (or the agent's fix) produces it.
    setSpec({
      root: "box",
      elements: { box, status: { type: "Field", props: { label: "s", value: "v" }, children: [] } },
    })
    expect(view.text()).toEqual(["<t>", "s=v@"])
    setSpec({ root: "box", elements: { box, status: { type: "Box", props: { title: "now a box" }, children: [] } } })
    expect(view.text()).toEqual(["<t>", "<now a box>"])
    expect(count(view.mounts)).toEqual({ Box: 2, Field: 1 })
    view.dispose()
  })

  test("an unkeyed row keeps its own state when an item before it is removed (the other items unchanged)", () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/items" } },
        row: { type: "Note", props: { name: { $item: "name" } }, children: [] },
      },
    }
    let mounted = 0
    // A row's own state (a note typed into an unbound input, an open section): here, the order it mounted in.
    const Note: ElementImpl = (ctx) => {
      const id = mounted++
      return (() => `${id}:${str(ctx.props.name)}`) as never
    }
    const items = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }]
    const view = render(() => spec, { items }, { Box, Note })
    expect(view.text()).toEqual(["<list>", "0:alpha", "1:beta", "2:gamma"])
    // removeState filters the array: the remaining items are the same objects.
    view.store.set("/items", items.slice(1))
    expect(view.text()).toEqual(["<list>", "1:beta", "2:gamma"])
    view.dispose()
  })

  test("a row stays mounted while the user edits the very field repeat.key names", () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: {
          type: "Box",
          props: { title: "list" },
          children: ["row"],
          repeat: { statePath: "/todos", key: "title" },
        },
        row: { type: "Field", props: { label: "t", value: { $bindItem: "title" } }, children: [] },
      },
    }
    const view = render(() => spec, { todos: [{ title: "one" }, { title: "two" }] }, { Box, Field })
    for (const title of ["onex", "onexy", "onexyz"]) view.store.set("/todos/0/title", title)
    expect(view.text()).toEqual(["<list>", "t=onexyz@/todos/0/title", "t=two@/todos/1/title"])
    expect(count(view.mounts)).toEqual({ Box: 1, Field: 2 })
    view.dispose()
  })

  test("rows over equal primitives or a shared object stay mounted while the user edits one of them", () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/items" } },
        row: { type: "Field", props: { label: "e", value: { $bindItem: "" } }, children: [] },
      },
    }
    // Empty strings (a list of e-mail fields), booleans (switches), and one object twice (a patch `copy`).
    const shared = { done: false }
    for (const [items, path, values] of [
      [["", "", ""], "/items/1", ["a", "ab", "abc"]],
      [["", "", ""], "/items/0", ["a", "ab"]],
      [[false, false, false], "/items/1", [true, false, true]],
      [[shared, { done: true }, shared], "/items/0", [{ done: true }, { done: false }]],
    ] as const) {
      const view = render(() => spec, { items }, { Box, Field })
      for (const value of values) view.store.set(path, value)
      // Before, the edited row took a new id (an unedited duplicate took its old one) and remounted on each write.
      expect(count(view.mounts)).toEqual({ Box: 1, Field: 3 })
      view.dispose()
    }
  })

  test("a watch is not woken by its own writes: one change runs it once, its whole action list", async () => {
    // Upstream, a watch that writes the path it watches ran again on its own write, through a microtask only, so the
    // window froze. Then a bound of 64 runs per task still ran the action list 64 times: 64 × K writes for one change.
    const toggle = (index: number) => ({
      action: "setState",
      params: { statePath: "/t", value: index % 2 === 0 },
    })
    const spec: Spec = {
      root: "box",
      elements: {
        box: {
          type: "Kick",
          props: {},
          children: [],
          watch: { "/t": [{ action: "validateForm" }, ...Array.from({ length: 200 }, (_, index) => toggle(index))] },
        },
      },
    }
    let set: ((path: string, value: unknown) => void) | undefined
    const Kick: ElementImpl = () => {
      set = useStateStore().set
      return "kick" as never
    }
    const view = render(() => spec, { t: true }, { Kick })
    let writes = 0
    view.store.subscribe(() => writes++)
    set!("/t", false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The change, validateForm's result, then the 200 toggles.
    expect(writes).toBe(1 + 1 + 200)
    // The next change runs the watch again (its first toggle now writes the value /t already has).
    set!("/t", !view.store.get("/t"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(writes).toBe(202 + 1 + 1 + 199)
    view.dispose()
  })

  test("watches that keep waking each other through awaited actions stop at the store's budget", async () => {
    // Each watch writes the other's path after an awaited action (validateForm), so neither is running its own write
    // any more when the other wakes it: only the budget for watches set off by other watches ends the loop.
    const flip = (path: string) => ({
      action: "setState",
      params: { statePath: path, value: { $cond: { $state: path }, $then: false, $else: true } },
    })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "loop" }, children: ["kick", "a", "b"] },
        kick: { type: "Kick", props: {}, children: [] },
        a: {
          type: "Field",
          props: { label: "a", value: "" },
          children: [],
          watch: { "/a": [{ action: "validateForm" }, flip("/b")] },
        },
        b: {
          type: "Field",
          props: { label: "b", value: "" },
          children: [],
          watch: { "/b": [{ action: "validateForm" }, flip("/a")] },
        },
      },
    }
    let set: ((path: string, value: unknown) => void) | undefined
    const Kick: ElementImpl = () => {
      set = useStateStore().set
      return "kick" as never
    }
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
    try {
      const view = render(() => spec, { a: false, b: false }, { Box, Field, Kick })
      let writes = 0
      view.store.subscribe(() => writes++)
      set!("/a", true)
      // Without a budget the loop passed through microtasks only and this timer never fired.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(writes).toBeGreaterThan(10)
      // The change and the first watch's two actions, then at most 64 actions of watches the others set off.
      expect(writes).toBeLessThanOrEqual(1 + 2 + 64)
      expect(warnings.some((warning) => warning.includes("Skipped the watch on"))).toBe(true)
      // The next change, a task later, runs the watches again.
      const before = writes
      set!("/a", !view.store.get("/a"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(writes).toBeGreaterThan(before + 10)
      view.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("the watch bound holds across remounts: a watch that hides and re-shows its own parent stops", async () => {
    // Each round unmounts the watching element and mounts a fresh copy (validateForm between the writes lets each one
    // render: writes in a row run in one batch); the last validateForm wakes the copy again.
    const loop = [
      { action: "setState", params: { statePath: "/p", value: false } },
      { action: "validateForm" },
      { action: "setState", params: { statePath: "/p", value: true } },
      { action: "validateForm" },
    ]
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "card" }, children: ["kick", "wrap"] },
        kick: { type: "Kick", props: {}, children: [] },
        wrap: { type: "Box", props: { title: "wrap" }, children: ["w"], visible: { $state: "/p" } },
        w: {
          type: "Field",
          props: { label: "w", value: "" },
          children: [],
          watch: { "/q": loop, "/formValidation": loop },
        },
      },
    }
    let set: ((path: string, value: unknown) => void) | undefined
    const Kick: ElementImpl = () => {
      set = useStateStore().set
      return "kick" as never
    }
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
    try {
      const view = render(() => spec, { p: true, q: "" }, { Box, Field, Kick })
      set!("/q", "a")
      // With a bound per element mount, every round started a fresh count and this timer never fired.
      await new Promise((resolve) => setTimeout(resolve, 20))
      const mounts = count(view.mounts).Field ?? 0
      expect(mounts).toBeGreaterThan(10)
      expect(mounts).toBeLessThanOrEqual(64 + 2)
      expect(warnings.some((warning) => warning.includes("Skipped the watch"))).toBe(true)
      view.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("the watch bound holds for watches that add watches: rows that each add a watching row stop", async () => {
    // Every run adds a row whose watch also wakes on the next validateForm, so the runs per round double.
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "rows" }, children: ["kick", "list"] },
        kick: { type: "Kick", props: {}, children: [] },
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: {
          type: "Field",
          props: { label: "r", value: "" },
          children: [],
          watch: {
            "/formValidation": [
              { action: "pushState", params: { statePath: "/rows", value: 0 } },
              { action: "validateForm" },
            ],
          },
        },
      },
    }
    let set: ((path: string, value: unknown) => void) | undefined
    const Kick: ElementImpl = () => {
      set = useStateStore().set
      return "kick" as never
    }
    const warn = console.warn
    console.warn = () => {}
    try {
      const view = render(() => spec, { rows: [0] }, { Box, Field, Kick })
      set!("/formValidation", { valid: true })
      // With a bound per watch (or per change), the rows doubled every round and this timer never fired.
      await new Promise((resolve) => setTimeout(resolve, 20))
      const rows = (view.store.get("/rows") as unknown[]).length
      expect(rows).toBeGreaterThan(10)
      expect(rows).toBeLessThanOrEqual(1 + 64)
      view.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("one change wakes a watch in every row, each once; the budget is per surface and per task", async () => {
    // A "select all": each row's watch reacts to /filter. Under a bound of 64 runs per task, rows past the 64th were
    // skipped without a sign. A watch woken by a change no watch made is not charged.
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "rows" }, children: ["kick", "list"] },
        kick: { type: "Kick", props: {}, children: [] },
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: {
          type: "Field",
          props: { label: "r", value: { $item: "" } },
          children: [],
          watch: { "/filter": { action: "pushState", params: { statePath: "/log", value: { $item: "" } } } },
        },
      },
    }
    const setters: ((path: string, value: unknown) => void)[] = []
    const Kick: ElementImpl = () => {
      setters.push(useStateStore().set)
      return "kick" as never
    }
    const warn = console.warn
    console.warn = () => {}
    try {
      const rows = Array.from({ length: 100 }, (_, index) => index)
      const first = render(() => spec, { rows, filter: "", log: [] }, { Box, Field, Kick })
      const second = render(() => spec, { rows: rows.slice(0, 3), filter: "", log: [] }, { Box, Field, Kick })
      setters[0]!("/filter", "x")
      // In the same task, the other surface's watches still run.
      setters[1]!("/filter", "x")
      await new Promise((resolve) => setTimeout(resolve, 20))
      // A built-in's $item param is the item's path.
      expect(first.store.get("/log")).toEqual(rows.map((row) => `/rows/${row}`))
      expect(second.store.get("/log")).toEqual(["/rows/0", "/rows/1", "/rows/2"])
      setters[0]!("/filter", "y")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((first.store.get("/log") as unknown[]).length).toBe(200)
      first.dispose()
      second.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("watches that double a string each round stop growing it at the edit size limit", async () => {
    // Two watches that each write the other's path doubled, with an awaited action between: the string reached a
    // billion characters in two seconds, and the window ran out of memory before the watch budget stopped the loop.
    const double = (from: string, to: string) => ({
      action: "setState",
      params: { statePath: to, value: { $template: `\${${from}}\${${from}}` } },
    })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "x" }, children: ["kick", "a", "b"] },
        kick: { type: "Kick", props: {}, children: [] },
        a: {
          type: "Field",
          props: { label: "a", value: "" },
          children: [],
          watch: { "/a": [{ action: "validateForm" }, double("/a", "/b")] },
        },
        b: {
          type: "Field",
          props: { label: "b", value: "" },
          children: [],
          watch: { "/b": [{ action: "validateForm" }, double("/b", "/a")] },
        },
      },
    }
    let set: ((path: string, value: unknown) => void) | undefined
    const Kick: ElementImpl = () => {
      set = useStateStore().set
      return "kick" as never
    }
    const warn = console.warn
    console.warn = () => {}
    try {
      const store = createTrackedStore({ a: "", b: "" })
      const view = render(() => spec, {}, { Box, Field, Kick }, undefined, undefined, store)
      const started = performance.now()
      set!("/a", "0123456789")
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(performance.now() - started).toBeLessThan(2000)
      const longest = Math.max(String(store.get("/a")).length, String(store.get("/b")).length)
      expect(longest).toBeGreaterThan(MAX_EDIT_SIZE / 2)
      expect(longest).toBeLessThanOrEqual(MAX_EDIT_SIZE)
      view.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("a list of state actions re-evaluates the UI once, not once per write [review5#S1]", async () => {
    // Every write re-evaluates every element: a press of 200 writes in a UI of 100 rows cost 20,000 evaluations
    // (a 260 KB block with 1,000 writes and 1,500 rows froze the window for over a minute).
    const writes = Array.from({ length: 200 }, (_, index) => ({
      action: "setState",
      params: { statePath: "/q", value: `v${index}` },
    }))
    const rows = Array.from({ length: 100 }, (_, index) => `r${index}`)
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "rows" }, children: ["press", ...rows] },
        press: { type: "Press", props: {}, children: [], on: { press: writes } },
        ...Object.fromEntries(
          rows.map((key) => [key, { type: "Counted", props: { value: { $state: "/q" } }, children: [] }]),
        ),
      },
    }
    let evaluations = 0
    let emit: ((event: string) => unknown) | undefined
    const Press: ElementImpl = (ctx) => {
      emit = ctx.emit as never
      return "press" as never
    }
    const Counted: ElementImpl = (ctx) => {
      createComputed(() => {
        evaluations++
        return ctx.props.value
      })
      return "row" as never
    }
    const view = render(() => spec, { q: "" }, { Box, Press, Counted })
    view.text()
    evaluations = 0
    await emit!("press")
    expect(view.store.get("/q")).toBe("v199")
    expect(evaluations).toBeLessThanOrEqual(2 * rows.length)
    view.dispose()
  })

  test("a surface renders at most RENDER_UNITS elements: nested repeats stop there [review5#S3]", () => {
    // 300 × 300 items: 90,301 elements, which froze the window for seconds before the surface showed an error.
    const spec: Spec = {
      root: "outer",
      elements: {
        outer: { type: "Box", props: { title: "outer" }, children: ["row"], repeat: { statePath: "/a" } },
        row: { type: "Box", props: { title: "row" }, children: ["cell"], repeat: { statePath: "/b" } },
        cell: { type: "Field", props: { label: "x", value: "" }, children: [] },
      },
    }
    const items = Array.from({ length: 300 }, (_, index) => index)
    const budget = createRenderBudget()
    const view = render(() => spec, { a: items, b: items }, { Box, Field }, undefined, budget)
    view.text()
    // Each of these elements takes one unit.
    expect(view.mounts.length).toBe(RENDER_UNITS)
    expect(budget.used).toBe(RENDER_UNITS)
    // The outer box, 6 rows of 1 + 300, then the 7th row's box and 192 of its cells: the rest of that row is skipped,
    // and each later outer row is skipped whole (its inner list is never built).
    expect(budget.skipped()).toBe(300 - 192 + (300 - 7))
    // Removing items frees the budget for elements mounted later.
    view.store.set("/a", items.slice(0, 2))
    view.text()
    expect(budget.skipped()).toBe(0)
    expect(budget.used).toBe(1 + 2 * (1 + 300))
    view.dispose()
    expect(budget.used).toBe(0)
  })

  test("text counts toward the budget: a long string read in every row renders in the first rows only [review5#S3]", () => {
    // 2,000 rows of a 40 KB string made 80 MB of text: 22 s of frozen window.
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: { type: "Field", props: { label: "r", value: { $state: "/doc" } }, children: [] },
      },
    }
    const doc = "x".repeat(40_000)
    const budget = createRenderBudget()
    const view = render(
      () => spec,
      { rows: Array.from({ length: 2000 }, (_, index) => index), doc },
      { Box, Field },
      undefined,
      budget,
    )
    view.text()
    // Each row: one unit, one per TEXT_PER_UNIT characters of its props (the label, the value, and one per entry).
    const perRow = 1 + Math.floor((1 + 40_000 + 2) / TEXT_PER_UNIT)
    const fit = Math.floor((RENDER_UNITS - 1) / perRow)
    expect(count(view.mounts).Field).toBe(fit)
    expect(budget.skipped()).toBe(2000 - fit)
    // Rows whose props shrink fit again, as far as the budget has room when each re-evaluates (rows re-evaluated before
    // the long rows gave their units back stay empty until they are mounted again).
    view.store.set("/doc", "short")
    view.text()
    expect(budget.skipped()).toBeLessThan(2000 - fit)
    expect(budget.used).toBeLessThanOrEqual(RENDER_UNITS)
    expect(count(view.mounts).Field).toBeGreaterThan(1900)
    view.dispose()
    expect(budget.used).toBe(0)
  })

  test("a repeat renders at most 2,000 rows, also without a surface's budget [review5#S3]", () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: { type: "Field", props: { label: "r", value: "" }, children: [] },
      },
    }
    const view = render(() => spec, { rows: Array.from({ length: 5000 }, (_, index) => index) }, { Box, Field })
    view.text()
    expect(count(view.mounts).Field).toBe(2000)
    view.dispose()
  })

  test("a prop or condition that throws leaves its parent and siblings rendered", async () => {
    const { standardDirectives } = await import("@json-render/directives")
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "Deploys" }, children: ["ok", "ambiguous", "cond", "hidden"] },
        ok: { type: "Field", props: { label: "sibling", value: "text" }, children: [] },
        ambiguous: {
          type: "Field",
          props: { label: "two keys", value: { $format: "number", $concat: ["a", "b"], value: 3 } },
          children: [],
        },
        cond: {
          type: "Field",
          props: { label: "cond", value: { $cond: "/flag", $then: "a", $else: "b" } },
          children: [],
        },
        hidden: { type: "Field", props: { label: "hidden", value: "x" }, children: [], visible: "/flag" as never },
      },
    }
    const warn = console.warn
    const error = console.error
    const logged: unknown[] = []
    console.warn = (...args: unknown[]) => void logged.push(args[0])
    console.error = (...args: unknown[]) => void logged.push(args[0])
    try {
      const view = render(() => spec, { flag: true }, { Box, Field }, standardDirectives)
      expect(view.text()).toEqual(["<Deploys>", "sibling=text@", 'two keys=""@', 'cond=""@'])
      view.dispose()
    } finally {
      console.warn = warn
      console.error = error
    }
    expect(logged.some((entry) => String(entry).includes("Rendering error"))).toBe(false)
  })
})
