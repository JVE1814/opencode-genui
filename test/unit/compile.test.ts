import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import { compileBlock, compileSpec } from "../../src/protocol/compile.ts"
import { applyPatch, EMPTY_SPEC } from "../../src/protocol/patch.ts"
import { parseBlock } from "../../src/protocol/surface.ts"

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

type Loose = Record<string, any>

const form = (): Spec =>
  deepFreeze({
    root: "card",
    elements: {
      card: { type: "Card", props: { title: "Deploy" }, children: ["env", "go"] },
      env: { type: "Select", props: { label: "Environment", options: ["staging", "production"], value: "staging" } },
      go: {
        type: "Button",
        props: { label: "Deploy" },
        on: { press: { action: "sendPrompt", params: { text: "Deploy", data: { $state: "/__genui/env" } } } },
      },
    },
  }) as unknown as Spec

const codes = (surface: { issues: readonly { code: string }[] }) => surface.issues.map((issue) => issue.code)

describe("compileSpec", () => {
  test("an outward action in a watch is tagged, still renders, and is reported (also while streaming)", () => {
    const raw = deepFreeze({
      root: "q",
      elements: {
        q: {
          type: "Input",
          props: { label: "Query", value: { $bindState: "/query" } },
          watch: {
            "/query": [
              { action: "showToast", params: { title: "ran" } },
              { action: "sendPrompt", params: { text: "x" } },
            ],
          },
        },
      },
      state: { query: "" },
    }) as unknown as Spec
    for (const streaming of [false, true]) {
      const compiled = compileSpec(raw, { streaming })
      expect(compiled.fatal).toBe(false)
      expect(compiled.spec).not.toBeNull()
      expect(codes(compiled)).toEqual(["outward_action_in_watch"])
      expect((compiled.spec!.elements.q as Loose).watch["/query"][1].params.__genuiPassive).toBe('watch["/query"]')
    }
  })

  test("normalizes and validates", () => {
    const raw = form()
    const compiled = compileSpec(raw)
    expect(compiled.fatal).toBe(false)
    expect(compiled.issues).toEqual([])
    expect((compiled.spec!.elements.env as Loose).props.value).toEqual({ $bindState: "/__genui/env" })
    expect(compiled.spec!.state).toEqual({ __genui: { env: "staging" } })
    expect(raw.state).toBeUndefined()
  })

  test("null compiles to nothing", () => {
    expect(compileSpec(null)).toEqual({ spec: null, issues: [], fatal: false })
    expect(compileSpec(null, { streaming: true })).toEqual({ spec: null, issues: [], fatal: false })
  })

  test("memoizes by identity, one entry per streaming flag", () => {
    const raw = form()
    const final = compileSpec(raw)
    expect(compileSpec(raw)).toBe(final)
    expect(compileSpec(raw, {})).toBe(final)
    expect(compileSpec(raw, { streaming: false })).toBe(final)
    const streaming = compileSpec(raw, { streaming: true })
    expect(streaming).not.toBe(final)
    expect(compileSpec(raw, { streaming: true })).toBe(streaming)
    // An equal but different object compiles again.
    expect(compileSpec(form())).not.toBe(final)
  })

  test("results are frozen", () => {
    const compiled = compileSpec(form())
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.issues)).toBe(true)
  })

  test("a streamed patch keeps untouched elements' identity in the compiled spec", () => {
    const first = form()
    const second = applyPatch(first, {
      op: "add",
      path: "/elements/note",
      value: { type: "Text", props: { text: "Takes a minute" } },
    })
    const a = compileSpec(first).spec!
    const b = compileSpec(second).spec!
    expect(b.elements.card).toBe(a.elements.card)
    expect(b.elements.go).toBe(a.elements.go)
    expect(b.elements.env).toBe(a.elements.env)
    expect(b.state).toBe(a.state)
  })

  describe("fatal", () => {
    test.each([
      ["an empty spec", EMPTY_SPEC, "empty_spec"],
      ["no root", { root: "", elements: { a: { type: "Text", props: { text: "x" } } } }, "missing_root"],
      [
        "a missing root element",
        { root: "b", elements: { a: { type: "Text", props: { text: "x" } } } },
        "root_not_found",
      ],
      ["a root of unknown type", { root: "a", elements: { a: { type: "Dropdown", props: {} } } }, "unknown_component"],
      [
        "a root that is not an element",
        { root: "a", elements: { a: "Text", b: { type: "Text", props: {} } } },
        "root_not_found",
      ],
      ["only elements that are not elements", { root: "a", elements: { a: "Text" } }, "empty_spec"],
    ])("%s is fatal and has no spec", (_name, raw, code) => {
      const compiled = compileSpec(raw as unknown as Spec)
      expect(compiled.fatal).toBe(true)
      expect(compiled.spec).toBeNull()
      expect(codes(compiled)).toContain(code)
    })

    test("a broken child is not fatal", () => {
      const raw = deepFreeze({
        root: "a",
        elements: { a: { type: "Stack", props: {}, children: ["b", "c"] }, b: { type: "Dropdown", props: {} } },
      })
      const compiled = compileSpec(raw as unknown as Spec)
      expect(compiled.fatal).toBe(false)
      expect(compiled.spec).not.toBeNull()
      expect(codes(compiled).sort()).toEqual(["missing_child", "unknown_component"])
    })
  })

  describe("streaming", () => {
    test("hides what is expected mid-stream and is never fatal", () => {
      const noRoot = compileSpec(EMPTY_SPEC, { streaming: true })
      expect(noRoot).toEqual({ spec: null, issues: [], fatal: false })

      const rootPending = compileSpec(
        deepFreeze({ root: "main", elements: { card: { type: "Card", props: {}, children: [] } } }) as unknown as Spec,
        { streaming: true },
      )
      expect(rootPending).toEqual({ spec: null, issues: [], fatal: false })

      const childPending = compileSpec(
        deepFreeze({
          root: "main",
          elements: { main: { type: "Stack", props: {}, children: ["later"] } },
        }) as unknown as Spec,
        { streaming: true },
      )
      expect(childPending.issues).toEqual([])
      expect(childPending.fatal).toBe(false)
      expect(childPending.spec).not.toBeNull()
    })

    test("state a repeat reads may arrive later", () => {
      const raw = deepFreeze({
        root: "list",
        elements: {
          list: { type: "Stack", props: {}, repeat: { statePath: "/items" }, children: ["row"] },
          row: { type: "Text", props: { text: { $item: "name" } } },
        },
        state: { other: 1 },
      }) as unknown as Spec
      expect(codes(compileSpec(raw))).toEqual(["repeat_state_mismatch"])
      expect(compileSpec(raw, { streaming: true }).issues).toEqual([])
    })

    test("still reports real problems", () => {
      const raw = deepFreeze({
        root: "main",
        elements: {
          main: { type: "Stack", props: {}, children: ["x", "pending"] },
          x: { type: "Dropdown", props: {} },
        },
      }) as unknown as Spec
      const compiled = compileSpec(raw, { streaming: true })
      expect(codes(compiled)).toEqual(["unknown_component"])
      expect(compiled.fatal).toBe(false)
    })

    test("a root of unknown type has no spec but is not fatal while streaming", () => {
      const raw = deepFreeze({ root: "a", elements: { a: { type: "Dropdown", props: {} } } }) as unknown as Spec
      const compiled = compileSpec(raw, { streaming: true })
      expect(compiled.spec).toBeNull()
      expect(compiled.fatal).toBe(false)
      expect(codes(compiled)).toEqual(["unknown_component"])
    })
  })
})

