import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createComponent, createEffect, createRoot, on, type JSX } from "solid-js"
import {
  createDirectiveRegistry,
  createStateStore,
  resolvePropValue,
  type Spec,
  type StateStore,
} from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import type { ComponentRegistry } from "@json-render/solid"
import { buildRegistry, createElementRenderer, guardDirectives, type ElementImpl } from "../../src/gui/element.ts"
import { createTrackedStore } from "../../src/runtime/state.ts"

// Regression tests for the sixth review's json-render findings ([review6#R1] watch work, [review6#O1] expression
// expansion), against json-render's real renderer and core as patched in patches/. See test/unit/render.test.ts for the
// rendering harness this one follows.

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

type Set = (path: string, value: unknown) => void
type Handler = (params: Record<string, unknown>) => unknown

/** Renders `spec` over `store`, with action `handlers`; `Kick` hands out the provider's `set` (a user's edit). */
function render(spec: Spec, store: StateStore, components: Record<string, ElementImpl>, handlers = {}) {
  let set: Set | undefined
  let emits: Record<string, (event: string) => unknown> = {}
  const all: Record<string, ElementImpl> = {
    Box: (ctx) => (() => ctx.children) as never,
    Kick: () => {
      set = useStateStore().set
      return "kick" as never
    },
    Press: (ctx) => {
      emits[String(ctx.props.name)] = ctx.emit as never
      return "press" as never
    },
    Text: (ctx) => (() => String(ctx.props.text ?? "")) as never,
    ...components,
  }
  const element = createElementRenderer(all, () => "unknown" as unknown as JSX.Element)
  const registry: ComponentRegistry = buildRegistry(Object.keys(all), element)
  return createRoot((dispose) => {
    const tree = createComponent(JSONUIProvider, {
      registry,
      store,
      handlers: handlers as never,
      directives: guardDirectives(standardDirectives),
      get children() {
        return createComponent(Renderer, { spec, registry, fallback: element })
      },
    })
    const text = () => flatten(tree).map(String)
    text()
    return {
      text,
      set: (path: string, value: unknown) => set!(path, value),
      emit: (name: string) => emits[name]!("press"),
      dispose,
    }
  })
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Waits until the work deferred to later tasks is done (nothing written for a few tasks). */
async function settle(store: StateStore) {
  let last = store.getSnapshot()
  for (let quiet = 0; quiet < 5; ) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    quiet = store.getSnapshot() === last ? quiet + 1 : 0
    last = store.getSnapshot()
  }
}
const busy = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end);
}

let warnings: string[] = []
const warn = console.warn
beforeEach(() => {
  warnings = []
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]))
})
afterEach(() => {
  console.warn = warn
})

