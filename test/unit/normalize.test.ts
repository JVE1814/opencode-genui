import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import { CONFIRM_PARAM } from "../../src/catalog/actions.ts"
import {
  BOUND_PROPS,
  escapePointer,
  isExpression,
  normalizeSpec,
  UI_STATE_ROOT,
  uiStatePath,
} from "../../src/protocol/normalize.ts"

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

type Loose = Record<string, any>

/** A frozen spec with a Stack root holding the given elements, in order. */
function spec(elements: Loose, extra: Loose = {}): Spec {
  return deepFreeze({
    root: "root",
    elements: { root: { type: "Stack", props: {}, children: Object.keys(elements) }, ...elements },
    ...extra,
  }) as unknown as Spec
}

const el = (result: Spec, key: string) => result.elements[key] as unknown as Loose

describe("isExpression", () => {
  test.each([
    [{ $state: "/x" }, true],
    [{ $bindState: "/x" }, true],
    [{ $item: "name" }, true],
    [{ $index: true }, true],
    [{ $bindItem: "done" }, true],
    [{ $cond: { $state: "/x" }, $then: 1, $else: 2 }, true],
    [{ $computed: "fn", args: {} }, true],
    [{ $template: "Hi ${/name}" }, true],
    [{ $format: "currency", value: 1 }, true],
    [{ label: "x", value: "y" }, false],
    [["$state"], false],
    ["$state", false],
    [null, false],
    [5, false],
  ])("%j -> %p", (value, expected) => {
    expect(isExpression(value)).toBe(expected)
  })
})

describe("uiStatePath", () => {
  test("escapes the element key", () => {
    expect(uiStatePath("name")).toBe("/__genui/name")
    expect(uiStatePath("a/b~c")).toBe("/__genui/a~1b~0c")
    expect(escapePointer("~/")).toBe("~0~1")
  })
})

