import { describe, expect, test } from "bun:test"
import {
  createTrackedStore,
  isJsonValue,
  isSecretPath,
  MAX_EDIT_SIZE,
  MAX_OVERRIDES,
  tooLarge,
} from "../../src/runtime/state.ts"
import { UI_SECRET_ROOT } from "../../src/shared/constants.ts"

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

  test("an edit larger than MAX_EDIT_SIZE is ignored", () => {
    const store = createTrackedStore({ a: "x" })
    const subscribers = counter(store.subscribe)
    store.set("/a", "y".repeat(MAX_EDIT_SIZE + 1))
    store.update({ "/a": ["z".repeat(MAX_EDIT_SIZE)] })
    store.set("/b", { deep: [{ text: "w".repeat(MAX_EDIT_SIZE) }] })
    expect(store.get("/a")).toBe("x")
    expect(store.get("/b")).toBeUndefined()
    expect(subscribers.count).toBe(0)
    store.set("/a", "y".repeat(MAX_EDIT_SIZE))
    expect(String(store.get("/a")).length).toBe(MAX_EDIT_SIZE)
    expect(tooLarge(Array.from({ length: MAX_EDIT_SIZE + 1 }, () => 0))).toBe(true)
    expect(tooLarge({ a: "x", b: [1, 2] })).toBe(false)
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
    expect(store.overrides()).toEqual([["/form/name", "Grace", { b: "Ada" }]])
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
      ["/a", 10, { b: 1 }],
      ["/c", 3, {}],
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

  test("setBase keeps user edits on top while the agent leaves their paths alone, and notifies only on a real change", () => {
    const store = createTrackedStore({ a: 1, b: 1 })
    store.set("/a", 5)
    const subscribers = counter(store.subscribe)
    const edits = counter(store.onOverridesChange)
    const base = { a: 1, b: 2 }
    store.setBase(base)
    expect(store.getSnapshot()).toEqual({ a: 5, b: 2 })
    expect(subscribers.count).toBe(1)

    store.setBase(base)
    expect(subscribers.count).toBe(1)

    const before = store.getSnapshot()
    store.setBase({ a: 1, b: 2 })
    expect(store.getSnapshot()).toBe(before)
    expect(subscribers.count).toBe(1)
    expect(edits.count).toBe(0)
    expect(store.overrides()).toEqual([["/a", 5, { b: 1 }]])
  })

  test("newest writer wins: an agent change at an edit's path drops the edit and tells override listeners", () => {
    const store = createTrackedStore({ a: 1, b: 1 })
    store.set("/a", 5)
    const edits = counter(store.onOverridesChange)
    store.setBase({ a: 2, b: 1 })
    expect(store.getSnapshot()).toEqual({ a: 2, b: 1 })
    expect(store.overrides()).toEqual([])
    expect(edits.count).toBe(1)

    // The user edits again over the new value; it stays until the agent writes there once more.
    store.set("/a", 6)
    store.setBase({ a: 2, b: 3 })
    expect(store.getSnapshot()).toEqual({ a: 6, b: 3 })
    store.setBase(undefined)
    expect(store.getSnapshot()).toEqual({})
  })

  test("an agent change under an edit's path, or a replaced parent, drops it; a parent replaced with the same value does not", () => {
    const store = createTrackedStore({
      rows: [
        ["#1", "done"],
        ["#2", "running"],
      ],
      form: { name: "Ada", age: 1 },
    })
    // A dismissed row (removeState records the whole array) and a typed name.
    store.set("/rows", [["#2", "running"]])
    store.set("/form/name", "Grace")
    store.setBase({
      rows: [
        ["#1", "done"],
        ["#2", "running"],
      ],
      form: { name: "Ada", age: 2 },
    })
    expect(store.getSnapshot()).toEqual({ rows: [["#2", "running"]], form: { name: "Grace", age: 2 } })

    // The agent marks #2 done and adds #3: its rows win over the user's older edit of the list.
    const rows = [
      ["#1", "done"],
      ["#2", "done"],
      ["#3", "running"],
    ]
    store.setBase({ rows, form: { name: "Ada", age: 2 } })
    expect(store.get("/rows")).toEqual(rows)
    expect(store.get("/form/name")).toBe("Grace")
    expect(store.overrides().map(([path]) => path)).toEqual(["/form/name"])

    store.setBase({ rows })
    expect(store.getSnapshot()).toEqual({ rows })
  })

  test("auto-bound input values: a re-sent spec with the same literal keeps what the user typed, a new literal wins", () => {
    const spec = (svc: string, region: string) => ({ __genui: { svc, region } })
    const store = createTrackedStore(spec("api", "us-east-1"))
    store.set("/__genui/svc", "billing")
    store.setBase(spec("api", "us-east-1"))
    expect(store.getSnapshot()).toEqual(spec("billing", "us-east-1"))
    store.setBase(spec("api", "eu-west-1"))
    expect(store.getSnapshot()).toEqual(spec("billing", "eu-west-1"))
    store.setBase(spec("payments", "eu-west-1"))
    expect(store.getSnapshot()).toEqual(spec("payments", "eu-west-1"))
  })

  test("edits made before the first setBase take that base as what they changed", () => {
    const store = createTrackedStore()
    store.set("/a", 5)
    const edits = counter(store.onOverridesChange)
    store.setBase({ a: 1 })
    expect(store.getSnapshot()).toEqual({ a: 5 })
    expect(edits.count).toBe(0)
    store.setBase({ a: 2 })
    expect(store.getSnapshot()).toEqual({ a: 2 })
  })

  test("setBase without a change of edited paths does not touch override listeners", () => {
    const store = createTrackedStore()
    const edits = counter(store.onOverridesChange)
    store.setBase({ a: 1 })
    store.set("/b", 1)
    store.setBase({ a: 2 })
    expect(edits.count).toBe(1)
  })

  test("persisted edits record what they changed; one the agent changed since is dropped on load or at the first setBase", () => {
    const store = createTrackedStore({ a: 1, b: 2 })
    store.set("/a", 5)
    store.set("/c", 7)
    const saved = store.overrides()
    expect(saved).toEqual([
      ["/a", 5, { b: 1 }],
      ["/c", 7, {}],
    ])
    const roundTrip = JSON.parse(JSON.stringify(saved)) as unknown[][]

    // Same agent state: both come back.
    const same = createTrackedStore({ a: 1, b: 9 })
    same.loadOverrides(roundTrip)
    expect(same.getSnapshot()).toEqual({ a: 5, b: 9, c: 7 })

    // The agent wrote /a while this window was away: its value wins.
    const changed = createTrackedStore({ a: 3 })
    changed.loadOverrides(roundTrip)
    expect(changed.getSnapshot()).toEqual({ a: 3, c: 7 })
    expect(changed.overrides().map(([path]) => path)).toEqual(["/c"])

    // Loaded before the surface rendered: judged at the first setBase.
    const early = createTrackedStore()
    early.loadOverrides(roundTrip)
    const edits = counter(early.onOverridesChange)
    early.setBase({ a: 3 })
    expect(early.getSnapshot()).toEqual({ a: 3, c: 7 })
    expect(edits.count).toBe(1)

    // Entries from an older version (no third member) take the current state as their base.
    const legacy = createTrackedStore({ a: 3 })
    legacy.loadOverrides([["/a", 5]])
    expect(legacy.getSnapshot()).toEqual({ a: 5 })
    legacy.setBase({ a: 4 })
    expect(legacy.getSnapshot()).toEqual({ a: 4 })
  })

  test("edits under the secret root apply but are never persisted or loaded", () => {
    const store = createTrackedStore({ [UI_SECRET_ROOT]: { pw: "" } })
    store.set(`/${UI_SECRET_ROOT}/pw`, "hunter2")
    store.update({ [`${UI_SECRET_ROOT}/token`]: "sk-live", "/name": "Ada" })
    expect(store.get(`/${UI_SECRET_ROOT}/pw`)).toBe("hunter2")
    expect(store.get(`/${UI_SECRET_ROOT}/token`)).toBe("sk-live")
    expect(JSON.stringify(store.overrides())).not.toContain("hunter2")
    expect(JSON.stringify(store.overrides())).not.toContain("sk-live")
    expect(store.overrides().map(([path]) => path)).toEqual(["/name"])
    // A secret root lookalike is an ordinary path.
    store.set(`/${UI_SECRET_ROOT}x`, "kept")
    expect(store.overrides().map(([path]) => path)).toEqual(["/name", `/${UI_SECRET_ROOT}x`])

    const loaded = createTrackedStore({})
    loaded.loadOverrides([
      [`/${UI_SECRET_ROOT}/pw`, "from-disk"],
      [`/${UI_SECRET_ROOT}`, { pw: "x" }],
      ["/name", "Ada"],
    ])
    expect(loaded.getSnapshot()).toEqual({ name: "Ada" })
    expect(isSecretPath(`/${UI_SECRET_ROOT}`)).toBe(true)
    expect(isSecretPath(`/${UI_SECRET_ROOT}/a/b`)).toBe(true)
    expect(isSecretPath(`/__genui/pw`)).toBe(false)
  })

  test("paths declared secret (where password Inputs write) are never persisted, nor the secrets under a parent edit", () => {
    const store = createTrackedStore({ form: { user: "", pw: "" }, dbs: [{ name: "a", pw: "" }] })
    const edits = counter(store.onOverridesChange)
    store.set("/form/user", "ada")
    store.set("/form/pw", "hunter2")
    store.set("/dbs/0/pw", "s3cret")
    expect(store.overrides().map(([path]) => path)).toEqual(["/form/user", "/form/pw", "/dbs/0/pw"])
    const before = edits.count
    // The surface declares what its password Inputs are bound to; the stored copy follows.
    store.setSecrets(["/form/pw", "/dbs/*/pw"])
    expect(edits.count).toBe(before + 1)
    expect(store.overrides().map(([path]) => path)).toEqual(["/form/user"])
    expect(store.get("/form/pw")).toBe("hunter2")
    // Declaring the same paths again is a no-op.
    store.setSecrets(["/form/pw", "/dbs/*/pw"])
    expect(edits.count).toBe(before + 1)

    // A parent edit (removeState records the whole array) is stored without the secrets in it.
    store.set("/dbs", [
      { name: "a", pw: "s3cret" },
      { name: "b", pw: "other" },
    ])
    const stored = JSON.stringify(store.overrides())
    expect(stored).not.toContain("s3cret")
    expect(stored).not.toContain("other")
    expect(store.overrides().at(-1)).toEqual(["/dbs", [{ name: "a" }, { name: "b" }], { b: [{ name: "a", pw: "" }] }])

    // Any depth: `**`.
    const deep = createTrackedStore({ groups: [{ items: [{ key: "" }] }] })
    deep.setSecrets(["/**/key"])
    deep.set("/groups/0/items/0/key", "k")
    deep.set("/groups", [{ items: [{ key: "k", label: "x" }] }])
    expect(deep.overrides()).toEqual([["/groups", [{ items: [{ label: "x" }] }], { b: [{ items: [{ key: "" }] }] }]])

    // Stored entries at secret paths (from an older version) are not loaded.
    const loaded = createTrackedStore({ form: { pw: "" } })
    loaded.setSecrets(["/form/pw"])
    loaded.loadOverrides([
      ["/form/pw", "from-disk"],
      ["/form/user", "ada"],
    ])
    expect(loaded.getSnapshot()).toEqual({ form: { pw: "", user: "ada" } })
  })

  test("loading stored edits keeps the edits that are never stored (a password typed before the load)", () => {
    const store = createTrackedStore({ [UI_SECRET_ROOT]: { pw: "" }, form: { pw: "" } })
    store.setSecrets(["/form/pw"])
    store.set(`/${UI_SECRET_ROOT}/pw`, "hunter2")
    store.set("/form/pw", "s3cret")
    expect(store.overrides()).toEqual([])
    store.loadOverrides([["/name", "Ada", {}]])
    expect(store.get(`/${UI_SECRET_ROOT}/pw`)).toBe("hunter2")
    expect(store.get("/form/pw")).toBe("s3cret")
    expect(store.get("/name")).toBe("Ada")
  })

  test("an edit made on top of one the agent overwrote goes with it, instead of landing on other data", () => {
    // The user dismisses #1 (removeState records the whole array), then flags what is now the first row.
    const rows = createTrackedStore({
      rows: [
        ["#1", "done", ""],
        ["#2", "running", ""],
      ],
    })
    rows.set("/rows", [["#2", "running", ""]])
    rows.set("/rows/0/2", "FLAGGED")
    expect(rows.get("/rows")).toEqual([["#2", "running", "FLAGGED"]])
    // The agent updates #2: both edits go, rather than the flag moving onto #1.
    rows.setBase({
      rows: [
        ["#1", "done", ""],
        ["#2", "done", ""],
      ],
    })
    expect(rows.get("/rows")).toEqual([
      ["#1", "done", ""],
      ["#2", "done", ""],
    ])
    expect(rows.overrides()).toEqual([])

    // pushState of a new todo, its title typed, then the agent toggles another todo: no partial ghost row.
    const todos = createTrackedStore({
      todos: [
        { title: "a", done: false },
        { title: "b", done: false },
      ],
    })
    todos.set("/todos", [...(todos.get("/todos") as unknown[]), { title: "", done: false }])
    todos.set("/todos/2/title", "my new todo")
    todos.setBase({
      todos: [
        { title: "a", done: true },
        { title: "b", done: false },
      ],
    })
    expect(todos.get("/todos")).toEqual([
      { title: "a", done: true },
      { title: "b", done: false },
    ])

    // Unrelated later edits stay.
    const both = createTrackedStore({ rows: [1, 2], name: "" })
    both.set("/rows", [2])
    both.set("/name", "Ada")
    both.setBase({ rows: [1, 3], name: "" })
    expect(both.getSnapshot()).toEqual({ rows: [1, 3], name: "Ada" })
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
    expect(store.overrides().map(([path, value]) => [path, value])).toEqual([
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
