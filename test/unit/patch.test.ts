import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import {
  applyPatch,
  applyPatches,
  copiesRefused,
  EMPTY_SPEC,
  getAt,
  MAX_COPIED,
  parsePointer,
  replaceAll,
  setsRoot,
  writtenSize,
  type Patch,
} from "../../src/protocol/patch.ts"
import { compileSpec } from "../../src/protocol/compile.ts"

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const doc = () =>
  deepFreeze({
    root: "main",
    elements: {
      main: { type: "Stack", props: { gap: "md" }, children: ["a", "b"] },
      a: { type: "Text", props: { text: "A" }, children: [] },
      b: { type: "Text", props: { text: "B" }, children: [] },
    },
    state: { list: [1, 2, 3], form: { name: "x" } },
  })

describe("parsePointer", () => {
  test.each([
    ["", []],
    ["/", [""]],
    ["/a/b", ["a", "b"]],
    ["/a~1b/c~0d", ["a/b", "c~d"]],
    ["/~01", ["~1"]],
    ["/list/0", ["list", "0"]],
  ])("%j -> %j", (path, tokens) => {
    expect(parsePointer(path)).toEqual(tokens)
  })

  test.each(["a/b", "#/a", "/__proto__", "/a/__proto__/b", "/constructor", "/a/prototype", "/elements/x/constructor"])(
    "refuses %j",
    (path) => {
      expect(parsePointer(path)).toBeUndefined()
    },
  )
})

describe("getAt", () => {
  test("reads objects and arrays", () => {
    const value = doc()
    expect(getAt(value, ["state", "list", "1"])).toBe(2)
    expect(getAt(value, ["elements", "a", "props"])).toBe(value.elements.a.props)
    expect(getAt(value, [])).toBe(value)
  })

  test.each([
    [["state", "list", "3"]],
    [["state", "list", "-"]],
    [["state", "list", "01"]],
    [["missing", "x"]],
    [["root", "length"]],
    [["state", "toString"]],
  ])("returns undefined for %j", (tokens) => {
    expect(getAt(doc(), tokens)).toBeUndefined()
  })
})

