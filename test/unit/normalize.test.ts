import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import {
  CONFIRM_PARAM,
  IGNORED_CHAIN,
  ON_ERROR_PARAM,
  ON_SUCCESS_PARAM,
  PASSIVE_PARAM,
} from "../../src/catalog/actions.ts"
import {
  BOUND_PROPS,
  escapePointer,
  isExpression,
  MAX_SECRET_BASES,
  normalizeChained,
  secretPaths,
  normalizeSpec,
  secretStatePath,
  UI_SECRET_ROOT,
  UI_STATE_ROOT,
  uiStatePath,
} from "../../src/protocol/normalize.ts"
import { IGNORED_CHECK, SAFE_CHECKS } from "../../src/protocol/pattern.ts"
import { seeded as drawFrom } from "./random.ts"

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
      watch: { "/x": { action: "showToast", params: { title: "changed", [PASSIVE_PARAM]: 'watch["/x"]' } } },
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

  test("moves confirm, onSuccess and onError into reserved params for custom actions", () => {
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
      params: {
        text: "deploy",
        [CONFIRM_PARAM]: confirm,
        [ON_SUCCESS_PARAM]: { set: { "/done": true } },
        [ON_ERROR_PARAM]: { action: "showToast", params: { title: "failed" } },
      },
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
      params: { text: "x", [CONFIRM_PARAM]: confirm, [PASSIVE_PARAM]: 'watch["/a"]' },
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

describe("normalizeSpec: action chains", () => {
  const confirm = { title: "Notify?", message: "Sends a toast" }

  test("recurses into onSuccess/onError chains: their confirm moves too, built-ins drop it", () => {
    const output = normalizeSpec(
      spec({
        copy: {
          type: "Button",
          props: { label: "Copy" },
          on: {
            press: {
              action: "copyText",
              params: { text: "abc" },
              onSuccess: {
                action: "showToast",
                params: { title: "Copied" },
                confirm,
                onError: { action: "setState", params: { statePath: "/x", value: 1 }, confirm },
              },
            },
          },
        },
      }),
    )
    expect(el(output, "copy").on.press).toEqual({
      action: "copyText",
      params: {
        text: "abc",
        [ON_SUCCESS_PARAM]: {
          action: "showToast",
          params: {
            title: "Copied",
            [CONFIRM_PARAM]: confirm,
            [ON_ERROR_PARAM]: { action: "setState", params: { statePath: "/x", value: 1 } },
          },
        },
      },
    })
  })

  test("drops navigate and junk handlers; keeps set handlers; normalizes chain params the model wrote itself", () => {
    const output = normalizeSpec(
      spec({
        a: {
          type: "Button",
          props: { label: "A" },
          on: {
            press: {
              action: "openLink",
              params: { url: "https://example.com", [ON_ERROR_PARAM]: { action: "showToast", confirm: true } },
              onSuccess: { navigate: "/home" },
            },
          },
        },
        b: {
          type: "Button",
          props: { label: "B" },
          on: { press: { action: "sendPrompt", params: { text: "x" }, onSuccess: { set: { "/sent": true }, x: 1 } } },
        },
      }),
    )
    expect(el(output, "a").on.press).toEqual({
      action: "openLink",
      params: {
        url: "https://example.com",
        [ON_ERROR_PARAM]: { action: "showToast", params: { [CONFIRM_PARAM]: true } },
      },
    })
    expect(el(output, "b").on.press.params[ON_SUCCESS_PARAM]).toEqual({ set: { "/sent": true } })
  })

  test("chains deeper than the limit are dropped", () => {
    let handler: Loose = { action: "showToast", params: { title: "deep" } }
    for (let depth = 0; depth < 20; depth++)
      handler = { action: "showToast", params: { title: "t" }, onSuccess: handler }
    const output = normalizeSpec(spec({ b: { type: "Button", props: { label: "B" }, on: { press: handler } } }))
    let depth = 0
    let current: Loose | undefined = el(output, "b").on.press
    while (current) {
      depth++
      current = current.params?.[ON_SUCCESS_PARAM]
    }
    expect(depth).toBeLessThanOrEqual(9)
    expect(depth).toBeGreaterThan(1)
  })

  test("a handler written as an expression (on itself, its params or its set) is ignored, at any depth", () => {
    const send = { action: "sendPrompt", params: { text: "x" } }
    const output = normalizeSpec(
      spec({
        q: {
          type: "Input",
          props: { label: "Q" },
          watch: {
            "/q": [
              {
                action: "showToast",
                params: { title: "a" },
                onSuccess: { action: "sendPrompt", params: { $state: "/e" } },
              },
              { action: "showToast", params: { title: "b" }, onError: { action: "showToast", $state: "/hang" } },
              { action: "showToast", params: { title: "c" }, onSuccess: { set: { $state: "/s" } } },
              {
                action: "showToast",
                params: { title: "d" },
                onSuccess: { $cond: { $state: "/f" }, $then: send, $else: send },
              },
              {
                ...send,
                onSuccess: { ...send, onSuccess: { action: "copyText", params: { $format: "date", value: 1 } } },
              },
            ],
          },
        },
      }),
    )
    const watch = el(output, "q").watch["/q"]
    const ignored = { [IGNORED_CHAIN]: true }
    expect(watch[0].params[ON_SUCCESS_PARAM]).toEqual(ignored)
    expect(watch[1].params[ON_ERROR_PARAM]).toEqual(ignored)
    expect(watch[2].params[ON_SUCCESS_PARAM]).toEqual(ignored)
    expect(watch[3].params[ON_SUCCESS_PARAM]).toEqual(ignored)
    expect(watch[4].params[ON_SUCCESS_PARAM].params[ON_SUCCESS_PARAM]).toEqual(ignored)
    // Normalizing again keeps the marker (idempotent).
    expect(normalizeSpec(output)).toBe(output)
    expect(el(normalizeSpec(structuredClone(output)), "q").watch["/q"]).toEqual(watch)
  })

  test("normalizeChained rewrites a resolved handler again, with the parent's passive tag", () => {
    expect(
      normalizeChained(
        {
          action: "sendPrompt",
          params: { text: "x" },
          confirm: { title: "Sure?" },
          onError: { set: { "/s": 1 } },
          onSuccess: { action: "showToast", $state: "/hang" },
        },
        'watch["/q"]',
      ),
    ).toEqual({
      action: "sendPrompt",
      params: {
        text: "x",
        [CONFIRM_PARAM]: { title: "Sure?" },
        [ON_ERROR_PARAM]: { set: { "/s": 1 } },
        [ON_SUCCESS_PARAM]: { [IGNORED_CHAIN]: true },
        [PASSIVE_PARAM]: 'watch["/q"]',
      },
    })
    // Built-ins: json-render's own confirm never shows, so it is dropped.
    expect(
      normalizeChained({ action: "setState", params: { statePath: "/a", value: 1 }, confirm: true }, undefined),
    ).toEqual({ action: "setState", params: { statePath: "/a", value: 1 } })
    expect(normalizeChained({ set: { "/a": 1 }, confirm: true }, undefined)).toEqual({ set: { "/a": 1 } })
    for (const junk of [
      undefined,
      "x",
      { [IGNORED_CHAIN]: true },
      { $state: "/h" },
      { action: "x", params: { $state: "/p" } },
      { navigate: "/" },
    ])
      expect(normalizeChained(junk, undefined)).toBeUndefined()
  })

  test('a top-level { "$item": f } param of a custom action resolves to the value ($bindItem); built-ins keep it', () => {
    const output = normalizeSpec(
      spec({
        list: { type: "Stack", props: {}, repeat: { statePath: "/suggestions" }, children: ["use"] },
        use: {
          type: "Button",
          props: { label: { $item: "text" } },
          on: {
            press: [
              { action: "insertPrompt", params: { text: { $item: "text" } } },
              { action: "sendPrompt", params: { text: "Use", data: { $item: "" } } },
              { action: "removeState", params: { statePath: { $item: "" }, index: { $index: true } } },
            ],
          },
        },
      }),
    )
    expect(el(output, "use").on.press).toEqual([
      { action: "insertPrompt", params: { text: { $bindItem: "text" } } },
      { action: "sendPrompt", params: { text: "Use", data: { $bindItem: "" } } },
      { action: "removeState", params: { statePath: { $item: "" }, index: { $index: true } } },
    ])
  })
})

describe("normalizeSpec: bindings without an activation", () => {
  test("tags custom actions in watch, and in events that are not activations; activations stay untagged", () => {
    const send = { action: "sendPrompt", params: { text: "x" } }
    const output = normalizeSpec(
      spec({
        field: {
          type: "Input",
          props: { label: "Q" },
          on: {
            submit: send,
            focus: send,
            blur: [{ action: "setState", params: { statePath: "/b", value: 1 } }, send],
          },
          watch: { "/q": { ...send, onSuccess: { action: "copyText", params: { text: "y" } } } },
        },
        slider: { type: "Slider", props: {}, on: { change: send } },
        choice: { type: "Select", props: { label: "S", options: ["a"] }, on: { change: send } },
        go: { type: "Button", props: { label: "Go" }, on: { press: send, change: send } },
      }),
    )
    const field = el(output, "field")
    expect(field.on.submit).toBe(send)
    expect(field.on.focus.params[PASSIVE_PARAM]).toBe("on.focus")
    // Built-ins are never tagged; only custom actions have a handler that reads the tag.
    expect(field.on.blur[0]).toEqual({ action: "setState", params: { statePath: "/b", value: 1 } })
    expect(field.on.blur[1].params[PASSIVE_PARAM]).toBe("on.blur")
    expect(field.watch["/q"].params).toEqual({
      text: "x",
      [PASSIVE_PARAM]: 'watch["/q"]',
      [ON_SUCCESS_PARAM]: { action: "copyText", params: { text: "y", [PASSIVE_PARAM]: 'watch["/q"]' } },
    })
    expect(el(output, "slider").on.change.params[PASSIVE_PARAM]).toBe("on.change")
    expect(el(output, "choice").on.change).toBe(send)
    expect(el(output, "go").on.press).toBe(send)
    expect(el(output, "go").on.change.params[PASSIVE_PARAM]).toBe("on.change")
  })
})

describe("normalizeSpec: validation checks", () => {
  test("pattern and email become the safe checks; others are kept; nothing to change keeps identity", () => {
    const keep = deepFreeze({ type: "Input", props: { label: "K", checks: [{ type: "required", message: "R" }] } })
    const output = normalizeSpec(
      spec({
        keep,
        field: {
          type: "Input",
          props: {
            label: "Key",
            checks: [
              { type: "required", message: "Required" },
              { type: "pattern", args: { pattern: "^(a+)+$" }, message: "Bad" },
              { type: "email", message: "Email" },
            ],
          },
        },
      }),
    )
    expect(el(output, "field").props.checks).toEqual([
      { type: "required", message: "Required" },
      { type: SAFE_CHECKS.pattern, args: { pattern: "^(a+)+$" }, message: "Bad" },
      { type: SAFE_CHECKS.email, message: "Email" },
    ])
    // Bound to /__genui/keep, but its checks are the very same array.
    expect(el(output, "keep").props.checks).toBe(keep.props.checks)
  })

  test("checks written as expressions are replaced by an ignored check", () => {
    const output = normalizeSpec(
      spec({
        list: { type: "Input", props: { label: "L", checks: { $state: "/rules" } } },
        items: {
          type: "Input",
          props: {
            label: "I",
            checks: [
              {
                $cond: { $state: "/strict" },
                $then: { type: "pattern", args: { pattern: "x" }, message: "m" },
                $else: {},
              },
              { type: { $state: "/type" }, args: { pattern: "x" }, message: "m" },
              { type: "minLength", args: { min: { $state: "/min" } }, message: "m" },
            ],
          },
        },
      }),
    )
    expect(el(output, "list").props.checks).toEqual([{ type: IGNORED_CHECK, message: "" }])
    expect(el(output, "items").props.checks).toEqual([
      { type: IGNORED_CHECK, message: "" },
      { type: IGNORED_CHECK, message: "" },
      { type: "minLength", args: { min: { $state: "/min" } }, message: "m" },
    ])
  })
})

describe("normalizeSpec: password inputs", () => {
  test("a password Input is bound under the secret root and seeded there", () => {
    const output = normalizeSpec(
      spec({
        pw: { type: "Input", props: { label: "Password", type: "password", value: "x" } },
        name: { type: "Input", props: { label: "Name", value: "Ada" } },
        dynamic: { type: "Input", props: { label: "Key", type: { $state: "/kind" } } },
      }),
    )
    expect(el(output, "pw").props.value).toEqual({ $bindState: secretStatePath("pw") })
    expect(secretStatePath("pw")).toBe(`/${UI_SECRET_ROOT}/pw`)
    expect(el(output, "name").props.value).toEqual({ $bindState: uiStatePath("name") })
    // A type known only at render time may be "password": it is kept secret too.
    expect(el(output, "dynamic").props.value).toEqual({ $bindState: secretStatePath("dynamic") })
    expect(output.state).toEqual({ [UI_STATE_ROOT]: { name: "Ada" }, [UI_SECRET_ROOT]: { pw: "x" } })
  })

  test("an explicitly bound password Input is left alone", () => {
    const output = normalizeSpec(
      spec({ pw: { type: "Input", props: { label: "P", type: "password", value: { $bindState: "/form/pw" } } } }),
    )
    expect(el(output, "pw").props.value).toEqual({ $bindState: "/form/pw" })
  })

  test("secretPaths lists where password Inputs write besides the secret root, so it is never persisted", () => {
    const output = normalizeSpec(
      spec(
        {
          pw: { type: "Input", props: { label: "P", type: "password", value: { $bindState: "/form/pw" } } },
          name: { type: "Input", props: { label: "N", value: { $bindState: "/form/name" } } },
          auto: { type: "Input", props: { label: "A", type: "password" } },
          dbs: { type: "Stack", props: {}, repeat: { statePath: "/dbs" }, children: ["dbpw", "hosts"] },
          dbpw: { type: "Input", props: { label: "DB", type: "password", value: { $bindItem: "pw" } } },
          hosts: { type: "Stack", props: {}, repeat: { statePath: { $item: "hosts" } }, children: ["hostkey"] },
          hostkey: { type: "Input", props: { label: "Key", type: { $state: "/t" }, value: { $bindItem: "key" } } },
          orphan: { type: "Input", props: { label: "O", type: "password", value: { $bindItem: "token" } } },
        },
        { state: { dbs: [] } },
      ),
    )
    expect(secretPaths(output)).toEqual(["/**/token", "/dbs/*/hosts/*/key", "/dbs/*/pw", "/form/pw"])
    expect(secretPaths(output)).toBe(secretPaths(output))
    expect(secretPaths(spec({ name: { type: "Input", props: { label: "N" } } }))).toEqual([])
    expect(secretPaths(null)).toEqual([])
  })

  describe("secretPaths is linear in the spec", () => {
    const password = (bind: Loose) => ({ type: "Input", props: { label: "P", type: "password", value: bind } })

    // The walk before it was made linear, which visits every path from an element up to the root: the reference for
    // what the patterns are on specs without cycles.
    function reference(input: Loose): string[] {
      const elements = input.elements as Record<string, Loose>
      const parents = new Map<string, string[]>()
      for (const [key, element] of Object.entries(elements))
        for (const child of element.children ?? []) parents.set(child, [...(parents.get(child) ?? []), key])
      const itemBases = (key: string, seen: Set<string>): string[] => {
        const result: string[] = []
        for (const parent of parents.get(key) ?? []) {
          if (seen.has(parent)) continue
          const next = new Set(seen).add(parent)
          const statePath = elements[parent]?.repeat?.statePath
          if (typeof statePath === "string") result.push(`${statePath}/*`)
          else if (statePath && typeof statePath.$item === "string") {
            const field = statePath.$item ? `/${statePath.$item}` : ""
            const outer = itemBases(parent, next)
            result.push(...(outer.length > 0 ? outer.map((base) => `${base}${field}/*`) : [`/**${field}/*`]))
          } else result.push(...itemBases(parent, next))
        }
        return result
      }
      const paths = new Set<string>()
      for (const [key, element] of Object.entries(elements)) {
        const value = element.props?.value
        if (element.props?.type !== "password" || !value) continue
        if (typeof value.$bindState === "string") paths.add(value.$bindState)
        else {
          const field = value.$bindItem ? `/${value.$bindItem}` : ""
          const bases = itemBases(key, new Set([key]))
          if (bases.length === 0 && !field) continue
          for (const base of bases.length > 0 ? bases : ["/**"]) paths.add(`${base}${field}`)
        }
      }
      return [...paths].sort()
    }

    test("the same patterns as walking every path, on 3,000 random specs without cycles", () => {
      const draw = drawFrom(7)
      for (let round = 0; round < 3000; round++) {
        const count = 2 + draw(10)
        const elements: Loose = {}
        for (let index = 0; index < count; index++) {
          const children: string[] = []
          for (let child = index + 1; child < count; child++)
            if (draw(10) < 3) children.push(`e${child}`, ...(draw(5) === 0 ? [`e${child}`] : []))
          const repeat =
            draw(10) < 3
              ? { statePath: draw(2) === 0 ? `/list${index}` : { $item: draw(10) < 3 ? "" : `f${index}` } }
              : undefined
          const bind = draw(2) === 0 ? { $bindItem: draw(5) === 0 ? "" : "pw" } : { $bindState: `/s${index}` }
          elements[`e${index}`] = {
            ...(draw(10) < 3 ? password(bind) : { type: "Stack", props: {} }),
            children,
            ...(repeat ? { repeat } : {}),
          }
        }
        const input = { root: "e0", elements }
        expect([...secretPaths(input as unknown as Spec)]).toEqual(reference(input))
      }
    })

    test("a child listed 25,000 times, and a lattice of repeats 18 levels deep, take milliseconds", () => {
      const repeated = {
        root: "list",
        elements: {
          list: { type: "Stack", props: {}, repeat: { statePath: "/rows" }, children: Array(25_000).fill("pw") },
          pw: { ...password({ $bindItem: "pw" }), children: [] },
        },
      }
      let start = performance.now()
      expect(secretPaths(repeated as unknown as Spec)).toEqual(["/rows/*/pw"])
      expect(performance.now() - start).toBeLessThan(150)

      // Every element of a level lists both elements of the next one: 2^18 paths from the Input up to the top.
      const elements: Loose = { top: { type: "Stack", props: {}, repeat: { statePath: "/g" }, children: ["a0", "b0"] } }
      for (let level = 0; level < 18; level++) {
        const children = level === 17 ? ["pw"] : [`a${level + 1}`, `b${level + 1}`]
        elements[`a${level}`] = { type: "Stack", props: {}, children, repeat: { statePath: { $item: `x${level}` } } }
        elements[`b${level}`] = { type: "Stack", props: {}, children, repeat: { statePath: { $item: `y${level}` } } }
      }
      elements.pw = { ...password({ $bindItem: "pw" }), children: [] }
      start = performance.now()
      const lattice = secretPaths({ root: "top", elements } as unknown as Spec)
      expect(performance.now() - start).toBeLessThan(150)
      // Past MAX_SECRET_BASES patterns, an element's items match at any depth: still every item's pw.
      expect(lattice.length).toBeLessThanOrEqual(2 * (MAX_SECRET_BASES + 1))
      expect(lattice.every((path) => path.startsWith("/**/") && path.endsWith("/pw"))).toBe(true)
    })

    test("an element that is its own ancestor gets the any-depth pattern", () => {
      const cycle = {
        root: "a",
        elements: {
          a: { type: "Stack", props: {}, repeat: { statePath: "/rows" }, children: ["b"] },
          b: { type: "Stack", props: {}, repeat: { statePath: { $item: "kids" } }, children: ["c"] },
          c: { type: "Stack", props: {}, children: ["b", "pw"] },
          pw: { ...password({ $bindItem: "pw" }), children: [] },
        },
      }
      // Rows of b nest in rows of b without end: /rows/*/kids/*/kids/*/.../pw, which only an any-depth pattern covers.
      expect(secretPaths(cycle as unknown as Spec)).toEqual(["/**/kids/*/pw"])
    })
  })

  test("seeding both roots keeps the state's identity while seeds do not change", () => {
    const state = deepFreeze({ form: {} })
    const elements = {
      pw: { type: "Input", props: { label: "P", type: "password", value: "s" } },
      name: { type: "Input", props: { label: "N", value: "n" } },
    }
    const first = normalizeSpec(spec(elements, { state }))
    const second = normalizeSpec(spec({ ...elements, t: { type: "Text", props: { text: "x" } } }, { state }))
    expect(second.state).toBe(first.state)
  })
})