describe("compileBlock", () => {
  const body = [
    '{"canvas":"deploy","title":"Deploy"}',
    '{"op":"add","path":"/root","value":"main"}',
    '{"op":"add","path":"/elements/main","value":{"type":"Stack","props":{},"children":["name"]}}',
    '{"op":"add","path":"/elements/name","value":{"type":"Input","props":{"label":"Name","value":"Ada"}}}',
  ].join("\n")

  test("applies the block's patches and compiles the result", () => {
    const compiled = compileBlock(parseBlock(body))
    expect(compiled.fatal).toBe(false)
    expect(compiled.issues).toEqual([])
    expect(compiled.spec!.root).toBe("main")
    expect((compiled.spec!.elements.name as Loose).props.value).toEqual({ $bindState: "/__genui/name" })
    expect(compiled.spec!.state).toEqual({ __genui: { name: "Ada" } })
  })

  test("memoizes by block identity, one entry per streaming flag", () => {
    const block = parseBlock(body)
    const final = compileBlock(block)
    expect(compileBlock(block)).toBe(final)
    const streaming = compileBlock(block, { streaming: true })
    expect(compileBlock(block, { streaming: true })).toBe(streaming)
    expect(streaming).not.toBe(final)
    expect(compileBlock(parseBlock(body))).not.toBe(final)
  })

  test("a block without patches is fatal when final and empty while streaming", () => {
    const block = parseBlock('{"canvas":"x","close":true}')
    expect(compileBlock(block)).toMatchObject({ spec: null, fatal: true })
    expect(compileBlock(block, { streaming: true })).toEqual({ spec: null, issues: [], fatal: false })
  })

  test("a partially streamed block renders what has arrived", () => {
    const lines = body.split("\n")
    const partial = parseBlock([...lines.slice(0, 3), lines[3]!.slice(0, 40)].join("\n"), { partial: true })
    const compiled = compileBlock(partial, { streaming: true })
    expect(compiled.spec).not.toBeNull()
    expect(compiled.issues).toEqual([])
    expect(compileBlock(partial).issues.map((issue) => issue.code)).toEqual(["missing_child"])
  })
})
