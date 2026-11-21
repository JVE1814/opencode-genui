import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createComponent, createEffect, createMemo, createRoot, on, type JSX } from "solid-js"
import { createStateStore, type Spec, type StateStore } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import type { ComponentRegistry } from "@json-render/solid"
import { buildRegistry, createElementRenderer, guardDirectives, type ElementImpl } from "../../src/gui/element.ts"
import { evaluationsDone } from "./evaluations.ts"
import { seeded } from "./random.ts"

// Regression tests for the seventh review's findings in the json-render patches (patches/@json-render%2Fsolid):
// [R6S3-1] repeat rows matched in quadratic time over the whole list, [R6S3-3] an activation's waiting list shared its
// task with other work's lists, [R6F3-3] the cap on waiting tasks cut a change that was within its counts. See
// test/unit/review6-watch.test.ts for the rules these follow, and test/e2e/review7-patch.spec.ts for the same in the
// window.

const globals = globalThis as { window?: unknown; event?: unknown }
globals.window = { document: { addEventListener() {} } }
const solid = await import("@json-render/solid")
const { JSONUIProvider, Renderer, useStateStore } = solid
delete globals.window

type RowIds = (list: unknown, repeat?: { readonly key?: string }, limit?: number) => string[]
const { createRowIds } = solid as unknown as { readonly createRowIds: () => RowIds }

const flatten = (value: unknown): unknown[] =>
  typeof value === "function"
    ? flatten((value as () => unknown)())
    : Array.isArray(value)
      ? value.flatMap(flatten)
      : value === null || value === undefined
        ? []
        : [value]

type Away = (waiting: boolean) => void

/** Renders `spec` over `store`, with action `handlers`; `Kick` hands out the provider's `set` (a write). */
function render(spec: Spec, store: StateStore, components: Record<string, ElementImpl> = {}, handlers = {}) {
  let set: ((path: string, value: unknown) => void) | undefined
  const emits: Record<string, (event: string, away?: Away) => Promise<unknown>> = {}
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
      emit: (name: string, away?: Away) => emits[name]!("press", away),
      dispose,
    }
  })
}

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
const elapsed = (run: () => unknown) => {
  const started = performance.now()
  run()
  return performance.now() - started
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

/**
 * The row matching before the seventh review (patches at HEAD 5cf14bf), over the rows that render: the reference the
 * linear one must agree with. Quadratic: an item looks through every previous index of an equal item, and through every
 * previous item for its key.
 */
function referenceRowIds(): RowIds {
  let previousItems: unknown[] = []
  let previousIds: string[] = []
  let next = 0
  return (list, repeat, limit = 2000) => {
    const items = (Array.isArray(list) ? list : []).slice(0, limit)
    const keyOf = (item: unknown) =>
      repeat?.key && typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)[repeat.key]
        : undefined
    const ids: string[] = new Array(items.length)
    const used = new Set<number>()
    const byItem = new Map<unknown, number[]>()
    previousItems.forEach((item, index) => byItem.set(item, [...(byItem.get(item) ?? []), index]))
    items.forEach((item, index) => {
      if (index < previousItems.length && Object.is(previousItems[index], item)) {
        ids[index] = previousIds[index]!
        used.add(index)
      }
    })
    items.forEach((item, index) => {
      if (ids[index] !== undefined) return
      let found: number | undefined
      for (const at of byItem.get(item) ?? [])
        if (!used.has(at) && (found === undefined || Math.abs(at - index) < Math.abs(found - index))) found = at
      if (found === undefined) return
      ids[index] = previousIds[found]!
      used.add(found)
    })
    items.forEach((item, index) => {
      if (ids[index] !== undefined) return
      const key = keyOf(item)
      if (key === undefined || key === null) return
      const found = previousItems.findIndex((old, at) => !used.has(at) && String(keyOf(old)) === String(key))
      if (found === -1) return
      ids[index] = previousIds[found]!
      used.add(found)
    })
    items.forEach((_, index) => {
      if (ids[index] !== undefined) return
      if (index < previousIds.length && !used.has(index)) {
        ids[index] = previousIds[index]!
        used.add(index)
      } else ids[index] = `r${next++}`
    })
    previousItems = items
    previousIds = ids
    return ids
  }
}