describe("applyPatch", () => {
  test("add sets an object member and shares untouched branches", () => {
    const before = doc()
    const after = applyPatch(before, { op: "add", path: "/elements/c", value: { type: "Text", props: {} } })
    expect(after).not.toBe(before)
    expect(after.elements).not.toBe(before.elements)
    expect((after.elements as Record<string, unknown>).c).toEqual({ type: "Text", props: {} })
    expect(after.elements.main).toBe(before.elements.main)
    expect(after.elements.a).toBe(before.elements.a)
    expect(after.state).toBe(before.state)
    expect(Object.keys(before.elements)).toEqual(["main", "a", "b"])
  })

  test("add inserts into an array, shifting later items", () => {
    const before = doc()
    const after = applyPatch(before, { op: "add", path: "/state/list/1", value: 9 })
    expect(after.state.list).toEqual([1, 9, 2, 3])
    expect(before.state.list).toEqual([1, 2, 3])
    expect(after.state.form).toBe(before.state.form)
    expect(after.elements).toBe(before.elements)
  })

  test("add with - appends", () => {
    const after = applyPatch(doc(), { op: "add", path: "/elements/main/children/-", value: "c" })
    expect(after.elements.main.children).toEqual(["a", "b", "c"])
  })

  test("add at the array's length appends", () => {
    expect(applyPatch(doc(), { op: "add", path: "/state/list/3", value: 4 }).state.list).toEqual([1, 2, 3, 4])
  })

  test("add of an equal primitive is a no-op that returns the same object", () => {
    const before = doc()
    expect(applyPatch(before, { op: "add", path: "/root", value: "main" })).toBe(before)
    expect(applyPatch(before, { op: "add", path: "/state/form/name", value: "x" })).toBe(before)
  })

  test("add with an empty path replaces the document", () => {
    expect(applyPatch(doc(), { op: "add", path: "", value: { root: "x" } })).toEqual({ root: "x" } as never)
  })

  test("add creates missing parents as objects", () => {
    const after = applyPatch(EMPTY_SPEC, { op: "add", path: "/state/form/name", value: "n" })
    expect(after.state).toEqual({ form: { name: "n" } })
    expect(EMPTY_SPEC).toEqual({ root: "", elements: {} })
  })

  test("replace sets an existing member", () => {
    const before = doc()
    const after = applyPatch(before, { op: "replace", path: "/elements/a/props/text", value: "Z" })
    expect(after.elements.a.props.text).toBe("Z")
    expect(after.elements.b).toBe(before.elements.b)
    expect(after.elements.a.children).toBe(before.elements.a.children)
  })

  test("replace in an array does not shift", () => {
    expect(applyPatch(doc(), { op: "replace", path: "/state/list/0", value: 7 }).state.list).toEqual([7, 2, 3])
  })

  test("replace of an identical array item returns the same object", () => {
    const before = doc()
    expect(applyPatch(before, { op: "replace", path: "/state/list/0", value: 1 })).toBe(before)
  })

  test("replace on a missing path creates the parents", () => {
    const after = applyPatch(EMPTY_SPEC, { op: "replace", path: "/elements/x/props/label", value: "L" })
    expect(after.elements).toEqual({ x: { props: { label: "L" } } } as never)
  })

  test("remove deletes an object member", () => {
    const before = doc()
    const after = applyPatch(before, { op: "remove", path: "/elements/b" })
    expect(Object.keys(after.elements)).toEqual(["main", "a"])
    expect(after.elements.a).toBe(before.elements.a)
    expect(after.state).toBe(before.state)
  })

  test("remove deletes an array item", () => {
    expect(applyPatch(doc(), { op: "remove", path: "/state/list/1" }).state.list).toEqual([1, 3])
  })

  test.each([["/elements/missing"], ["/state/list/3"], ["/state/list/-"], ["/state/list/x"], ["/root/x"], [""]])(
    "remove of %j is a no-op",
    (path) => {
      const before = doc()
      expect(applyPatch(before, { op: "remove", path })).toBe(before)
    },
  )

  test.each([
    ["add past the end", { op: "add", path: "/state/list/5", value: 0 }],
    ["add with a leading zero", { op: "add", path: "/state/list/01", value: 0 }],
    ["replace past the end", { op: "replace", path: "/state/list/9", value: 0 }],
    ["add with a negative index", { op: "add", path: "/state/list/-1", value: 0 }],
  ] as [string, Patch][])("%s is a no-op", (_name, patch) => {
    const before = doc()
    expect(applyPatch(before, patch)).toBe(before)
  })

  test.each([
    { op: "add", path: "/__proto__/polluted", value: true },
    { op: "add", path: "/elements/__proto__", value: { polluted: true } },
    { op: "replace", path: "/constructor/prototype/polluted", value: true },
    { op: "add", path: "/state/prototype", value: 1 },
    { op: "copy", from: "/__proto__", path: "/x" },
    { op: "move", from: "/root", path: "/__proto__" },
  ] as Patch[])("refuses prototype paths: %j", (patch) => {
    const before = doc()
    expect(applyPatch(before, patch)).toBe(before)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("refuses a pointer without a leading slash", () => {
    const before = doc()
    expect(applyPatch(before, { op: "add", path: "root", value: "x" })).toBe(before)
  })

  test("move relocates a value", () => {
    const before = doc()
    const after = applyPatch(before, { op: "move", from: "/state/form", path: "/state/saved" })
    expect(after.state).toEqual({ list: [1, 2, 3], saved: { name: "x" } } as never)
    expect((after.state as Record<string, unknown>).saved).toBe(before.state.form)
  })

  test("move within an array", () => {
    expect(applyPatch(doc(), { op: "move", from: "/state/list/0", path: "/state/list/2" }).state.list).toEqual([
      2, 3, 1,
    ])
  })

  test("move to the same location changes nothing", () => {
    const before = doc()
    expect(applyPatch(before, { op: "move", from: "/state/form", path: "/state/form" })).toBe(before)
  })

  test("move into its own child is refused", () => {
    const before = doc()
    expect(applyPatch(before, { op: "move", from: "/state", path: "/state/inner" })).toBe(before)
  })

  test("copy duplicates a value and shares it", () => {
    const before = doc()
    const after = applyPatch(before, { op: "copy", from: "/elements/a", path: "/elements/c" })
    expect((after.elements as Record<string, unknown>).c).toBe(before.elements.a)
    expect(after.elements.a).toBe(before.elements.a)
  })

  test("move or copy from a missing source is a no-op", () => {
    const before = doc()
    expect(applyPatch(before, { op: "copy", from: "/missing", path: "/x" })).toBe(before)
    expect(applyPatch(before, { op: "move", from: "/missing", path: "/x" })).toBe(before)
    expect(applyPatch(before, { op: "move", path: "/x" })).toBe(before)
  })

  test("test and unknown ops are no-ops", () => {
    const before = doc()
    expect(applyPatch(before, { op: "test", path: "/root", value: "other" })).toBe(before)
    expect(applyPatch(before, { op: "nope" as never, path: "/root", value: "x" })).toBe(before)
  })

  test("never mutates the input", () => {
    const before = doc()
    const snapshot = JSON.stringify(before)
    applyPatches(before, [
      { op: "add", path: "/elements/c", value: {} },
      { op: "remove", path: "/elements/a" },
      { op: "replace", path: "/state/list/0", value: 5 },
      { op: "move", from: "/state/form", path: "/state/f" },
      { op: "copy", from: "/root", path: "/state/r" },
    ])
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe("replaceAll [R6S1-3]", () => {
  test("gives what replace operations applied one at a time give, copying each container once", () => {
    let seed = 7
    const draw = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    const tokens = ["a", "b", "0", "1", "2", "-", "x"]
    for (let round = 0; round < 3000; round++) {
      const base: unknown =
        draw(3) === 0 ? { a: [1, { b: 2 }], x: "s" } : draw(2) === 0 ? [0, [1]] : { a: { b: { x: 1 } } }
      const replacements: Array<[string[], unknown]> = []
      for (let count = 1 + draw(6); count > 0; count--) {
        const path = Array.from({ length: 1 + draw(3) }, () => tokens[draw(tokens.length)]!)
        replacements.push([path, draw(4) === 0 ? { nested: [draw(3)] } : draw(5)])
      }
      const frozen = JSON.stringify(base)
      const expected = replacements.reduce(
        (doc, [path, value]) => applyPatch(doc, { op: "replace", path: `/${path.join("/")}`, value }),
        base,
      )
      expect(replaceAll(base, replacements), JSON.stringify(replacements)).toEqual(expected as never)
      // The document it started from is not changed.
      expect(JSON.stringify(base)).toBe(frozen)
    }
    // Ten thousand values under one object: one copy of it, not ten thousand.
    const many = Array.from({ length: 10_000 }, (_, index) => [["x", `k${index}`], index] as const)
    const started = performance.now()
    const result = replaceAll({ x: {} as Record<string, number> }, many)
    expect(performance.now() - started).toBeLessThan(200)
    expect(Object.keys(result.x)).toHaveLength(10_000)
  })
})

describe("copies are bounded [R6S1-2]", () => {
  // `a_k = [a_(k-1), a_(k-1)]` by copy: the state shares each level twice, so what it holds written out doubles at each
  // step. 21 steps, 4 KB of patches, made 100 million characters, and anything that turned it into text (a canvas's
  // stored snapshot, an expression) froze the window for seconds.
  const doubling = (levels: number): Patch[] => {
    const patches: Patch[] = [{ op: "add", path: "/state", value: { a0: ["-2.2250738585072014e-308", "x"] } }]
    for (let k = 1; k <= levels; k++)
      patches.push(
        { op: "add", path: `/state/a${k}`, value: [] },
        { op: "copy", from: `/state/a${k - 1}`, path: `/state/a${k}/0` },
        { op: "copy", from: `/state/a${k - 1}`, path: `/state/a${k}/1` },
      )
    return patches
  }

  test("copies add at most MAX_COPIED to a document written out; the copy past it is left out and reported", () => {
    const spec = applyPatches(EMPTY_SPEC, doubling(21))
    expect(copiesRefused(spec)).toBe(true)
    expect(writtenSize(spec, 10 * MAX_COPIED)).toBeLessThanOrEqual(MAX_COPIED + 1000)
    const started = performance.now()
    JSON.stringify(spec)
    expect(performance.now() - started).toBeLessThan(200)
    // The levels that fit are there, whole.
    expect(getAt(spec, ["state", "a10", "1", "0"])).toEqual(getAt(spec, ["state", "a9", "0"]))
    // The spec says so.
    const compiled = compileSpec({
      ...spec,
      root: "t",
      elements: { t: { type: "Text", props: { text: "x" }, children: [] } },
    } as Spec)
    expect(compiled.issues.map((issue) => issue.code)).not.toContain("copy_too_large")
    expect(
      compileSpec(applyPatches(spec, [{ op: "add", path: "/root", value: "t" }])).issues.map((issue) => issue.code),
    ).toContain("copy_too_large")
  })

  test("copies within the bound apply as before, and a document before a refused copy says nothing", () => {
    const before = applyPatches(EMPTY_SPEC, doubling(8))
    expect(copiesRefused(before)).toBe(false)
    expect(getAt(before, ["state", "a8", "0"])).toBe(getAt(before, ["state", "a7"]))
    const big = applyPatch(before, { op: "add", path: "/state/big", value: "x".repeat(MAX_COPIED) })
    const refused = applyPatch(big, { op: "copy", from: "/state/big", path: "/state/again" })
    expect(copiesRefused(refused)).toBe(true)
    expect(getAt(refused, ["state", "again"])).toBeUndefined()
    // The document the refused copy was applied to is unchanged, and not marked.
    expect(copiesRefused(big)).toBe(false)
    // A move adds nothing: it is not counted.
    const moved = applyPatch(big, { op: "move", from: "/state/big", path: "/state/moved" })
    expect(getAt(moved, ["state", "moved"])).toBe("x".repeat(MAX_COPIED))
    expect(copiesRefused(moved)).toBe(false)
  })
})

describe("applyPatches", () => {
  const patches: Patch[] = [
    { op: "add", path: "/root", value: "main" },
    { op: "add", path: "/elements/main", value: { type: "Stack", props: {}, children: ["t"] } },
    { op: "add", path: "/elements/t", value: { type: "Text", props: { text: "hi" } } },
  ]

  test("builds a spec from the empty spec", () => {
    const spec = applyPatches(EMPTY_SPEC, patches)
    expect(spec).toEqual({
      root: "main",
      elements: {
        main: { type: "Stack", props: {}, children: ["t"] },
        t: { type: "Text", props: { text: "hi" } },
      },
    } as Spec)
  })

  test("continues from an index", () => {
    const partial = applyPatches(EMPTY_SPEC, patches.slice(0, 2))
    const resumed = applyPatches(partial, patches, 2)
    expect(resumed).toEqual(applyPatches(EMPTY_SPEC, patches))
    expect(resumed.elements.main).toBe(partial.elements.main)
  })

  test("an index past the end returns the input", () => {
    expect(applyPatches(EMPTY_SPEC, patches, 3)).toBe(EMPTY_SPEC)
    expect(applyPatches(EMPTY_SPEC, [])).toBe(EMPTY_SPEC)
  })
})

describe("setsRoot", () => {
  test.each([
    [{ op: "add", path: "/root", value: "a" }, true],
    [{ op: "replace", path: "/root", value: "a" }, true],
    [{ op: "add", path: "", value: {} }, true],
    [{ op: "remove", path: "/root" }, false],
    [{ op: "add", path: "/elements/root", value: {} }, false],
    [{ op: "copy", from: "/x", path: "/root" }, false],
  ] as [Patch, boolean][])("%j -> %p", (patch, expected) => {
    expect(setsRoot(patch)).toBe(expected)
  })
})