describe("watch work is bounded per change and per task [review6#R1]", () => {
  test("a press whose actions run past the time slice goes on in later tasks, and the window answers in between", async () => {
    // Twelve awaited actions of 15 ms each: upstream they ran back to back through microtasks, 180 ms without a turn.
    const ran: number[] = []
    const store = createStateStore({})
    const spec: Spec = {
      root: "go",
      elements: {
        go: {
          type: "Press",
          props: { name: "go" },
          children: [],
          on: { press: Array.from({ length: 12 }, (_, index) => ({ action: "slow", params: { index } })) },
        },
      },
    }
    const view = render(spec, store, {}, { slow: () => void (busy(15), ran.push(performance.now())) })
    let turn = 0
    setTimeout(() => (turn = performance.now()), 0)
    const done = view.emit("go")
    await done
    expect(ran.length).toBe(12)
    // A task ran before the last action: the list waited for a later task once it had run for the slice.
    expect(turn).toBeGreaterThan(0)
    expect(turn).toBeLessThan(ran[11]!)
    expect(warnings.some((warning) => warning.includes("Deferred watches and actions to the next task"))).toBe(true)
    view.dispose()
  })

  test("watches that keep waking each other with slow actions stop at the slice, and do not go on later", async () => {
    // Two watches each run a 15 ms action and then write the other's path. Under a count of 64 actions per task this
    // ran for a second without a turn.
    let runs = 0
    const store = createStateStore({ a: 0, b: 0 })
    const flip = (path: string) => ({
      action: "setState",
      params: { statePath: path, value: { $cond: { $state: path }, $then: 0, $else: 1 } },
    })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["kick", "a", "b"] },
        kick: { type: "Kick", props: {}, children: [] },
        a: { type: "Text", props: { text: "a" }, children: [], watch: { "/a": [{ action: "slow" }, flip("/b")] } },
        b: { type: "Text", props: { text: "b" }, children: [], watch: { "/b": [{ action: "slow" }, flip("/a")] } },
      },
    }
    const view = render(spec, store, {}, { slow: () => void (busy(15), runs++) })
    const started = performance.now()
    view.set("/a", 1)
    await settle(store)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(runs).toBeGreaterThan(1)
    expect(runs).toBeLessThanOrEqual(8)
    expect(warnings.some((warning) => warning.includes("still running after 50 ms"))).toBe(true)
    // Skipped, not deferred: nothing more runs later.
    const after = runs
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(runs).toBe(after)
    view.dispose()
  })

  test("the watches one change wakes are counted: past 4,000 wakes the rest are skipped", async () => {
    // Every write called every watch's listener, whatever it did: rows whose watches write the path they all watch
    // called each other a million times for one change. Here the watches run nothing, so only the wakes count: five
    // writes in one task wake 1,000 rows each.
    const Row: ElementImpl = () => "row" as never
    const store = createStateStore({ q: 0, rows: Array.from({ length: 1000 }, (_, index) => index) })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["kick", "list"] },
        kick: { type: "Kick", props: {}, children: [] },
        list: { type: "Box", props: {}, children: ["row"], repeat: { statePath: "/rows" } },
        row: { type: "Row", props: {}, children: [], watch: { "/q": [] } },
      },
    }
    const view = render(spec, store, { Row })
    for (let index = 1; index <= 5; index++) view.set("/q", index)
    await settle(store)
    expect(warnings.some((warning) => warning.includes("watches woke 4000 times for one change"))).toBe(true)
    view.dispose()
  })

  test("a user's input event has counts of its own while an earlier change's lists still wait", async () => {
    let marks = 0
    const store = createStateStore({ q: 0, p: 0, rows: Array.from({ length: 100 }, (_, index) => index) })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["kick", "mark", "list"] },
        kick: { type: "Kick", props: {}, children: [] },
        mark: { type: "Text", props: { text: "m" }, children: [], watch: { "/p": { action: "mark" } } },
        list: { type: "Box", props: {}, children: ["row"], repeat: { statePath: "/rows" } },
        row: { type: "Text", props: { text: "r" }, children: [], watch: { "/q": { action: "slow" } } },
      },
    }
    let slow = 0
    const view = render(spec, store, {}, { slow: () => void (busy(3), slow++), mark: () => void marks++ })
    view.set("/q", 1)
    // (The rows' first actions settle, as they would before any other event.)
    for (let index = 0; index < 10; index++) await Promise.resolve()
    // A user's input event in the same task (one that came before the timer ending a long task): new work, though the
    // rows' awaited actions, past the slice, wait for later tasks, and use up their count of 64 there before the mark's
    // turn comes.
    const events = globalThis as { event?: unknown }
    events.event = { isTrusted: true, type: "input" }
    try {
      view.set("/p", 1)
    } finally {
      delete events.event
    }
    expect(slow).toBeLessThan(64)
    await settle(store)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(slow).toBe(64)
    expect(marks).toBe(1)
    view.dispose()
  })

  test("work that keeps setting off more work that waits stops after 40 such works [R6F3-3]", async () => {
    // An element that fires its event whenever its value changes, as the UI can when it renders (a focus that moves),
    // and an event whose slow actions change that value: each round is new work, and each waits for the next task once
    // the slice is spent, so without a limit it went on for good, a slice per task. (The limit counts such works that
    // had to wait, not tasks: a change that goes on over many tasks within its counts is not cut, see
    // test/unit/review7-patch.test.ts.)
    let runs = 0
    const Echo: ElementImpl = (ctx) => {
      createEffect(
        on(
          () => ctx.props.value,
          () => void ctx.emit("press"),
          { defer: true },
        ),
      )
      return "echo" as never
    }
    const store = createStateStore({ v: 0 })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["kick", "echo"] },
        kick: { type: "Kick", props: {}, children: [] },
        echo: {
          type: "Echo",
          props: { value: { $state: "/v" } },
          children: [],
          on: {
            press: [
              { action: "slow" },
              {
                action: "setState",
                params: { statePath: "/v", value: { $cond: { $state: "/v" }, $then: 0, $else: 1 } },
              },
            ],
          },
        },
      },
    }
    const view = render(spec, store, { Echo }, { slow: () => void (busy(20), runs++) })
    view.set("/v", 1)
    await new Promise((resolve) => setTimeout(resolve, 4000))
    expect(
      warnings.some((warning) => warning.includes("kept setting off new work that waited for a later task (40 times")),
    ).toBe(true)
    const after = runs
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(runs).toBe(after)
    view.dispose()
  }, 10_000)

  test("a change of several paths wakes each watch once, in the order they subscribed", () => {
    const heard: string[] = []
    let update: ((updates: Record<string, unknown>) => void) | undefined
    const Listen: ElementImpl = (ctx) => {
      const store = useStateStore() as ReturnType<typeof useStateStore> & {
        subscribeChanges: (listener: (changes: { path: string }[]) => void, paths?: string[]) => () => void
      }
      store.subscribeChanges(() => void heard.push(String(ctx.props.name)), ctx.props.paths as string[])
      update = store.update
      return "listen" as never
    }
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["one", "two", "three"] },
        one: { type: "Listen", props: { name: "one", paths: ["/b"] }, children: [] },
        two: { type: "Listen", props: { name: "two", paths: ["/a", "/b"] }, children: [] },
        three: { type: "Listen", props: { name: "three", paths: ["/c"] }, children: [] },
      },
    }
    const view = render(spec, createStateStore({ a: 0, b: 0, c: 0 }), { Listen })
    update!({ "/a": 1, "/b": 1 })
    expect(heard).toEqual(["one", "two"])
    view.dispose()
  })
})