describe("repeat rows are matched in linear time, over the rows that render [R6S3-1]", () => {
  test("32,000 alternating primitives with the first removed: each row keeps a row of an equal item, at once", () => {
    // Each item without a row at its index looked through every previous index holding an equal item: 11 s.
    const list = Array.from({ length: 32000 }, (_, index) => index % 2)
    const rendered = createRowIds()
    const before = rendered(list, {})
    expect(before).toHaveLength(2000)
    let after: string[] = []
    expect(elapsed(() => (after = rendered(list.slice(1), {})))).toBeLessThan(50)
    // Only the rows that render are matched; each but the last takes the row of an equal item next to it.
    expect(after).toHaveLength(2000)
    const kept = new Set(before)
    expect(after.slice(0, 1999).every((id) => kept.has(id))).toBe(true)
    expect(new Set(after).size).toBe(2000)
    // The matching itself is linear, whatever the limit.
    const whole = createRowIds()
    whole(list, {}, list.length)
    expect(elapsed(() => whole(list.slice(1), {}, list.length))).toBeLessThan(50)
  })

  test("16,000 keyed items swapped for fresh ones: each row follows its key, at once", () => {
    // Each fresh item looked for its key with findIndex over every previous item: 2.5 s for one click.
    const empty = () => Array.from({ length: 16000 }, () => [] as unknown[])
    const sameKey = createRowIds()
    const first = sameKey(empty(), { key: "length" }, 16000)
    let second: string[] = []
    expect(elapsed(() => (second = sameKey(empty(), { key: "length" }, 16000)))).toBeLessThan(50)
    expect(second).toEqual(first)
    // Distinct keys, in reverse order: each row moves with its item.
    const items = (order: number[]) => order.map((id) => ({ id }))
    const ascending = Array.from({ length: 16000 }, (_, index) => index)
    const byId = createRowIds()
    const ids = byId(items(ascending), { key: "id" }, 16000)
    let reversed: string[] = []
    expect(elapsed(() => (reversed = byId(items([...ascending].reverse()), { key: "id" }, 16000)))).toBeLessThan(50)
    expect(reversed).toEqual([...ids].reverse())
  })

  test("the linear matching gives the rows the quadratic one gave", () => {
    const draw = seeded(7)
    const next = () => draw(1_000_000) / 1_000_000
    const shared = [{ id: "s0" }, { id: "s1" }, { id: "s2" }]
    for (let round = 0; round < 2000; round++) {
      const repeat = next() < 0.5 ? { key: "id" } : {}
      const limit = next() < 0.3 ? 1 + Math.floor(next() * 6) : 2000
      const linear = createRowIds()
      const reference = referenceRowIds()
      let list: unknown[] = []
      for (let step = 0; step < 6; step++) {
        const previous = list
        list = Array.from({ length: Math.floor(next() * 12) }, () => {
          const pick = Math.floor(next() * 6)
          if (pick === 0) return Math.floor(next() * 3)
          if (pick === 1) return shared[Math.floor(next() * shared.length)]
          if (pick === 2 && previous.length > 0) return previous[Math.floor(next() * previous.length)]
          if (pick === 3) return { id: `k${Math.floor(next() * 5)}` }
          if (pick === 4) return `t${Math.floor(next() * 3)}`
          return { id: Math.floor(next() * 4) }
        })
        expect(linear(list, repeat, limit)).toEqual(reference(list, repeat, limit))
      }
    }
  })

  test("removing the first of 32,000 alternating primitives in a rendered repeat is one short write", async () => {
    const store = createStateStore({ rows: Array.from({ length: 32000 }, (_, index) => index % 2) })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["kick", "list"] },
        kick: { type: "Kick", props: {}, children: [] },
        list: { type: "Box", props: {}, children: ["row"], repeat: { statePath: "/rows" } },
        row: { type: "Text", props: { text: { $item: "" } }, children: [] },
      },
    }
    const view = render(spec, store)
    try {
      await evaluationsDone()
      expect(view.text().filter((text) => text === "0" || text === "1")).toHaveLength(2000)
      // The whole write: the list's memo, the row matching, and the rows that moved (10 s before, in one batch flush).
      expect(elapsed(() => view.set("/rows", (store.get("/rows") as number[]).slice(1)))).toBeLessThan(500)
      await evaluationsDone()
      expect(
        view
          .text()
          .filter((text) => text === "0" || text === "1")
          .slice(0, 3),
      ).toEqual(["1", "0", "1"])
    } finally {
      view.dispose()
      // (What this list left waiting, also when an expectation failed, is done before the next test.)
      await evaluationsDone()
    }
  })
})

