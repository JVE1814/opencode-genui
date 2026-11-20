import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createComponent, createComputed, createRoot, type Context, type JSX } from "solid-js"
import { createStateStore, resolvePropValue, type Spec, type StateStore } from "@json-render/core"
import type { ComponentRegistry } from "@json-render/solid"
import {
  buildRegistry,
  createElementRenderer,
  createRenderBudget,
  RenderBudgetContext,
  unitsOf,
  type ElementImpl,
  type RenderBudget,
} from "../../src/gui/element.ts"
import type { SurfaceContext } from "../../src/gui/host.ts"
import {
  hasIntent,
  INTENT_TTL_MS,
  lendActivation,
  withIntent,
  withoutIntent,
  type Away,
} from "../../src/gui/outward.ts"
import { waiting } from "../../src/runtime/budget.ts"
import { createTrackedStore, groupEditsBy } from "../../src/runtime/state.ts"

// Where the sixth review's fixes meet, against json-render's real renderer as patched in patches/:
// - an activation's work that json-render's time slice or the render budget's task slice sends to later tasks, against
//   genui's activation intent (src/gui/outward.ts), which only the dispatch's own work may find;
// - validateForm over many fields; a select-all whose writes span tasks, against the state store's user actions
//   (src/runtime/state.ts); a large static prop in every row of a repeat, against the render budget's sizes.
// See test/unit/review6-watch.test.ts for the rendering harness this one follows.

const globals = globalThis as { window?: unknown }
globals.window = { document: { addEventListener() {} } }
const jsonRender = await import("@json-render/solid")
const { JSONUIProvider, Renderer, useFieldValidation, useRepeatScope, useStateStore, useValidation } = jsonRender
const { evaluationsWaiting, EvaluationLendContext } = jsonRender as unknown as {
  readonly evaluationsWaiting?: () => boolean
  readonly EvaluationLendContext: Context<(() => ((run: () => void) => void) | undefined) | undefined>
}
delete globals.window

type Emit = (event: string, away?: Away) => Promise<void>

/** The untrusted surface the tests dispatch on (genui keys intents by the surface's context object). */
const surface = { trusted: false } as unknown as SurfaceContext

/**
 * Renders `spec` over `store` with action `handlers`; returns the emit of each `Press` element, by its `name`. A `Field`
 * registers a required check at `/fields/<its index>` and reads its own validation state, as genui's fields do (the
 * whole map of field states, then its own entry), counting each read in `reads`.
 */
