import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import { itemKeys } from "../../src/runtime/item-keys.ts"
import { createTrackedStore, type TrackedStore } from "../../src/runtime/state.ts"

const todos = (...items: Array<[string, boolean]>) => items.map(([title, done]) => ({ title, done }))
const checked = (store: TrackedStore) =>
  (store.get("/todos") as Array<{ title: string; done: boolean }>).map(({ title, done }) => `${title}=${done}`)

function counter(subscribe: (listener: () => void) => () => void) {
  const calls = { count: 0 }
  subscribe(() => calls.count++)
  return calls
}

describe("secrets stay secret for the life of the edits [review4 SECURITY#3]", () => {
  test("a typed password is not stored once the agent's next version no longer declares its Input", () => {
    const store = createTrackedStore({ form: { name: "", pw: "" } })
    store.setSecrets(["/form/pw"])
    store.set("/form/pw", "hunter2-S3cret!")
    store.set("/form/name", "db")
    expect(JSON.stringify(store.overrides())).not.toContain("hunter2")
    // The agent's patch removed the password Input (or made it a plain field): nothing declares /form/pw any more.
    const edits = counter(store.onOverridesChange)
    store.setSecrets([])
    expect(JSON.stringify(store.overrides())).not.toContain("hunter2")
    expect(store.overrides().map(([path]) => path)).toEqual(["/form/name"])
    expect(edits.count).toBe(0)
    // Nor inside a parent edit, nor after another declaration.
    store.setSecrets(["/other"])
    store.set("/form", { name: "db", pw: "hunter2-S3cret!" })
    expect(JSON.stringify(store.overrides())).not.toContain("hunter2")
    // The password still applies in memory.
    expect(store.get("/form/pw")).toBe("hunter2-S3cret!")
  })

  test("once the edits are gone (reset, a new generation), only what the spec declares now is secret", () => {
    const store = createTrackedStore({ form: { pw: "" } })
    store.setSecrets(["/form/pw"])
    store.set("/form/pw", "hunter2")
    store.setSecrets([])
    store.reset()
    store.set("/form/pw", "plain now")
    expect(store.overrides().map(([path]) => path)).toEqual(["/form/pw"])
    // A reset keeps what is declared now.
    store.setSecrets(["/form/pw"])
    store.reset()
    store.set("/form/pw", "secret again")
    expect(store.overrides()).toEqual([])
  })
})

