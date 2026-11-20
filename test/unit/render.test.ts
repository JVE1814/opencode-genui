import { describe, expect, test } from "bun:test"
import { createComponent, createComputed, createRoot, createSignal, type JSX } from "solid-js"
import { createStateStore, type Spec, type StateStore } from "@json-render/core"
import type { BaseComponentProps, ComponentRegistry } from "@json-render/solid"
import { createTrackedStore, MAX_EDIT_SIZE } from "../../src/runtime/state.ts"
import { evaluationsDone } from "./evaluations.ts"
import {
  buildRegistry,
  createElementRenderer,
  createRenderBudget,
  guardDirectives,
  RENDER_UNITS,
  RenderBudgetContext,
  TEXT_PER_UNIT,
  type ElementImpl,
  type JsonRenderHooks,
  type RenderBudget,
} from "../../src/gui/element.ts"

// json-render's real renderer, without a DOM: components return strings, and the rendered tree is a nest of accessors
// and arrays that `text()` flattens. @json-render/solid only touches the DOM at load, to delegate events, so a stub
// `window.document` is in place for the import and removed right after.
const globals = globalThis as { window?: unknown }
globals.window = { document: { addEventListener() {} } }
const solid = await import("@json-render/solid")
const { JSONUIProvider, Renderer, useRepeatScope, useStateStore } = solid
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
  // With json-render's hooks, as src/gui/registry.tsx passes them: a repeat's rows count in its slots.
  const element = createElementRenderer(recorded, unknown, { useStateStore, useRepeatScope, RepeatRowsContext })
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
      // (The warning names what was skipped and why; it read "Skipped the watch on <path>" while only chains counted.)
      expect(warnings.some((warning) => warning.includes("Skipped watches and actions"))).toBe(true)
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
      expect(warnings.some((warning) => warning.includes("Skipped watches and actions"))).toBe(true)
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

  test("one change wakes a watch in every row, each once; another surface's watches run in the same task", async () => {
    // A "select all": each row's watch reacts to /filter. Under a bound of 64 runs per task, rows past the 64th were
    // skipped without a sign. A watch woken by a change no watch made is charged only to the large count of state
    // actions (and its awaited actions to the small one: see the review6 cases below).
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

  // A repeat of `rows` items whose row watches /q with `actions`; `Kick` hands out the provider's `set` (the user's edit).
  // The store counts its writes by path, each row counts how often it re-evaluates, and so does `Sum`, which shows the
  // whole list.
  function watchingRows(rows: number, actions: unknown[], row: Record<string, unknown> = { value: { $item: "" } }) {
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: { title: "rows" }, children: ["kick", "sum", "list"] },
        kick: { type: "Kick", props: {}, children: [] },
        sum: { type: "Sum", props: { value: { $state: "/rows" } }, children: [] },
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: { type: "Counted", props: row, children: [], watch: { "/q": actions as never } },
      },
    }
    let set: ((path: string, value: unknown) => void) | undefined
    const Kick: ElementImpl = () => {
      set = useStateStore().set
      return "kick" as never
    }
    let evaluations = 0
    let sums = 0
    const Counted: ElementImpl = (ctx) => {
      createComputed(() => {
        evaluations++
        return ctx.props.value
      })
      return "row" as never
    }
    const Sum: ElementImpl = (ctx) => {
      createComputed(() => {
        sums++
        return ctx.props.value
      })
      return "sum" as never
    }
    const store = createStateStore({ q: "", a: "", rows: Array.from({ length: rows }, () => ({ checked: false })) })
    const writes: Record<string, number> = {}
    const write = store.set.bind(store)
    store.set = (path, value) => {
      writes[path] = (writes[path] ?? 0) + 1
      write(path, value)
    }
    const view = render(() => spec, {}, { Box, Kick, Counted, Sum }, undefined, undefined, store)
    view.text()
    evaluations = 0
    sums = 0
    return {
      view,
      store,
      writes,
      set: (path: string, value: unknown) => set!(path, value),
      evaluations: () => evaluations,
      sums: () => sums,
    }
  }

  // Waits until the work deferred to later tasks is done (nothing written for a few tasks).
  async function settle(store: StateStore) {
    let last = store.getSnapshot()
    for (let quiet = 0; quiet < 5; ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      quiet = store.getSnapshot() === last ? quiet + 1 : 0
      last = store.getSnapshot()
    }
  }

  test("one key press in a 600-row repeat whose row watch is [setState {$index}, validateForm] is bounded [review6#R1]", async () => {
    // Every row's watch woke on the key press and ran its whole list: 600 validateForms, each re-evaluating every row,
    // and every write called every row's listener. A 1.9 KB untrusted block froze the window for 22 s.
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
    try {
      const rows = watchingRows(600, [
        { action: "setState", params: { statePath: "/a", value: { $index: true } } },
        { action: "validateForm" },
      ])
      const started = performance.now()
      rows.set("/q", "x")
      await settle(rows.store)
      expect(performance.now() - started).toBeLessThan(2000)
      // Each row's state action ran (one change may wake a watch in every row), the awaited ones up to the small count.
      expect(rows.writes["/a"]).toBe(600)
      expect(rows.writes["/formValidation"]).toBeGreaterThan(0)
      expect(rows.writes["/formValidation"]).toBeLessThanOrEqual(64)
      expect(warnings.some((warning) => warning.includes("64 awaited or chained actions"))).toBe(true)
      // Rows whose item did not change were not re-evaluated by the writes elsewhere.
      expect(rows.evaluations()).toBeLessThanOrEqual(600)
      rows.view.dispose()
    } finally {
      console.warn = warn
    }
  })

  // The bound was 2,000 state actions per change, which cut a select-all whose row watch writes twice at its first 1,000
  // rows (R6F1-5); it is 8,000 now, four writes in each of 2,000 rows.
  test("one key press in a 1,000-row repeat whose row watch makes 10 writes runs at most 8,000 [review6#R1]", async () => {
    // 1,000 rows × 10 writes, each write calling all 1,000 rows' listeners: 10 million calls, 5.5 s for one key press.
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
    try {
      const writes = Array.from({ length: 10 }, (_, index) => ({
        action: "setState",
        params: { statePath: "/a", value: index % 2 ? "x" : "y" },
      }))
      const rows = watchingRows(1000, writes)
      const started = performance.now()
      rows.set("/q", "x")
      await settle(rows.store)
      expect(performance.now() - started).toBeLessThan(2000)
      expect(rows.writes["/a"]).toBe(8000)
      expect(warnings.some((warning) => warning.includes("8000 state actions"))).toBe(true)
      // The next key press, a task later, has counts of its own.
      rows.set("/q", "xy")
      await settle(rows.store)
      expect(rows.writes["/a"]).toBe(16000)
      rows.view.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("a select-all whose row watch writes twice ticks every row; work past the bounds is told to the store [R6F1-5]", async () => {
    // Two writes in each of 1,500 rows: the bound of 2,000 state actions per change ticked the first 1,000 rows, and only
    // the console said so.
    const warn = console.warn
    console.warn = () => {}
    try {
      const spec = (writes: number): Spec => ({
        root: "box",
        elements: {
          box: { type: "Box", props: { title: "rows" }, children: ["kick", "list"] },
          kick: { type: "Kick", props: {}, children: [] },
          list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
          row: {
            type: "Box",
            props: { title: "row" },
            children: [],
            watch: {
              "/all": Array.from({ length: writes }, (_, index) => ({
                action: "setState",
                params: { statePath: { $item: index === 0 ? "checked" : `seen${index}` }, value: { $state: "/all" } },
              })) as never,
            },
          },
        },
      })
      const run = async (rows: number, writes: number) => {
        const store = createTrackedStore()
        store.setBase({ all: false, rows: Array.from({ length: rows }, () => ({ checked: false })) })
        let set: ((path: string, value: unknown) => void) | undefined
        const Kick: ElementImpl = () => {
          set = useStateStore().set
          return "kick" as never
        }
        const view = render(() => spec(writes), {}, { Box, Kick }, undefined, undefined, store)
        view.text()
        await evaluationsDone()
        set!("/all", true)
        await settle(store)
        const checked = (store.get("/rows") as { checked: boolean }[]).filter((row) => row.checked).length
        view.dispose()
        return { checked, skipped: store.skippedWork() }
      }
      expect(await run(1500, 2)).toEqual({ checked: 1500, skipped: false })
      // Five writes in each of 2,000 rows are more than one change runs: the store hears of it (its surface shows it).
      const over = await run(2000, 5)
      expect(over.skipped).toBe(true)
      expect(over.checked).toBeLessThan(2000)
    } finally {
      console.warn = warn
    }
  })

  test("rows whose `visible` is slow to evaluate render over later tasks; neither the mount nor a change blocks [R6S1-1]", async () => {
    // Every row evaluated its 2,500-term condition on mount and on every change of the state, in one task: seconds.
    const terms = Array.from({ length: 2500 }, () => ({ $state: "/q", eq: "never" }))
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: {
          type: "Field",
          props: { label: "r", value: { $state: "/q" } },
          children: [],
          visible: { $or: [...terms, { $state: "/q", neq: "never" }] },
        },
      },
    }
    const warn = console.warn
    console.warn = () => {}
    try {
      let started = performance.now()
      const view = render(
        () => spec,
        { q: "", rows: Array.from({ length: 2000 }, (_, index) => index) },
        { Box, Field },
      )
      view.text()
      expect(performance.now() - started).toBeLessThan(400)
      started = performance.now()
      await evaluationsDone()
      expect(count(view.mounts).Field).toBe(2000)
      // A change of the state they read re-evaluates every row, in task-sized slices too.
      started = performance.now()
      view.store.set("/q", "x")
      view.text()
      expect(performance.now() - started).toBeLessThan(400)
      await evaluationsDone()
      expect(view.text().filter((text) => text === "r=x@").length).toBe(2000)
      view.dispose()
    } finally {
      console.warn = warn
    }
  }, 20_000)

  test("2,000 rows of 50 $format each render in well under a second in all [R6S1-1]", async () => {
    // A new Intl formatter on every call: 13 s for this block of 6 KB in the playground.
    const { standardDirectives } = await import("@json-render/directives")
    const leaf = { $count: { $format: "date", value: 0 } }
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: {
          type: "Field",
          props: {
            label: "r",
            value: {
              $truncate: { $concat: [{ $state: "/q" }, ...Array.from({ length: 50 }, () => leaf)] },
              length: 0,
              suffix: "",
            },
          },
          children: [],
        },
      },
    }
    const started = performance.now()
    const view = render(
      () => spec,
      { q: "", rows: Array.from({ length: 2000 }, (_, index) => index) },
      { Box, Field },
      guardDirectives(standardDirectives),
    )
    view.text()
    await evaluationsDone()
    expect(count(view.mounts).Field).toBe(2000)
    expect(performance.now() - started).toBeLessThan(1500)
    view.dispose()
  })

  test("a select-all over 2,000 rows sets every row and re-evaluates each about once [review6#R1]", async () => {
    // The surface's element budget: a watch in each row sets its item from /q. An action that read the element's memo
    // inside the batch of writes ran every computation queued so far (every row's item, everything that shows the
    // list) once per write: 2,000 × 2,000, and the select-all took many tasks.
    const warn = console.warn
    console.warn = () => {}
    try {
      const rows = watchingRows(
        2000,
        [{ action: "setState", params: { statePath: { $item: "checked" }, value: { $state: "/q" } } }],
        { value: { $item: "checked" } },
      )
      const started = performance.now()
      rows.set("/q", true)
      await settle(rows.store)
      expect(performance.now() - started).toBeLessThan(3000)
      const items = rows.store.get("/rows") as { checked: unknown }[]
      expect(items.filter((item) => item.checked === true).length).toBe(2000)
      expect(rows.evaluations()).toBeLessThanOrEqual(2 * 2000)
      // What shows the whole list re-evaluates once per batch of writes, and the writes fit in a few batches (tasks). With
      // a memo read per action, each write cost a pass over every row's item, and the select-all took 17 tasks here.
      expect(rows.sums()).toBeLessThanOrEqual(10)
      rows.view.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("a write calls only the watches of its path; other listeners hear every change [review6#R1]", () => {
    const heard: string[] = []
    const spec: Spec = { root: "kick", elements: { kick: { type: "Kick", props: {}, children: [] } } }
    let set: ((path: string, value: unknown) => void) | undefined
    const Kick: ElementImpl = () => {
      const store = useStateStore() as ReturnType<typeof useStateStore> & {
        subscribeChanges: (listener: (changes: { path: string }[]) => void, paths?: string[]) => () => void
      }
      store.subscribeChanges((changes) => void heard.push(`watch ${changes.map((change) => change.path)}`), ["/x"])
      store.subscribeChanges((changes) => void heard.push(`all ${changes.map((change) => change.path)}`))
      set = store.set
      return "kick" as never
    }
    const view = render(() => spec, { x: 0, y: 0 }, { Kick })
    view.text()
    set!("/y", 1)
    set!("/x", 1)
    expect(heard).toEqual(["all /y", "all /x", "watch /x"])
    view.dispose()
  })

  test("a surface renders at most RENDER_UNITS elements: nested repeats stop there [review5#S3]", async () => {
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
    // (What takes more than a task to evaluate is evaluated in the next tasks.)
    await evaluationsDone()
    // Each of these elements takes one unit.
    expect(view.mounts.length).toBe(RENDER_UNITS)
    expect(budget.used).toBe(RENDER_UNITS)
    // The outer box, 6 rows of 1 + 300, then the 7th row's box and 192 of its cells: the rest of that row is skipped,
    // and each later outer row is skipped whole (its inner list is never built).
    expect(budget.skipped()).toBe(300 - 192 + (300 - 7))
    // Removing items frees the budget for elements mounted later.
    view.store.set("/a", items.slice(0, 2))
    view.text()
    await evaluationsDone()
    expect(budget.skipped()).toBe(0)
    expect(budget.used).toBe(1 + 2 * (1 + 300))
    view.dispose()
    expect(budget.used).toBe(0)
  })

  test("text counts toward the budget: a long string read in every row renders in the first rows only [review5#S3]", async () => {
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
    await evaluationsDone()
    // Each row: one unit, one per TEXT_PER_UNIT characters of its props (the label, the value, and one per entry).
    const perRow = 1 + Math.floor((1 + 40_000 + 2) / TEXT_PER_UNIT)
    const fit = Math.floor((RENDER_UNITS - 1) / perRow)
    expect(count(view.mounts).Field).toBe(fit)
    expect(budget.skipped()).toBe(2000 - fit)
    // Rows whose props shrink fit again, as far as the budget has room when each re-evaluates (rows re-evaluated before
    // the long rows gave their units back stay empty until they are mounted again).
    view.store.set("/doc", "short")
    view.text()
    await evaluationsDone()
    expect(budget.skipped()).toBeLessThan(2000 - fit)
    expect(budget.used).toBeLessThanOrEqual(RENDER_UNITS)
    expect(count(view.mounts).Field).toBeGreaterThan(1900)
    view.dispose()
    expect(budget.used).toBe(0)
  })

  test("a repeat renders at most 2,000 rows, also without a surface's budget [review5#S3]", async () => {
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: { title: "list" }, children: ["row"], repeat: { statePath: "/rows" } },
        row: { type: "Field", props: { label: "r", value: "" }, children: [] },
      },
    }
    const view = render(() => spec, { rows: Array.from({ length: 5000 }, (_, index) => index) }, { Box, Field })
    view.text()
    await evaluationsDone()
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