function render(
  spec: Spec,
  store: StateStore,
  handlers: Record<string, (params: unknown) => unknown>,
  reads = { count: 0 },
  budget?: RenderBudget,
  mounted?: (type: string, intent: boolean) => void,
) {
  const emits: Record<string, Emit> = {}
  const components: Record<string, ElementImpl> = {
    Box: (ctx) => (() => ctx.children) as never,
    Press: (ctx) => {
      emits[String(ctx.props.name)] = ctx.emit as unknown as Emit
      return "press" as never
    },
    Field: (ctx) => {
      const path = `/fields/${String(ctx.props.index)}`
      const validation = useValidation()
      useFieldValidation(path, { checks: [{ type: "required", message: "Required" }] })
      createComputed(() => {
        reads.count++
        void validation.fieldStates[path]
      })
      return "field" as never
    },
    // Records whether its surface had an activation as it mounted (a Dialog asks this as it opens).
    Probe: (ctx) => {
      mounted?.(String(ctx.props.name), hasIntent(surface))
      return "probe" as never
    },
  }
  const element = createElementRenderer(components, () => "unknown" as unknown as JSX.Element, {
    useStateStore,
    useRepeatScope,
  })
  const registry: ComponentRegistry = buildRegistry(Object.keys(components), element)
  return createRoot((dispose) => {
    const provider = () =>
      createComponent(JSONUIProvider, {
        registry,
        store,
        handlers: handlers as never,
        get children() {
          const renderer = () => createComponent(Renderer, { spec, registry, fallback: element })
          // As src/gui/surface.tsx: what json-render defers to a later task is lent what the budget's slice is.
          const lend = budget?.lend
          return lend
            ? createComponent(EvaluationLendContext.Provider, {
                value: lend,
                get children() {
                  return renderer()
                },
              })
            : renderer()
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
    ;(tree as unknown as () => unknown)()
    return { emits, dispose }
  })
}

const busy = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end);
}

const warn = console.warn
beforeEach(() => {
  console.warn = () => {}
})
afterEach(() => {
  console.warn = warn
})

describe("an activation whose actions wait for a later task [review6 integration]", () => {
  test("sets its intent aside until its list runs again: a task in between (a keystroke's) finds none", async () => {
    const seen: Record<string, boolean[]> = { slow: [], between: [], after: [] }
    const store = createStateStore({ y: 0 })
    const spec: Spec = {
      root: "go",
      elements: {
        go: {
          type: "Press",
          props: { name: "go" },
          children: [],
          on: {
            press: [
              { action: "slow" },
              { action: "setState", params: { statePath: "/y", value: 1 } },
              { action: "slow" },
              { action: "check" },
            ],
          },
        } as never,
      },
    }
    const view = render(spec, store, {
      // Runs past json-render's time slice, so what follows waits for the next task. The timer set here runs before
      // that task: it stands for the user's keystroke, which the window answers in between.
      slow: () => {
        seen.slow!.push(hasIntent(surface))
        setTimeout(() => seen.between!.push(hasIntent(surface)), 0)
        busy(60)
      },
      check: () => void seen.after!.push(hasIntent(surface)),
    })
    await withIntent(surface, (away) => view.emits.go!("press", away))
    expect(store.get("/y")).toBe(1)
    // The dispatch's own actions have its intent, also those that ran in later tasks.
    expect(seen.slow).toEqual([true, true])
    expect(seen.after).toEqual([true])
    // The tasks in between had none: the setState waited (a batch of state actions) and the second slow and the check
    // waited (an awaited action).
    expect(seen.between).toEqual([false, false])
    expect(hasIntent(surface)).toBe(false)
    view.dispose()
  })

  test("the batch of state actions that waited runs with its intent, and so does what its writes set off", async () => {
    const seen: boolean[] = []
    const store = createStateStore({ open: false })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["go", "dialog"] } as never,
        go: {
          type: "Press",
          props: { name: "go" },
          children: [],
          on: { press: [{ action: "slow" }, { action: "setState", params: { statePath: "/open", value: true } }] },
        } as never,
        // Stands for a Dialog: what opens it is the write's own task, in the batch that runs the waiting list.
        dialog: {
          type: "Press",
          props: { name: "dialog" },
          children: [],
          watch: { "/open": { action: "check" } },
        } as never,
      },
    }
    const view = render(spec, store, {
      slow: () => busy(60),
      check: () => void seen.push(hasIntent(surface)),
    })
    await withIntent(surface, (away) => view.emits.go!("press", away))
    expect(store.get("/open")).toBe(true)
    expect(seen).toEqual([true])
    view.dispose()
  })
})

describe("validateForm over many fields [review6 integration]", () => {
  test("writes every field's result at once: each field reads its state once, not once per field", async () => {
    const fields = 300
    const store = createStateStore({ fields: Array.from({ length: fields }, () => "") })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["go", "list"] } as never,
        go: { type: "Press", props: { name: "go" }, children: [], on: { press: { action: "validateForm" } } } as never,
        list: { type: "Box", props: {}, children: ["field"], repeat: { statePath: "/fields" } } as never,
        field: { type: "Field", props: { index: { $index: true } }, children: [] } as never,
      },
    }
    const reads = { count: 0 }
    const view = render(spec, store, {}, reads)
    await new Promise((resolve) => setTimeout(resolve, 0))
    reads.count = 0
    const started = performance.now()
    await view.emits.go!("press")
    const took = performance.now() - started
    const result = store.get("/formValidation") as { valid: boolean; errors: Record<string, string[]> }
    expect(result.valid).toBe(false)
    expect(Object.keys(result.errors)).toHaveLength(fields)
    // One write of the field states: every field reads it once (it was once per field written, 300 × 300).
    expect(reads.count).toBeLessThanOrEqual(fields)
    expect(took).toBeLessThan(500)
    view.dispose()
  })
})