describe("expression expansion is bounded while it resolves [review6#O1]", () => {
  const directives = createDirectiveRegistry(guardDirectives(standardDirectives))
  const ctx = (stateModel: Record<string, unknown>) => ({ stateModel, directives })
  const limited = (run: () => unknown) => {
    try {
      run()
    } catch (error) {
      return (error as { expansionLimit?: boolean }).expansionLimit === true
    }
    return false
  }

  test("a $template, $concat or $join that would build more than a million characters is left unresolved", async () => {
    // Upstream each built its whole result first: 100,000 references to a 500 KB string in a 1 MB block ran the window
    // out of memory before the render budget could leave the element out.
    const state = { a: "x".repeat(1000), rows: Array.from({ length: 2000 }, () => 0) }
    expect(limited(() => resolvePropValue({ $template: "${/a}".repeat(2000) }, ctx(state)))).toBe(true)
    expect(
      limited(() => resolvePropValue({ $concat: Array.from({ length: 2000 }, () => ({ $state: "/a" })) }, ctx(state))),
    ).toBe(true)
    expect(
      limited(() => resolvePropValue({ $join: { $state: "/rows" }, separator: "y".repeat(1000) }, ctx(state))),
    ).toBe(true)
    // Said once per task.
    expect(warnings.filter((warning) => warning.includes("Left an expression unresolved")).length).toBe(1)
    await nextTask()
  })

  test("all expressions in one task build at most 4 million characters, for the whole window", async () => {
    // A text read in every row: each expression under its own limit, together without one. (The bound was 32 million
    // characters, which took seconds to build in one task: R6S1-3.)
    await nextTask()
    const state = { a: "x".repeat(900_000) }
    let resolved = 0
    let refused = 0
    for (let index = 0; index < 40; index++) {
      if (limited(() => resolvePropValue({ $template: "${/a}" }, ctx(state)))) refused++
      else resolved++
    }
    expect(resolved).toBe(4)
    expect(refused).toBe(36)
    // The next task builds again.
    await nextTask()
    expect(resolvePropValue({ $template: "${/a}!" }, ctx(state))).toBe(`${state.a}!`)
  })

  test("expressions under the limits resolve as before", async () => {
    await nextTask()
    const plain = Object.fromEntries(standardDirectives.map((directive) => [directive.name, directive]))
    const state = { name: "Ada", n: 3, list: ["a", null, 2, { x: 1 }, ["b", "c"]], empty: [], obj: { k: "v" } }
    const cases: unknown[] = [
      { $concat: ["Hi ", { $state: "/name" }, null, 7, { $state: "/missing" }, { $state: "/obj" }] },
      { $concat: [] },
      { $join: { $state: "/list" } },
      { $join: { $state: "/list" }, separator: " | " },
      { $join: { $state: "/empty" }, separator: "-" },
      { $join: { $state: "/name" } },
      { $join: { $state: "/missing" } },
      { $join: { $state: "/list" }, separator: 0 },
    ]
    for (const value of cases) {
      const key = Object.keys(value as object)[0]!
      expect(resolvePropValue(value, ctx(state))).toEqual(plain[key]!.resolve(value as never, ctx(state) as never))
    }
    const item = { name: "Row", n: 0 }
    expect(
      resolvePropValue({ $template: "${/name} has ${n} ${name} ${missing}${/n}" }, { ...ctx(state), repeatItem: item }),
    ).toBe("Ada has 0 Row 3")
    expect(resolvePropValue({ $template: "no references" }, ctx(state))).toBe("no references")
  })

  test("in a surface, the prop is left empty once and its siblings render; an action with it does not write", async () => {
    await nextTask()
    const store = createTrackedStore({ a: "x".repeat(50_000), b: "" })
    const huge = { $template: "${/a}".repeat(10_000) }
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["big", "ok", "go"] },
        big: { type: "Text", props: { text: huge }, children: [] },
        ok: { type: "Text", props: { text: { $template: "a is ${/a}" } }, children: [] },
        go: {
          type: "Press",
          props: { name: "go" },
          children: [],
          on: { press: [{ action: "setState", params: { statePath: "/b", value: huge } }] },
        },
      },
    }
    const started = performance.now()
    const view = render(spec, store, {})
    expect(performance.now() - started).toBeLessThan(1000)
    const text = view.text()
    expect(text[0]).toBe("")
    expect(text[1]!.length).toBe(5 + 50_000)
    expect(warnings.length).toBe(1)
    await nextTask()
    const error = console.error
    console.error = () => {}
    try {
      await expect(Promise.resolve(view.emit("go"))).rejects.toMatchObject({ expansionLimit: true })
    } finally {
      console.error = error
    }
    expect(store.get("/b")).toBe("")
    view.dispose()
  })
})