describe("an activation's list that waits for a later task goes on in a task of its own [R6S3-3]", () => {
  /**
   * A press's list whose actions wait for later tasks, told through `away` as genui's withIntent hears it (see
   * src/gui/outward.ts): its intent is live while the press is dispatched and none of its lists waits. `Probe` stands
   * for a Dialog: an effect that follows /open in the state (as the Dialog's binding does, not through its evaluated
   * props, which may wait for a later task), and notes whether the intent was live each time it saw it turn true.
   */
  function pressAndProbe(press: unknown[]) {
    const store = createStateStore({ q: "", open: false, x: 0 })
    const seen: boolean[] = []
    let active = false
    let waiting = 0
    const away: Away = (now) => {
      if (now) waiting++
      else if (waiting > 0) waiting--
    }
    const Probe: ElementImpl = () => {
      const state = useStateStore()
      const open = createMemo(() => (state.state as { open?: unknown }).open === true)
      createEffect(
        on(open, (now) => {
          if (now) seen.push(active && waiting === 0)
        }),
      )
      return "probe" as never
    }
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["kick", "go", "notes", "dialog"] },
        kick: { type: "Kick", props: {}, children: [] },
        go: { type: "Press", props: { name: "go" }, children: [], on: { press: press as never } },
        // A field whose watch opens the dialog as the user types.
        notes: {
          type: "Text",
          props: { text: "notes" },
          children: [],
          watch: { "/q": { action: "setState", params: { statePath: "/open", value: true } } },
        },
        dialog: { type: "Probe", props: {}, children: [] },
      },
    }
    const view = render(spec, store, { Probe }, { slow: () => void busy(60) })
    const pressed = async () => {
      active = true
      try {
        await view.emit("go", away)
      } finally {
        active = false
      }
    }
    return { store, view, seen, pressed }
  }

  test("a keystroke whose watch waits too does not run with the press's intent", async () => {
    // Each slow action uses up the task's slice, so each setState after it waits for a later task.
    const set = (value: number) => ({ action: "setState", params: { statePath: "/x", value } })
    const { store, view, seen, pressed } = pressAndProbe([
      { action: "slow" },
      set(1),
      { action: "slow" },
      set(2),
      { action: "slow" },
      set(3),
    ])
    const done = pressed()
    // (The press's first action ran; its setState waits.)
    for (let index = 0; index < 10; index++) await Promise.resolve()
    // A keystroke in the same task (one that came before the timer ending the long task): its watch finds the slice
    // spent and waits as well. Both lists' jobs ran in one batch, the press's intent put back for all of it, and the
    // watch's write opened the dialog with it.
    globals.event = { isTrusted: true, type: "input" }
    try {
      view.set("/q", "x")
    } finally {
      delete globals.event
    }
    await done
    await settle(store)
    expect(store.get("/open")).toBe(true)
    expect(store.get("/x")).toBe(3)
    expect(seen).toEqual([false])
    view.dispose()
  })

  test("a press whose own deferred setState opens the dialog still opens it with its intent", async () => {
    const { store, view, seen, pressed } = pressAndProbe([
      { action: "slow" },
      { action: "setState", params: { statePath: "/open", value: true } },
    ])
    await pressed()
    await settle(store)
    expect(warnings.some((warning) => warning.includes("Deferred watches and actions to the next task"))).toBe(true)
    expect(seen).toEqual([true])
    view.dispose()
  })
})

describe("the cap on waiting tasks cuts only work that keeps setting off more work [R6F3-3]", () => {
  test("a select-all whose rows write four times ticks every row, however many tasks a slow machine takes", async () => {
    // Every write here takes 3 ms (a slow machine): 250 rows × 4 writes are 3 s of actions, 60 tasks of 50 ms. Lists
    // were skipped once lists had waited 40 tasks in a row, so the select-all stopped partway with an issue, though it
    // made 1,000 of the 8,000 state actions one change may make.
    const rows = 250
    const base = createStateStore({
      all: false,
      rows: Array.from({ length: rows }, () => ({ checked: false, a: false, b: false, c: false })),
    })
    const store: StateStore = {
      ...base,
      set: (path, value) => {
        busy(3)
        base.set(path, value)
      },
    }
    const write = (field: string) => ({
      action: "setState",
      params: { statePath: { $item: field }, value: { $state: "/all" } },
    })
    const spec: Spec = {
      root: "box",
      elements: {
        box: { type: "Box", props: {}, children: ["kick", "list"] },
        kick: { type: "Kick", props: {}, children: [] },
        list: { type: "Box", props: {}, children: ["row"], repeat: { statePath: "/rows" } },
        row: {
          type: "Text",
          props: { text: "row" },
          children: [],
          watch: { "/all": [write("checked"), write("a"), write("b"), write("c")] },
        },
      },
    }
    const view = render(spec, store)
    view.set("/all", true)
    await settle(store)
    const ticked = (store.get("/rows") as { checked: boolean; c: boolean }[]).filter((row) => row.checked && row.c)
    expect(ticked).toHaveLength(rows)
    expect(warnings.filter((warning) => warning.includes("Skipped"))).toEqual([])
    view.dispose()
  }, 30_000)
})
