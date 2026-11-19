import { describe, expect, test } from "bun:test"
import { createTrackedStore, isJsonValue, MAX_OVERRIDES } from "../../src/runtime/state.ts"

function counter(subscribe: (listener: () => void) => () => void) {
  const calls = { count: 0 }
  subscribe(() => calls.count++)
  return calls
}

describe("createTrackedStore", () => {
  test("reads the base and keeps its identity until something changes", () => {
    const base = { form: { name: "Ada" }, items: [1, 2] }
    const store = createTrackedStore(base)
    expect(store.getSnapshot()).toBe(base)
    expect(store.get("/form/name")).toBe("Ada")
    expect(store.get("form/name")).toBe("Ada")
    expect(store.get("/items/1")).toBe(2)
    expect(store.get("/missing/x")).toBeUndefined()
    expect(store.get("/")).toBe(base)
    expect(store.getServerSnapshot?.()).toBe(base)
  })

  test("set records an override, updates the snapshot immutably and notifies", () => {
    const base = { form: { name: "Ada", age: 36 }, other: { x: 1 } }
    const store = createTrackedStore(base)
    const subscribers = counter(store.subscribe)
    const edits = counter(store.onOverridesChange)
    store.set("/form/name", "Grace")
    const snapshot = store.getSnapshot()
    expect(snapshot).toEqual({ form: { name: "Grace", age: 36 }, other: { x: 1 } })
    expect(snapshot.other).toBe(base.other)
    expect(base.form.name).toBe("Ada")
    expect(store.overrides()).toEqual([["/form/name", "Grace"]])
    expect(subscribers.count).toBe(1)
    expect(edits.count).toBe(1)
    expect(store.getSnapshot()).toBe(snapshot)

    store.set("/form/name", "Grace")
    expect(subscribers.count).toBe(1)
    expect(edits.count).toBe(1)
  })

  test("creates missing parents", () => {
    const store = createTrackedStore()
    store.set("/a/b/c", 1)
    expect(store.getSnapshot()).toEqual({ a: { b: { c: 1 } } })
  })

  test("update writes several paths with one notification", () => {
    const store = createTrackedStore({ a: 1, b: 2 })
    const subscribers = counter(store.subscribe)
    store.update({ "/a": 10, "/b": 2, "/c": 3 })
    expect(store.getSnapshot()).toEqual({ a: 10, b: 2, c: 3 })
    expect(store.overrides()).toEqual([
      ["/a", 10],
      ["/c", 3],
    ])
    expect(subscribers.count).toBe(1)
  })

  test("a write drops earlier overrides of its descendants and of itself", () => {
    const store = createTrackedStore()
    store.set("/form/name", "a")
    store.set("/form/age", 3)
    store.set("/formula", "kept")
    store.set("/form", { name: "b" })
    expect(store.overrides()).toEqual([
      ["/formula", "kept"],
      ["/form", { name: "b" }],
    ])
    store.set("/formula", "again")
    expect(store.overrides()).toEqual([
      ["/form", { name: "b" }],
      ["/formula", "again"],
    ])
  })

  test("setBase keeps user edits on top and notifies only on a real change", () => {
    const store = createTrackedStore({ a: 1, b: 1 })
    store.set("/a", 5)
    const subscribers = counter(store.subscribe)
    const base = { a: 2, b: 2 }
    store.setBase(base)
    expect(store.getSnapshot()).toEqual({ a: 5, b: 2 })
    expect(subscribers.count).toBe(1)

    store.setBase(base)
    expect(subscribers.count).toBe(1)

    const before = store.getSnapshot()
    store.setBase({ a: 2, b: 2 })
    expect(store.getSnapshot()).toBe(before)
    expect(subscribers.count).toBe(1)

    store.setBase(undefined)
    expect(store.getSnapshot()).toEqual({ a: 5 })
    expect(subscribers.count).toBe(2)
  })

  test("setBase does not touch override listeners", () => {
    const store = createTrackedStore()
    const edits = counter(store.onOverridesChange)
    store.setBase({ a: 1 })
    expect(edits.count).toBe(0)
  })

  test("loadOverrides restores edits without override notifications", () => {
    const store = createTrackedStore({ a: 1, list: [1, 2] })
    const subscribers = counter(store.subscribe)
    const edits = counter(store.onOverridesChange)
    store.loadOverrides([
      ["/a", 2],
      ["/list/0", 9],
      ["bad" as string, 3],
      [42 as unknown as string, 1],
      ["/__proto__/polluted", true],
    ])
    expect(store.getSnapshot()).toEqual({ a: 2, list: [9, 2], bad: 3 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(subscribers.count).toBe(1)
    expect(edits.count).toBe(0)
    expect(store.overrides()).toEqual([
      ["/a", 2],
      ["/list/0", 9],
      ["/bad", 3],
    ])
  })

  test("reset drops edits, returns to the base and tells override listeners", () => {
    const base = { a: 1 }
    const store = createTrackedStore(base)
    store.set("/a", 2)
    const edits = counter(store.onOverridesChange)
    store.reset()
    expect(store.getSnapshot()).toBe(base)
    expect(store.overrides()).toEqual([])
    expect(edits.count).toBe(1)
    store.reset()
    expect(edits.count).toBe(1)
  })

  test("values that are not JSON apply but are not persisted", () => {
    const store = createTrackedStore()
    const fn = () => {}
    store.set("/fn", fn)
    store.set("/date", new Date(0))
    store.set("/nan", Number.NaN)
    store.set("/undef", undefined)
    store.set("/ok", { nested: [1, "two", null, { undefinedMember: undefined }] })
    expect(store.get("/fn")).toBe(fn)
    expect(store.get("/date")).toBeInstanceOf(Date)
    expect(store.overrides().map(([path]) => path)).toEqual(["/ok"])
  })

  test("caps overrides at the newest 500", () => {
    const store = createTrackedStore()
    for (let index = 0; index < MAX_OVERRIDES + 10; index++) store.set(`/k${index}`, index)
    const overrides = store.overrides()
    expect(overrides).toHaveLength(MAX_OVERRIDES)
    expect(overrides[0]![0]).toBe("/k10")
    expect(store.get("/k9")).toBeUndefined()
    expect(store.get(`/k${MAX_OVERRIDES + 9}`)).toBe(MAX_OVERRIDES + 9)
  })

  test("overrides() keeps its identity until edits change", () => {
    const store = createTrackedStore()
    store.set("/a", 1)
    const first = store.overrides()
    expect(store.overrides()).toBe(first)
    store.set("/b", 1)
    expect(store.overrides()).not.toBe(first)
  })

  test("ignores writes to the root and to prototype keys", () => {
    const store = createTrackedStore({ a: 1 })
    const before = store.getSnapshot()
    store.set("/", { b: 2 })
    store.set("", { b: 2 })
    store.set("/__proto__/x", 1)
    store.set("/constructor/prototype/x", 1)
    expect(store.getSnapshot()).toBe(before)
    expect(store.overrides()).toEqual([])
  })

  test("unsubscribe stops notifications and a throwing listener does not stop the others", () => {
    const store = createTrackedStore()
    const calls: string[] = []
    const off = store.subscribe(() => calls.push("first"))
    store.subscribe(() => {
      throw new Error("boom")
    })
    store.onOverridesChange(() => calls.push("edits"))
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args[1])
    try {
      store.set("/a", 1)
      off()
      store.set("/a", 2)
    } finally {
      console.error = original
    }
    expect(calls).toEqual(["first", "edits", "edits"])
    expect(errors).toHaveLength(2)
  })
})

describe("isJsonValue", () => {
  test("accepts JSON and rejects everything else", () => {
    expect(isJsonValue({ a: [1, "b", true, null] })).toBe(true)
    expect(isJsonValue(Object.create(null))).toBe(true)
    expect(isJsonValue(undefined)).toBe(false)
    expect(isJsonValue(Infinity)).toBe(false)
    expect(isJsonValue(1n)).toBe(false)
    expect(isJsonValue([undefined])).toBe(false)
    expect(isJsonValue(new Map())).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isJsonValue(cyclic)).toBe(false)
  })
})
