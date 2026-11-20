import { describe, expect, test } from "bun:test"
import { createComponent, createComputed, createRoot, createSignal, type JSX } from "solid-js"
import { createStateStore, type Spec, type StateStore } from "@json-render/core"
import type { BaseComponentProps, ComponentRegistry } from "@json-render/solid"
import { buildRegistry, createElementRenderer, type ElementImpl } from "../../src/gui/element.ts"

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
  const store = createStateStore(state)
  return createRoot((dispose) => {
    const tree = createComponent(JSONUIProvider, {
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

  test("a watch that keeps triggering itself through an awaited action stops instead of freezing the window", async () => {
    const spec: Spec = {
      root: "box",
      elements: {
        box: {
          type: "Kick",
          props: {},
          children: [],
          watch: {
            "/t": [
              { action: "validateForm" },
              {
                action: "setState",
                params: { statePath: "/t", value: { $cond: { $state: "/t" }, $then: false, $else: true } },
              },
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
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
    try {
      const view = render(() => spec, { t: true }, { Kick })
      let writes = 0
      view.store.subscribe(() => writes++)
      set!("/t", false)
      // Without the bound, each round passed through a microtask only and this timer never fired.
      await new Promise((resolve) => setTimeout(resolve, 20))
      // 64 watch runs, each writing /formValidation and /t, then the loop ends.
      expect(writes).toBeGreaterThan(10)
      expect(writes).toBeLessThanOrEqual(2 * 64 + 1)
      expect(warnings.some((warning) => warning.includes('Skipped the watch on "/t"'))).toBe(true)
      // The next change (a new task) runs the watch again.
      const before = writes
      set!("/t", !view.store.get("/t"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(writes).toBeGreaterThan(before + 10)
      view.dispose()
    } finally {
      console.warn = warn
    }
  })

  test("the watch bound holds across remounts: a watch that hides and re-shows its own parent stops", async () => {
    // Each round unmounts the watching element and mounts a fresh copy; validateForm wakes the copy again.
    const loop = [
      { action: "setState", params: { statePath: "/p", value: false } },
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

  test("the watch bound is per surface and per task: other surfaces and the next change run as usual", async () => {
    // Each row's watch appends to /log when /filter changes. One change wakes a hundred watches: 64 run (a reaction in
    // every row belongs in its props, as $state or $item expressions), and the next change, a task later, runs 64 more.
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
      expect((first.store.get("/log") as unknown[]).length).toBe(64)
      expect((second.store.get("/log") as unknown[]).length).toBe(3)
      setters[0]!("/filter", "y")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((first.store.get("/log") as unknown[]).length).toBe(128)
      first.dispose()
      second.dispose()
    } finally {
      console.warn = warn
    }
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