describe("normalizeSpec: purity", () => {
  test("returns the same object when nothing needs to change", () => {
    const input = spec({ t: { type: "Text", props: { text: "hi" }, children: [] } })
    expect(normalizeSpec(input)).toBe(input)
  })

  test("is idempotent and keeps identity on a second pass", () => {
    const input = spec({
      name: { type: "Input", props: { label: "Name", value: "x" } },
      go: { type: "Button", props: { label: "Go", on: { press: { action: "sendPrompt", confirm: { title: "t" } } } } },
      junk: null,
    })
    const once = normalizeSpec(input)
    expect(normalizeSpec(once)).toBe(once)
  })

  test("never mutates a frozen input, and shares untouched elements", () => {
    const input = spec({
      t: { type: "Text", props: { text: "hi" }, children: [] },
      name: { type: "Input", props: { label: "Name", value: "x" } },
    })
    const before = JSON.stringify(input)
    const output = normalizeSpec(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(output).not.toBe(input)
    expect(output.elements.t).toBe(input.elements.t)
    expect(output.elements.root).toBe(input.elements.root)
  })

  test("normalizing the same element twice yields the same object (stable across stream updates)", () => {
    const leaf = deepFreeze({ type: "Text", props: { text: "a" } })
    const first = normalizeSpec(spec({ leaf }))
    const second = normalizeSpec(spec({ leaf, other: { type: "Text", props: { text: "b" } } }))
    expect(second.elements.leaf).toBe(first.elements.leaf)
    const bound = deepFreeze({ type: "Input", props: { label: "L", value: "v" } })
    expect(normalizeSpec(spec({ bound })).elements.bound).toBe(normalizeSpec(spec({ bound, x: leaf })).elements.bound)
  })

  test.each([
    [null, { root: "", elements: {} }],
    ["spec", { root: "", elements: {} }],
    [{}, { root: "", elements: {} }],
    [
      { root: 5, elements: [] },
      { root: "", elements: {} },
    ],
    [
      { root: "a", elements: null, state: [1] },
      { root: "a", elements: {} },
    ],
  ])("never throws on garbage: %j", (input, expected) => {
    expect(normalizeSpec(input as unknown as Spec)).toEqual(expected as Spec)
  })

  test("keeps unknown top-level fields and the state", () => {
    const input = deepFreeze({ root: "t", elements: { t: { type: "Text", props: {} } }, state: { a: 1 }, extra: true })
    const output = normalizeSpec(input as unknown as Spec) as unknown as Loose
    expect(output.extra).toBe(true)
    expect(output.state).toBe(input.state)
  })
})

describe("normalizeSpec: autoFixSpec", () => {
  test("moves visible, on, repeat and watch out of props", () => {
    const output = normalizeSpec(
      spec({
        a: {
          type: "Button",
          props: {
            label: "A",
            visible: { $state: "/show" },
            on: { press: { action: "setState", params: { statePath: "/x", value: 1 } } },
            watch: { "/x": { action: "showToast", params: { title: "changed" } } },
          },
        },
        list: { type: "Stack", props: { repeat: { statePath: "/items" } }, children: ["row"] },
        row: { type: "Text", props: { text: { $item: "name" } } },
      }),
    )
    expect(el(output, "a")).toEqual({
      type: "Button",
      props: { label: "A" },
      children: [],
      visible: { $state: "/show" },
      on: { press: { action: "setState", params: { statePath: "/x", value: 1 } } },
      watch: { "/x": { action: "showToast", params: { title: "changed" } } },
    })
    expect(el(output, "list").repeat).toEqual({ statePath: "/items" })
    expect(el(output, "list").props).toEqual({})
  })

  test("keeps dangling children (lossless fixes only)", () => {
    const output = normalizeSpec(spec({ box: { type: "Stack", props: {}, children: ["missing"] } }))
    expect(el(output, "box").children).toEqual(["missing"])
  })
})

describe("normalizeSpec: element shape", () => {
  test("every element gets object props and string-array children", () => {
    const output = normalizeSpec(
      spec({
        noProps: { type: "Separator" },
        arrayProps: { type: "Separator", props: ["x"] },
        stringProps: { type: "Separator", props: "x" },
        mixed: { type: "Stack", props: {}, children: ["noProps", 5, null, { k: 1 }, "arrayProps"] },
        badChildren: { type: "Stack", props: {}, children: "noProps" },
      }),
    )
    expect(el(output, "noProps")).toEqual({ type: "Separator", props: {}, children: [] })
    expect(el(output, "arrayProps").props).toEqual({})
    expect(el(output, "stringProps").props).toEqual({})
    expect(el(output, "mixed").children).toEqual(["noProps", "arrayProps"])
    expect(el(output, "badChildren").children).toEqual([])
  })

  test("removes elements that are not objects or have no string type, and references to them", () => {
    const output = normalizeSpec(
      spec({
        ok: { type: "Text", props: { text: "ok" } },
        nul: null,
        str: "Text",
        arr: [{ type: "Text" }],
        noType: { props: {} },
        numType: { type: 5, props: {} },
      }),
    )
    expect(Object.keys(output.elements).sort()).toEqual(["ok", "root"])
    expect(output.elements.root!.children).toEqual(["ok"])
  })

  test("drops children that would resolve to inherited properties", () => {
    const output = normalizeSpec(
      spec({ box: { type: "Stack", props: {}, children: ["toString", "constructor", "x"] } }),
    )
    expect(el(output, "box").children).toEqual(["x"])
  })

  test("drops a __proto__ element key without polluting", () => {
    const input = deepFreeze(
      JSON.parse(
        '{"root":"r","elements":{"r":{"type":"Stack","props":{},"children":["__proto__"]},"__proto__":{"type":"Text","props":{"polluted":true}}}}',
      ),
    )
    const output = normalizeSpec(input)
    expect(Object.hasOwn(output.elements, "__proto__")).toBe(false)
    expect(output.elements.r!.children).toEqual([])
    expect(({} as Loose).props).toBeUndefined()
  })

  test("drops malformed repeat and slots shapes but keeps valid ones", () => {
    const output = normalizeSpec(
      spec({
        nullRepeat: { type: "Stack", props: {}, repeat: null, children: [] },
        badRepeat: { type: "Stack", props: {}, repeat: { statePath: 5 }, children: [] },
        itemRepeat: { type: "Stack", props: {}, repeat: { statePath: { $item: "rows" } }, children: [] },
        slots: { type: "Stack", props: {}, slots: { a: ["x", 1], b: "y" } },
        goodSlots: { type: "Stack", props: {}, slots: { a: ["x"] }, children: [] },
        badSlots: { type: "Stack", props: {}, slots: 5, children: [] },
      }),
    )
    expect("repeat" in el(output, "nullRepeat")).toBe(false)
    expect("repeat" in el(output, "badRepeat")).toBe(false)
    expect(el(output, "itemRepeat").repeat).toEqual({ statePath: { $item: "rows" } })
    expect(el(output, "slots").slots).toEqual({ a: ["x"] })
    expect("slots" in el(output, "badSlots")).toBe(false)
  })
})

describe("normalizeSpec: confirm rewrite", () => {
  const confirm = { title: "Deploy?", message: "This deploys to production." }

  test("moves confirm into params for custom actions, keeping onSuccess/onError", () => {
    const output = normalizeSpec(
      spec({
        go: {
          type: "Button",
          props: { label: "Go" },
          on: {
            press: {
              action: "sendPrompt",
              params: { text: "deploy" },
              confirm,
              onSuccess: { set: { "/done": true } },
              onError: { action: "showToast", params: { title: "failed" } },
            },
          },
        },
      }),
    )
    expect(el(output, "go").on.press).toEqual({
      action: "sendPrompt",
      params: { text: "deploy", [CONFIRM_PARAM]: confirm },
      onSuccess: { set: { "/done": true } },
      onError: { action: "showToast", params: { title: "failed" } },
    })
  })

  test("creates params when the binding has none", () => {
    const output = normalizeSpec(
      spec({ go: { type: "Button", props: { label: "Go" }, on: { press: { action: "openLink", confirm } } } }),
    )
    expect(el(output, "go").on.press).toEqual({ action: "openLink", params: { [CONFIRM_PARAM]: confirm } })
  })

  test("rewrites every binding of an array and of watch", () => {
    const output = normalizeSpec(
      spec({
        go: {
          type: "Button",
          props: { label: "Go" },
          on: {
            press: [
              { action: "setState", params: { statePath: "/a", value: 1 }, confirm },
              { action: "copyText", params: { text: "x" }, confirm },
              { action: "showToast", params: { title: "t" } },
            ],
          },
          watch: { "/a": { action: "insertPrompt", params: { text: "x" }, confirm } },
        },
      }),
    )
    expect(el(output, "go").on.press).toEqual([
      { action: "setState", params: { statePath: "/a", value: 1 } },
      { action: "copyText", params: { text: "x", [CONFIRM_PARAM]: confirm } },
      { action: "showToast", params: { title: "t" } },
    ])
    expect(el(output, "go").watch["/a"]).toEqual({
      action: "insertPrompt",
      params: { text: "x", [CONFIRM_PARAM]: confirm },
    })
  })

  test.each(["setState", "pushState", "removeState", "validateForm", "push", "pop"])(
    "drops confirm for the built-in %s",
    (action) => {
      const output = normalizeSpec(
        spec({ b: { type: "Button", props: { label: "B" }, on: { press: { action, confirm } } } }),
      )
      expect(el(output, "b").on.press).toEqual({ action })
    },
  )

  test("rewrites confirm that autoFixSpec moved out of props", () => {
    const output = normalizeSpec(
      spec({ b: { type: "Button", props: { label: "B", on: { press: { action: "sendPrompt", confirm } } } } }),
    )
    expect(el(output, "b").on.press.params[CONFIRM_PARAM]).toEqual(confirm)
    expect(el(output, "b").props.on).toBeUndefined()
  })

  test("drops bindings that are not objects, and on/watch maps that are not objects", () => {
    const output = normalizeSpec(
      spec({
        a: { type: "Button", props: { label: "A" }, on: { press: [null, "x", { action: "showToast" }], blur: 5 } },
        b: { type: "Button", props: { label: "B" }, on: "press", watch: [] },
      }),
    )
    expect(el(output, "a").on).toEqual({ press: [{ action: "showToast" }] })
    expect("on" in el(output, "b")).toBe(false)
    expect("watch" in el(output, "b")).toBe(false)
  })

  test("leaves bindings without confirm untouched (same objects)", () => {
    const binding = deepFreeze({ action: "sendPrompt", params: { text: "x" } })
    const output = normalizeSpec(
      spec({ b: { type: "Button", props: { label: "B" }, children: [], on: { press: binding } } }),
    )
    expect(el(output, "b").on.press).toBe(binding)
  })
})

describe("normalizeSpec: input auto-binding", () => {
  const cases: [string, string, unknown, Loose][] = [
    ["Input", "value", "Ada", { label: "Name" }],
    ["Textarea", "value", "notes", { label: "Notes" }],
    ["Select", "value", "b", { label: "Pick", options: ["a", "b"] }],
    ["Checkbox", "checked", true, { label: "Agree" }],
    ["Radio", "value", "x", { label: "R", options: ["x"] }],
    ["Switch", "checked", false, { label: "On" }],
    ["Slider", "value", 40, {}],
    ["Toggle", "pressed", true, { label: "Bold" }],
    ["ToggleGroup", "value", ["a"], { items: [], type: "multiple" }],
    ["ButtonGroup", "selected", "one", { buttons: [] }],
    ["DropdownMenu", "value", "v", { label: "Menu", items: [] }],
    ["Pagination", "page", 2, { totalPages: 5 }],
    ["Tabs", "value", "logs", { tabs: [] }],
  ]

  test("covers every bound component", () => {
    expect(Object.fromEntries(cases.map(([type, prop]) => [type, prop]))).toEqual({ ...BOUND_PROPS })
  })

  test.each(cases)("%s.%s: a literal is bound and seeded", (type, prop, literal, props) => {
    const output = normalizeSpec(spec({ field: { type, props: { ...props, [prop]: literal } } }))
    expect(el(output, "field").props).toEqual({ ...props, [prop]: { $bindState: "/__genui/field" } })
    expect(output.state).toEqual({ [UI_STATE_ROOT]: { field: literal } })
  })

  test.each(cases)("%s.%s: an absent prop is bound without a seed", (type, prop, _literal, props) => {
    const output = normalizeSpec(spec({ field: { type, props } }))
    expect(el(output, "field").props[prop]).toEqual({ $bindState: "/__genui/field" })
    expect(output.state).toBeUndefined()
  })

  test.each([
    [{ $state: "/form/name" }],
    [{ $bindState: "/form/name" }],
    [{ $bindItem: "name" }],
    [{ $template: "${/a}" }],
    [{ $cond: { $state: "/x" }, $then: "a", $else: "b" }],
    [{ $computed: "f" }],
    [{ $custom: 1 }],
  ])("an expression is left alone: %j", (value) => {
    const field = deepFreeze({ type: "Input", props: { label: "L", value }, children: [] })
    const output = normalizeSpec(spec({ field }))
    expect(output.elements.field).toBe(field as never)
    expect(output.state).toBeUndefined()
  })

  test("Tabs seeds from defaultValue when value is absent", () => {
    const output = normalizeSpec(spec({ tabs: { type: "Tabs", props: { tabs: [], defaultValue: "logs" } } }))
    expect(el(output, "tabs").props).toEqual({ tabs: [], defaultValue: "logs", value: { $bindState: "/__genui/tabs" } })
    expect(output.state).toEqual({ __genui: { tabs: "logs" } })
  })

  test("Tabs prefers value over defaultValue, and ignores an expression defaultValue", () => {
    const both = normalizeSpec(spec({ tabs: { type: "Tabs", props: { tabs: [], value: "a", defaultValue: "b" } } }))
    expect(both.state).toEqual({ __genui: { tabs: "a" } })
    const expr = normalizeSpec(spec({ tabs: { type: "Tabs", props: { tabs: [], defaultValue: { $state: "/t" } } } }))
    expect(expr.state).toBeUndefined()
  })

  test("a null literal is bound without a seed", () => {
    const output = normalizeSpec(spec({ field: { type: "Input", props: { label: "L", value: null } } }))
    expect(el(output, "field").props.value).toEqual({ $bindState: "/__genui/field" })
    expect(output.state).toBeUndefined()
  })

  test("element keys are escaped in the path but not in the seed", () => {
    const output = normalizeSpec(spec({ "a/b~c": { type: "Input", props: { label: "L", value: "v" } } }))
    expect(el(output, "a/b~c").props.value).toEqual({ $bindState: "/__genui/a~1b~0c" })
    expect(output.state).toEqual({ __genui: { "a/b~c": "v" } })
  })

  test("existing state is kept and an existing seed is never overwritten", () => {
    const input = spec(
      {
        a: { type: "Input", props: { label: "A", value: "literal" } },
        b: { type: "Input", props: { label: "B", value: "fresh" } },
      },
      { state: { form: { x: 1 }, __genui: { a: "edited" } } },
    )
    const output = normalizeSpec(input)
    expect(output.state).toEqual({ form: { x: 1 }, __genui: { a: "edited", b: "fresh" } })
    expect((output.state as Loose).form).toBe((input.state as Loose).form)
    expect((input.state as Loose).__genui).toEqual({ a: "edited" })
  })

  test("a state whose __genui is not an object gets a fresh one only when seeding", () => {
    const seeded = normalizeSpec(
      spec({ a: { type: "Input", props: { label: "A", value: "v" } } }, { state: { __genui: 5 } }),
    )
    expect(seeded.state).toEqual({ __genui: { a: "v" } })
    const unseeded = normalizeSpec(spec({ a: { type: "Input", props: { label: "A" } } }, { state: { __genui: 5 } }))
    expect(unseeded.state).toEqual({ __genui: 5 })
  })

  test("inputs inside a repeat are not bound", () => {
    const output = normalizeSpec(
      spec(
        {
          list: { type: "Stack", props: {}, repeat: { statePath: "/todos" }, children: ["row"] },
          outside: { type: "Checkbox", props: { label: "All", checked: false } },
        },
        {
          state: { todos: [] },
        },
      ),
    )
    // `row` and its child are descendants of the repeating `list`.
    const nested = normalizeSpec(
      deepFreeze({
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["list"] },
          list: { type: "Stack", props: {}, repeat: { statePath: "/todos" }, children: ["row"] },
          row: { type: "Stack", props: {}, children: ["done"] },
          done: { type: "Checkbox", props: { label: { $item: "title" }, checked: false } },
          container: { type: "Input", props: { label: "Repeat host" } },
        },
      }) as unknown as Spec,
    )
    expect(el(nested, "done").props.checked).toBe(false)
    expect(el(nested, "row").props).toEqual({})
    // Unreachable elements are not inside a repeat.
    expect(el(nested, "container").props.value).toEqual({ $bindState: "/__genui/container" })
    expect(el(output, "outside").props.checked).toEqual({ $bindState: "/__genui/outside" })
    expect(output.state).toEqual({ todos: [], __genui: { outside: false } })
  })

  test("the repeating element itself is not inside its repeat", () => {
    const output = normalizeSpec(
      spec({ tabs: { type: "Tabs", props: { tabs: [], value: "a" }, repeat: { statePath: "/x" }, children: [] } }),
    )
    expect(el(output, "tabs").props.value).toEqual({ $bindState: "/__genui/tabs" })
  })

  test("an element reachable both inside and outside a repeat is not bound", () => {
    const output = normalizeSpec(
      spec({
        list: { type: "Stack", props: {}, repeat: { statePath: "/x" }, children: ["shared"] },
        shared: { type: "Input", props: { label: "S", value: "v" } },
      }),
    )
    expect(el(output, "shared").props.value).toBe("v")
  })

  test("cyclic children do not hang", () => {
    const output = normalizeSpec(
      deepFreeze({
        root: "a",
        elements: {
          a: { type: "Stack", props: {}, children: ["b"] },
          b: { type: "Stack", props: {}, children: ["a", "i"], repeat: { statePath: "/x" } },
          i: { type: "Input", props: { label: "I", value: "v" } },
        },
      }) as unknown as Spec,
    )
    expect(el(output, "i").props.value).toBe("v")
  })

  test("forbidden keys are never bound", () => {
    const input = deepFreeze({
      root: "r",
      elements: {
        r: { type: "Stack", props: {}, children: ["constructor"] },
        constructor: { type: "Input", props: { label: "L", value: "v" } },
      },
    })
    const output = normalizeSpec(input as unknown as Spec)
    expect(el(output, "constructor").props.value).toBe("v")
    expect(output.state).toBeUndefined()
  })

  test("the seeded state keeps its identity while seeds do not change", () => {
    const state = deepFreeze({ form: {} })
    const field = { type: "Input", props: { label: "L", value: "v" } }
    const first = normalizeSpec(spec({ field }, { state }))
    const second = normalizeSpec(spec({ field, other: { type: "Text", props: { text: "x" } } }, { state }))
    expect(second.state).toBe(first.state)
    const changed = normalizeSpec(spec({ field: { ...field, props: { label: "L", value: "w" } } }, { state }))
    expect(changed.state).not.toBe(first.state)
    expect(changed.state).toEqual({ form: {}, __genui: { field: "w" } })
  })
})