describe("elements an activation shows that the task slice defers [review6 integration]", () => {
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("lendActivation puts the activation back for what it runs, and only then", async () => {
    let lend: ((run: () => void) => void) | undefined
    await withIntent(surface, async () => {
      lend = lendActivation(surface)
      // One runner per activation, so the elements it lent to wake together, in chunks.
      expect(lendActivation(surface)).toBe(lend!)
    })
    expect(lend).toBeDefined()
    // A later task: the dispatch has settled, so there is no intent, except inside what the activation lent.
    await nextTask()
    expect(hasIntent(surface)).toBe(false)
    let inside: boolean | undefined
    let again: unknown
    lend!(() => {
      inside = hasIntent(surface)
      again = lendActivation(surface)
    })
    expect(inside).toBe(true)
    // What it lent to defers again with the same runner.
    expect(again).toBe(lend)
    expect(hasIntent(surface)).toBe(false)
    // Nothing to lend without an activation, or from a passive dispatch.
    expect(lendActivation(surface)).toBeUndefined()
    await withoutIntent(surface, async () => expect(lendActivation(surface)).toBeUndefined())
  })

  test("it lends nothing once the intent's time is up", async () => {
    let lend: ((run: () => void) => void) | undefined
    const now = Date.now
    try {
      await withIntent(surface, async () => {
        lend = lendActivation(surface)
      })
      const later = now() + INTENT_TTL_MS + 1
      Date.now = () => later
      let inside: boolean | undefined
      lend!(() => (inside = hasIntent(surface)))
      expect(inside).toBe(false)
    } finally {
      Date.now = now
    }
  })

  test("a press that shows more than one task renders mounts the rest with its activation; other tasks have none", async () => {
    const rows = 1500
    const store = createStateStore({ show: false, rows: Array.from({ length: rows }, (_, index) => index) })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["go", "section"] } as never,
        go: {
          type: "Press",
          props: { name: "go" },
          children: [],
          on: { press: { action: "setState", params: { statePath: "/show", value: true } } },
        } as never,
        section: { type: "Box", props: {}, children: ["list", "last"], visible: { $state: "/show" } } as never,
        list: { type: "Box", props: {}, children: ["row"], repeat: { statePath: "/rows" } } as never,
        row: { type: "Box", props: {}, children: [] } as never,
        // Stands for a Dialog the press opened, placed after the long list.
        last: { type: "Probe", props: { name: "last" }, children: [] } as never,
      },
    }
    const seen: boolean[] = []
    const budget = createRenderBudget({ sliced: true, lend: () => lendActivation(surface) })
    const view = render(spec, store, {}, undefined, budget, (name, intent) => name === "last" && seen.push(intent))
    // Elements wait for a later task when the budget's slice is spent, or json-render's for evaluating their props.
    const pending = () => waiting() > 0 || !!evaluationsWaiting?.()
    for (let task = 0; task < 50 && pending(); task++) await nextTask()
    await withIntent(surface, (away) => view.emits.go!("press", away))
    // The press's own task could not mount it all: the rest waits for later tasks.
    expect(pending()).toBe(true)
    expect(seen).toEqual([])
    let between: boolean | undefined
    setTimeout(() => (between = hasIntent(surface)), 0)
    for (let task = 0; task < 50 && pending(); task++) await nextTask()
    expect(seen).toEqual([true])
    expect(between).toBe(false)
    expect(hasIntent(surface)).toBe(false)
    view.dispose()
  })
})