describe("an edit of a list item follows the item [review4 RENDER#1]", () => {
  const keyed = [{ path: "/todos", key: "title" }]

  test("keyed: the agent inserts, removes or moves items before the edited one", () => {
    const store = createTrackedStore({ todos: todos(["A", false], ["B", false], ["C", false]) })
    store.setItemKeys(keyed)
    store.set("/todos/1/done", true)
    expect(checked(store)).toEqual(["A=false", "B=true", "C=false"])

    const edits = counter(store.onOverridesChange)
    store.setBase({ todos: todos(["N", false], ["A", false], ["B", false], ["C", false]) })
    // Before, the check stayed at index 1 and landed on A (and was sent for A).
    expect(checked(store)).toEqual(["N=false", "A=false", "B=true", "C=false"])
    expect(store.overrides().map(([path]) => path)).toEqual(["/todos/2/done"])
    // The stored copy follows the move.
    expect(edits.count).toBe(1)

    store.setBase({ todos: todos(["A", false], ["B", false], ["C", false]) })
    expect(checked(store)).toEqual(["A=false", "B=true", "C=false"])
    store.setBase({ todos: todos(["C", false], ["A", false], ["B", false]) })
    expect(checked(store)).toEqual(["C=false", "A=false", "B=true"])
  })

  test("keyed: the edit stays with its item while the agent changes the item's other fields, and goes with it", () => {
    const store = createTrackedStore({
      todos: [
        { title: "A", done: false, status: "todo" },
        { title: "B", done: false, status: "todo" },
      ],
    })
    store.setItemKeys(keyed)
    store.set("/todos/1/done", true)
    store.setBase({
      todos: [
        { title: "N", done: false, status: "todo" },
        { title: "A", done: false, status: "todo" },
        { title: "B", done: false, status: "running" },
      ],
    })
    expect(store.get("/todos/2")).toEqual({ title: "B", done: true, status: "running" })
    // Removing an item before it moves it again; then the agent writes the field the user changed: the newest writer
    // wins.
    store.setBase({
      todos: [
        { title: "N", done: false, status: "todo" },
        { title: "B", done: false, status: "running" },
      ],
    })
    expect(store.get("/todos/1/done")).toBe(true)
    store.setBase({
      todos: [
        { title: "N", done: false, status: "todo" },
        { title: "B", done: "skipped", status: "done" },
      ],
    })
    expect(store.overrides()).toEqual([])
    expect(store.get("/todos/1/done")).toBe("skipped")

    // The item is removed: the edit goes instead of landing on another item.
    const gone = createTrackedStore({ todos: todos(["A", false], ["B", false], ["C", false]) })
    gone.setItemKeys(keyed)
    gone.set("/todos/1/done", true)
    gone.setBase({ todos: todos(["A", false], ["C", false], ["D", false]) })
    expect(checked(gone)).toEqual(["A=false", "C=false", "D=false"])
    expect(gone.overrides()).toEqual([])
  })

  test("without a key: the item is found by its content, apart from the edited field", () => {
    const store = createTrackedStore({
      files: [
        { path: "a.ts", note: "" },
        { path: "b.ts", note: "" },
      ],
    })
    store.set("/files/1/note", "needs tests")
    store.setBase({
      files: [
        { path: "README.md", note: "" },
        { path: "a.ts", note: "" },
        { path: "b.ts", note: "" },
      ],
    })
    expect(store.get("/files")).toEqual([
      { path: "README.md", note: "" },
      { path: "a.ts", note: "" },
      { path: "b.ts", note: "needs tests" },
    ])
    // Typing on writes the item's new path, not the old index.
    store.set("/files/2/note", "needs tests too")
    expect(store.overrides().map(([path]) => path)).toEqual(["/files/2/note"])

    // The agent changes the item in place (same length): the edit stays.
    store.setBase({
      files: [
        { path: "README.md", note: "" },
        { path: "a.ts", note: "" },
        { path: "b.ts", note: "", lines: 120 },
      ],
    })
    expect(store.get("/files/2")).toEqual({ path: "b.ts", note: "needs tests too", lines: 120 })
    // ...and it is followed from there when items move again.
    store.setBase({
      files: [
        { path: "b.ts", note: "", lines: 120 },
        { path: "a.ts", note: "" },
      ],
    })
    expect(store.get("/files/0/note")).toBe("needs tests too")

    // Changed and moved at once, without a key to tell: the edit goes rather than guess.
    store.setBase({
      files: [
        { path: "c.ts", note: "" },
        { path: "a.ts", note: "" },
        { path: "b.ts", note: "", lines: 200 },
      ],
    })
    expect(store.overrides()).toEqual([])
  })

  test("primitive items: a distinct value is followed, equal values keep the edit where it was", () => {
    const store = createTrackedStore({ tags: ["a", "b"] })
    store.set("/tags/1", "b!")
    store.setBase({ tags: ["x", "a", "b"] })
    expect(store.get("/tags")).toEqual(["x", "a", "b!"])

    const blanks = createTrackedStore({ emails: ["", "", ""] })
    blanks.set("/emails/1", "ada@example.com")
    blanks.setBase({ emails: ["", "", "", ""] })
    expect(blanks.get("/emails")).toEqual(["", "ada@example.com", "", ""])
  })

  test("nested lists: each level follows its own item", () => {
    const groups = (...names: string[]) =>
      names.map((name) => ({ name, items: [{ id: `${name}1` }, { id: `${name}2` }] }))
    const store = createTrackedStore({ groups: groups("g", "h") })
    store.setItemKeys(itemKeys(nestedSpec))
    store.set("/groups/1/items/1/done", true)
    const next = groups("f", "g", "h")
    next[2]!.items.unshift({ id: "h0" })
    store.setBase({ groups: next })
    expect(store.overrides().map(([path]) => path)).toEqual(["/groups/2/items/2/done"])
    expect(store.get("/groups/2/items/2")).toEqual({ id: "h2", done: true })
  })

  test("the items an edit follows are stored with it, so a reload after the agent moved them still finds them", () => {
    const store = createTrackedStore({ todos: todos(["A", false], ["B", false]) })
    store.set("/todos/1/done", true)
    const saved = JSON.parse(JSON.stringify(store.overrides())) as unknown[][]
    expect(saved).toEqual([["/todos/1/done", true, { b: false, i: [[1, { title: "B", done: false }, 2]] }]])

    // The agent inserted an item while this window was away.
    const later = createTrackedStore()
    later.loadOverrides(saved)
    later.setBase({ todos: todos(["N", false], ["A", false], ["B", false]) })
    expect(checked(later)).toEqual(["N=false", "A=false", "B=true"])
    expect(later.overrides().map(([path]) => path)).toEqual(["/todos/2/done"])

    // An entry from before levels were stored judges the item at its index by the base it loads into.
    const legacy = createTrackedStore({ todos: todos(["N", false], ["A", false], ["B", false]) })
    legacy.loadOverrides([["/todos/1/done", true, { b: false }]])
    expect(checked(legacy)).toEqual(["N=false", "A=true", "B=false"])
    legacy.setBase({ todos: todos(["A", false], ["B", false]) })
    expect(checked(legacy)).toEqual(["A=true", "B=false"])

    // Levels that do not fit the path are ignored.
    const odd = createTrackedStore({ todos: todos(["A", false], ["B", false]) })
    odd.loadOverrides([["/todos/1/done", true, { b: false, i: [[0, {}, 2]] }]])
    expect(checked(odd)).toEqual(["A=false", "B=true"])
  })

  test("stored levels stay small: a keyed item as its key, and none when an item is too big", () => {
    const store = createTrackedStore({ todos: [{ title: "B", done: false, notes: "x".repeat(100) }] })
    store.setItemKeys([{ path: "/todos", key: "title" }])
    store.set("/todos/0/done", true)
    expect(store.overrides()).toEqual([["/todos/0/done", true, { b: false, i: [[1, { title: "B" }, 1]] }]])
    const later = createTrackedStore()
    later.setItemKeys([{ path: "/todos", key: "title" }])
    later.loadOverrides(JSON.parse(JSON.stringify(store.overrides())) as unknown[][])
    later.setBase({
      todos: [
        { title: "A", done: false },
        { title: "B", done: false, notes: "changed" },
      ],
    })
    expect(later.get("/todos/1/done")).toBe(true)

    const big = createTrackedStore({ groups: [{ items: Array.from({ length: 200 }, (_, index) => ({ id: index })) }] })
    big.set("/groups/0/items/3/done", true)
    expect(big.overrides()).toEqual([["/groups/0/items/3/done", true, {}]])
  })

  test("an edit at the item itself (a whole todo) follows it too", () => {
    const store = createTrackedStore({ todos: todos(["A", false], ["B", false]) })
    store.setItemKeys(keyed)
    store.set("/todos/1", { title: "B", done: true })
    store.setBase({ todos: todos(["N", false], ["A", false], ["B", false]) })
    expect(checked(store)).toEqual(["N=false", "A=false", "B=true"])
  })
})

const nestedSpec = {
  root: "groups",
  elements: {
    groups: { type: "Stack", props: {}, children: ["group"], repeat: { statePath: "/groups", key: "name" } },
    group: { type: "Card", props: {}, children: ["items"] },
    items: { type: "Stack", props: {}, children: ["item"], repeat: { statePath: { $item: "items" }, key: "id" } },
    item: { type: "Checkbox", props: { checked: { $bindItem: "done" } }, children: [] },
  },
} as unknown as Spec

describe("itemKeys", () => {
  test("lists the repeats with a key, nested ones as patterns", () => {
    expect(itemKeys(nestedSpec)).toEqual([
      { path: "/groups", key: "name" },
      { path: "/groups/*/items", key: "id" },
    ])
    const unkeyed = {
      root: "list",
      elements: { list: { type: "Stack", props: {}, children: [], repeat: { statePath: "/todos" } } },
    } as unknown as Spec
    expect(itemKeys(unkeyed)).toEqual([])
    expect(itemKeys(null)).toEqual([])
    // The same spec object gives the same result.
    expect(itemKeys(nestedSpec)).toBe(itemKeys(nestedSpec))
  })
})