describe("a select-all whose writes go on in later tasks [review6 integration]", () => {
  test("is one user action: the stored copy keeps all of it, never the last task's part", async () => {
    // As src/gui/registry.tsx wires it: edits are kept together by json-render's work.
    groupEditsBy((jsonRender as unknown as { currentWork: () => object }).currentWork)
    try {
      const rows = 1500
      const store = createTrackedStore()
      store.setBase({ all: false, rows: Array.from({ length: rows }, () => ({ checked: false })) })
      // Each write costs a little (as a render of the row would), so the rows' watches run past json-render's time
      // slice and go on in later tasks.
      const unsubscribe = store.subscribe(() => busy(0.1))
      const spec: Spec = {
        root: "box",
        elements: {
          box: { type: "Box", props: {}, children: ["go", "list"] } as never,
          go: {
            type: "Press",
            props: { name: "go" },
            children: [],
            on: { press: { action: "setState", params: { statePath: "/all", value: true } } },
          } as never,
          list: { type: "Box", props: {}, children: ["row"], repeat: { statePath: "/rows" } } as never,
          row: {
            type: "Box",
            props: {},
            children: [],
            watch: { "/all": { action: "setState", params: { statePath: { $item: "checked" }, value: true } } },
          } as never,
        },
      }
      const warned: string[] = []
      console.warn = (...args: unknown[]) => void warned.push(String(args[0]))
      const view = render(spec, store, {})
      await view.emits.go!("press")
      for (let quiet = 0, last = -1; quiet < 5; ) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const done = (store.get("/rows") as { checked: boolean }[]).filter((row) => row.checked).length
        quiet = done === last ? quiet + 1 : 0
        last = done
      }
      unsubscribe()
      const checked = (store.get("/rows") as { checked: boolean }[]).filter((row) => row.checked).length
      expect(checked).toBe(rows)
      // It did go on in later tasks.
      expect(warned.some((warning) => warning.includes("Deferred watches and actions to the next task"))).toBe(true)
      // A reload brings back the whole select-all: its click and every row.
      expect(store.overrides()).toHaveLength(rows + 1)
      view.dispose()
    } finally {
      groupEditsBy(undefined)
    }
  })
})

describe("a large static prop in every row of a repeat [review6 integration]", () => {
  test("a value without expressions resolves to itself; one with an expression still resolves", () => {
    const ctx = { stateModel: { name: "Ada" } }
    const list = Array.from({ length: 1000 }, (_, index) => ({ id: index, tags: ["a", "b"] }))
    expect(resolvePropValue(list, ctx as never)).toBe(list)
    const mixed = { title: "x", owner: { $state: "/name" }, rows: list }
    const resolved = resolvePropValue(mixed, ctx as never) as Record<string, unknown>
    expect(resolved).not.toBe(mixed)
    expect(resolved).toEqual({ title: "x", owner: "Ada", rows: list })
    // Its static part is shared, not copied.
    expect(resolved.rows).toBe(list)
    // A key starting with "$" that is no expression still resolves as before (to a copy).
    const dollar = { $note: "kept", n: 1 }
    expect(resolvePropValue(dollar, ctx as never)).toEqual(dollar)
    // Deep nesting does not overflow the stack.
    let deep: unknown = 1
    for (let level = 0; level < 100_000; level++) deep = [deep]
    expect(resolvePropValue(deep, ctx as never)).toBe(deep)
  })

  test("two thousand rows that each carry a list of 45,000 numbers render in a fraction of a second", () => {
    // Each row resolved its props on its own and json-render copied the list for each (and genui sized each copy):
    // 90 million entries, seconds of frozen window and hundreds of megabytes for a block of 90 KB.
    const big = Array.from({ length: 45_000 }, () => 1)
    const store = createStateStore({ rows: Array.from({ length: 2000 }, () => 0) })
    const spec: Spec = {
      root: "list",
      elements: {
        list: { type: "Box", props: {}, children: ["row"], repeat: { statePath: "/rows" } } as never,
        row: { type: "Box", props: { data: big }, children: [] } as never,
      },
    }
    const started = performance.now()
    const view = render(spec, store, {}, undefined, createRenderBudget())
    expect(performance.now() - started).toBeLessThan(1000)
    // The size of a shared value is worked out once.
    const again = performance.now()
    for (let row = 0; row < 2000; row++) unitsOf({ data: big })
    expect(performance.now() - again).toBeLessThan(100)
    view.dispose()
  })
})
