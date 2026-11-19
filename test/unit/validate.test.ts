import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import { getCatalog } from "../../src/catalog/index.ts"
import { normalizeSpec } from "../../src/protocol/normalize.ts"
import {
  ACTIVATION_RULE,
  formatIssuesForAgent,
  MAX_AGENT_MESSAGE,
  validateSurface,
  type SurfaceIssue,
} from "../../src/protocol/validate.ts"

type Loose = Record<string, any>

const spec = (elements: Loose, extra: Loose = {}): Spec =>
  ({
    root: "root",
    elements: { root: { type: "Stack", props: {}, children: Object.keys(elements) }, ...elements },
    ...extra,
  }) as unknown as Spec

const codes = (issues: readonly SurfaceIssue[]) => issues.map((issue) => issue.code)
const only = (issues: readonly SurfaceIssue[], code: string) => issues.filter((issue) => issue.code === code)

describe("validateSurface: structure and fatal", () => {
  test("a valid spec has no issues", () => {
    const result = validateSurface(spec({ t: { type: "Text", props: { text: "hi" }, children: [] } }))
    expect(result).toEqual({ issues: [], fatal: false })
  })

  test.each([
    ["no elements", { root: "a", elements: {} }, "empty_spec"],
    ["no root", { root: "", elements: { a: { type: "Text", props: { text: "x" } } } }, "missing_root"],
    ["root not a string", { root: 5, elements: { a: { type: "Text", props: { text: "x" } } } }, "missing_root"],
    ["root element missing", { root: "b", elements: { a: { type: "Text", props: { text: "x" } } } }, "root_not_found"],
    ["root is an inherited name", { root: "toString", elements: { a: { type: "Text", props: {} } } }, "root_not_found"],
    ["root element is not an object", { root: "a", elements: { a: null } }, "root_not_found"],
    ["root of an unknown type", { root: "a", elements: { a: { type: "Dropdown", props: {} } } }, "unknown_component"],
    ["root without a type", { root: "a", elements: { a: { props: {} } } }, "missing_type"],
  ])("fatal: %s", (_name, input, code) => {
    const result = validateSurface(input as unknown as Spec)
    expect(result.fatal).toBe(true)
    expect(codes(result.issues)).toContain(code)
    expect(result.issues.every((issue) => issue.message.length > 0)).toBe(true)
  })

  test("a spec that is not an object is fatal", () => {
    expect(validateSurface(null as unknown as Spec).fatal).toBe(true)
  })

  test("missing children are errors but not fatal", () => {
    const result = validateSurface(
      spec({ box: { type: "Stack", props: {}, children: ["ghost", "toString"], slots: { header: ["nobody"] } } }),
    )
    expect(result.fatal).toBe(false)
    expect(only(result.issues, "missing_child")).toEqual([
      { severity: "error", code: "missing_child", message: 'child "ghost" is not defined', elementKey: "box" },
      { severity: "error", code: "missing_child", message: 'child "toString" is not defined', elementKey: "box" },
      {
        severity: "error",
        code: "missing_child",
        message: 'child "nobody" in slot "header" is not defined',
        elementKey: "box",
      },
    ])
  })

  test("a non-root element of an unknown type is an error, not fatal", () => {
    const result = validateSurface(spec({ "env-select": { type: "Dropdown", props: {} } }))
    expect(result.fatal).toBe(false)
    expect(result.issues).toEqual([
      {
        severity: "error",
        code: "unknown_component",
        message: 'unknown component "Dropdown"',
        elementKey: "env-select",
      },
    ])
  })

  test("elements that are not objects or have no type", () => {
    const result = validateSurface(spec({ a: null, b: { props: {} } }))
    expect(only(result.issues, "invalid_element")[0]!.elementKey).toBe("a")
    expect(only(result.issues, "missing_type")[0]!.elementKey).toBe("b")
  })

  test("json-render's checks: invalid visible conditions and repeat problems", () => {
    const result = validateSurface(
      spec(
        {
          hidden: { type: "Text", props: { text: "x" }, visible: { $state: "/a", $item: "b" } },
          empty: { type: "Stack", props: {}, repeat: { statePath: "/items" } },
          list: { type: "Stack", props: {}, repeat: { statePath: "/nothing" }, children: ["row"] },
          row: { type: "Text", props: { text: { $item: "name" } } },
          relative: { type: "Stack", props: {}, repeat: { statePath: { $item: "rows" } }, children: ["row"] },
        },
        { state: { items: [] } },
      ),
    )
    const byCode = Object.fromEntries(result.issues.map((issue) => [issue.code, issue]))
    expect(byCode.invalid_visible).toMatchObject({ severity: "error", elementKey: "hidden" })
    expect(byCode.invalid_visible!.message.startsWith("Element")).toBe(false)
    expect(byCode.repeat_without_children).toMatchObject({ severity: "error", elementKey: "empty" })
    expect(byCode.repeat_state_mismatch).toMatchObject({ severity: "warning", elementKey: "list" })
    expect(byCode.repeat_item_outside_scope).toMatchObject({ severity: "error", elementKey: "relative" })
    expect(result.fatal).toBe(false)
  })

  test("a state the normalizer created only for seeds does not trigger repeat state checks", () => {
    const raw = spec({
      list: { type: "Stack", props: {}, repeat: { statePath: "/items" }, children: ["row"] },
      row: { type: "Text", props: { text: { $item: "name" } } },
      name: { type: "Input", props: { label: "Name", value: "x" } },
    })
    const normalized = normalizeSpec(raw)
    expect(normalized.state).toEqual({ __genui: { name: "x" } })
    expect(validateSurface(normalized).issues).toEqual([])
  })

  test("a state holding only seeds of both roots (__genui, __genui_secret) counts as absent", () => {
    const raw = spec({
      list: { type: "Stack", props: {}, repeat: { statePath: "/items" }, children: ["row"] },
      row: { type: "Text", props: { text: { $item: "name" } } },
      pw: { type: "Input", props: { label: "Password", type: "password", value: "x" } },
    })
    const normalized = normalizeSpec(raw)
    expect(normalized.state).toEqual({ __genui_secret: { pw: "x" } })
    expect(validateSurface(normalized).issues).toEqual([])
  })

  test("fields misplaced in props are warnings (the normalizer fixes them)", () => {
    const result = validateSurface(
      spec({ b: { type: "Button", props: { label: "B", visible: true, on: { press: { action: "setState" } } } } }),
    )
    expect(only(result.issues, "visible_in_props")[0]!.severity).toBe("warning")
    expect(only(result.issues, "on_in_props")[0]!.severity).toBe("warning")
  })

  test("malformed shapes never throw", () => {
    const result = validateSurface(
      spec({
        a: { type: "Stack", props: "x", children: 5, slots: { s: 7 }, repeat: null },
        b: { type: "Stack", props: {}, repeat: { statePath: 5 }, children: [] },
        c: { type: "Button", props: { label: "C" }, on: { press: [null, 3] }, watch: "x" },
      }),
    )
    expect(codes(result.issues)).toContain("invalid_repeat")
    expect(codes(result.issues)).toContain("invalid_binding")
  })

  test("issues are deduplicated", () => {
    const result = validateSurface(spec({ box: { type: "Stack", props: {}, children: ["ghost", "ghost"] } }))
    expect(only(result.issues, "missing_child")).toHaveLength(1)
  })
})

describe("validateSurface: props", () => {
  test("one warning per element, naming the props and expected types", () => {
    const result = validateSurface(
      spec({
        h: { type: "Heading", props: { level: "h7" } },
        g: { type: "Grid", props: { columns: 9 } },
        s: { type: "Stat", props: { label: "Requests", value: true } },
        i: { type: "Grid", props: { columns: 1.5 } },
      }),
    )
    const messages = Object.fromEntries(result.issues.map((issue) => [issue.elementKey, issue.message]))
    expect(result.issues.every((issue) => issue.severity === "warning" && issue.code === "invalid_props")).toBe(true)
    expect(messages.h).toBe(
      'invalid props for Heading: "text" is required (string); "level" should be one of "h1", "h2", "h3", "h4", got "h7"',
    )
    expect(messages.g).toBe('invalid props for Grid: "columns" should be at most 6')
    expect(messages.s).toBe('invalid props for Stat: "value" should be a string or a number, got boolean')
    expect(messages.i).toBe('invalid props for Grid: "columns" should be an integer, got number')
  })

  test("nested paths are named", () => {
    const result = validateSurface(spec({ t: { type: "Tabs", props: { tabs: [{ label: 1, value: "a" }] } } }))
    expect(result.issues[0]!.message).toBe('invalid props for Tabs: "tabs[0].label" should be a string, got number')
  })

  test("caps the problems listed per element", () => {
    const result = validateSurface(spec({ c: { type: "Chart", props: { type: "pie", height: 2, stacked: "yes" } } }))
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]!.message).toMatch(/\(and \d+ more\)$/)
  })

  test.each([
    ["$state", { text: { $state: "/title" } }],
    ["$bindState", { text: { $bindState: "/title" } }],
    ["$template", { text: { $template: "Hello ${/name}" } }],
    ["$cond", { text: { $cond: { $state: "/a" }, $then: "x", $else: "y" } }],
    ["$computed", { text: { $computed: "upper", args: { v: "x" } } }],
    ["$item", { text: { $item: "title" } }],
    ["$index", { text: { $index: true } }],
    ["a directive", { text: { $format: "date", value: "2024-01-01" } }],
  ])("ignores a %s expression in a prop", (_name, props) => {
    expect(validateSurface(spec({ h: { type: "Heading", props } })).issues).toEqual([])
  })

  test("ignores expressions at any depth but still reports literals beside them", () => {
    const result = validateSurface(
      spec({
        t: {
          type: "Tabs",
          props: {
            tabs: [
              { label: { $template: "${/a}" }, value: "a" },
              { label: { $state: "/b" }, value: 5 },
            ],
          },
        },
        k: { type: "Keybind", props: { keys: ["Mod", { $state: "/key" }] } },
        r: { type: "Table", props: { columns: ["a"], rows: { $state: "/rows" } } },
      }),
    )
    expect(result.issues).toEqual([
      {
        severity: "warning",
        code: "invalid_props",
        message: 'invalid props for Tabs: "tabs[1].value" should be a string, got number',
        elementKey: "t",
      },
    ])
  })

  test("bound inputs are validated through their seed", () => {
    const normalized = normalizeSpec(spec({ s: { type: "Slider", props: { value: "50" } } }))
    expect(validateSurface(normalized).issues).toEqual([
      {
        severity: "warning",
        code: "invalid_props",
        message: 'invalid props for Slider: "value" should be a number, got string',
        elementKey: "s",
      },
    ])
    const fine = normalizeSpec(
      spec({ s: { type: "Slider", props: { value: 50 } }, e: { type: "Input", props: { label: "E" } } }),
    )
    expect(validateSurface(fine).issues).toEqual([])
  })

  test("a password Input is validated through its secret seed", () => {
    const normalized = normalizeSpec(
      spec({ pw: { type: "Input", props: { label: "P", type: "password", value: true } } }),
    )
    expect(codes(validateSurface(normalized).issues)).toEqual(["invalid_props"])
  })

  test("unknown props are not reported", () => {
    expect(validateSurface(spec({ t: { type: "Text", props: { text: "x", className: "big" } } })).issues).toEqual([])
  })
})

describe("validateSurface: actions", () => {
  test("built-in and catalog actions are known", () => {
    const actions = ["setState", "pushState", "removeState", "validateForm", "push", "pop", ...getCatalog().actionNames]
    const result = validateSurface(
      spec({ b: { type: "Button", props: { label: "B" }, on: { press: actions.map((action) => ({ action })) } } }),
    )
    expect(result.issues).toEqual([])
  })

  test("unknown actions in on, watch, onSuccess and onError are warnings", () => {
    const result = validateSurface(
      spec({
        b: {
          type: "Button",
          props: { label: "B" },
          on: {
            press: { action: "deploy", onSuccess: { action: "celebrate" }, onError: { action: "showToast" } },
            focus: [{ action: "setState" }, { action: "fetchData" }],
          },
          watch: { "/env": { action: "loadCities" } },
        },
      }),
    )
    expect(result.issues.map((issue) => [issue.severity, issue.code, issue.message])).toEqual([
      ["warning", "unknown_action", 'unknown action "deploy" in on.press'],
      ["warning", "unknown_action", 'unknown action "celebrate" in on.press.onSuccess'],
      ["warning", "unknown_action", 'unknown action "fetchData" in on.focus[1]'],
      ["warning", "unknown_action", 'unknown action "loadCities" in watch["/env"]'],
    ])
    expect(result.fatal).toBe(false)
  })

  test("unknown actions in chains are still found after the normalizer moved them into reserved params", () => {
    const raw = spec({
      b: {
        type: "Button",
        props: { label: "B" },
        on: { press: { action: "copyText", params: { text: "x" }, onSuccess: { action: "celebrate" } } },
      },
    })
    expect(validateSurface(normalizeSpec(raw)).issues.map((issue) => issue.message)).toEqual([
      'unknown action "celebrate" in on.press.onSuccess',
    ])
  })

  test("prop expressions json-render cannot evaluate are reported: two directives in one object, a $cond that is a path", () => {
    const result = validateSurface(
      spec({
        a: { type: "Text", props: { text: { $format: "number", $concat: ["a", "b"], value: 3 } } },
        b: { type: "Text", props: { text: { $cond: "/isAdmin", $then: "Admin", $else: "User" } } },
        c: {
          type: "Text",
          props: { text: { $cond: { $state: "/isAdmin" }, $then: { $format: "number", value: 1 }, $else: "x" } },
        },
      }),
    )
    expect(result.issues.map((issue) => [issue.code, issue.elementKey, issue.message.split(",")[0]])).toEqual([
      ["invalid_expression", "a", '"text" has several directives ($format'],
      ["invalid_expression", "b", '"text" has a $cond that is not a condition'],
    ])
  })

  test("onSuccess/onError handlers written as expressions are reported as ignored", () => {
    const raw = spec({
      q: {
        type: "Input",
        props: { label: "Q" },
        watch: {
          "/q": {
            action: "showToast",
            params: { title: "t" },
            onSuccess: { action: "sendPrompt", params: { $state: "/evil" } },
            onError: { action: "showToast", $state: "/h" },
          },
        },
      },
    })
    for (const input of [raw, normalizeSpec(raw)])
      expect(validateSurface(input).issues.map((issue) => [issue.code, issue.message.split(":")[0]])).toEqual([
        ["dynamic_chain", 'watch["/q"].onSuccess is ignored'],
        ["dynamic_chain", 'watch["/q"].onError is ignored'],
      ])
  })

  test("outward actions where no activation can happen never run, and say so", () => {
    const raw = spec({
      q: {
        type: "Input",
        props: { label: "Q" },
        on: {
          submit: { action: "sendPrompt", params: { text: "ok" } },
          blur: { action: "sendPrompt", params: { text: "x" } },
          focus: [{ action: "setState", params: { statePath: "/f", value: true } }, { action: "copyText" }],
        },
        watch: {
          "/q": [
            { action: "showToast", params: { title: "t" } },
            { action: "showToast", params: { title: "t" }, onSuccess: { action: "openLink" } },
            { action: "openCanvas", params: { canvas: "main" }, confirm: true },
          ],
        },
      },
      s: { type: "Slider", props: {}, on: { change: { action: "insertPrompt", params: { text: "x" } } } },
      go: { type: "Button", props: { label: "Go" }, on: { press: { action: "openLink", params: { url: "x" } } } },
    })
    for (const input of [raw, normalizeSpec(raw)]) {
      const issues = validateSurface(input).issues
      expect(issues.map((issue) => [issue.code, issue.elementKey, issue.message.split(":")[0]])).toEqual([
        ["outward_action_in_event", "q", "sendPrompt in on.blur never runs"],
        ["outward_action_in_event", "q", "copyText in on.focus[1] never runs"],
        ["outward_action_in_watch", "q", 'openLink in watch["/q"][1].onSuccess never runs'],
        ["confirm_in_watch", "q", 'openCanvas in watch["/q"][2] asks for a confirm, so it never runs'],
        ["outward_action_in_event", "s", "insertPrompt in on.change never runs"],
      ])
      expect(issues.every((issue) => issue.severity === "warning" && issue.message.endsWith(ACTIVATION_RULE))).toBe(
        true,
      )
    }
    expect(ACTIVATION_RULE).toContain("on.press of Button or Link")
    expect(ACTIVATION_RULE).toContain("on.submit of Input")
  })

  test("a binding without an action is reported", () => {
    const result = validateSurface(
      spec({ b: { type: "Button", props: { label: "B" }, on: { press: { params: {} } } } }),
    )
    expect(result.issues[0]).toMatchObject({ code: "invalid_binding", elementKey: "b" })
  })

  test("uses the catalog it is given", () => {
    const catalog = getCatalog()
    const narrowed = { data: catalog.data, componentNames: ["Stack"], actionNames: [] } as unknown as typeof catalog
    const result = validateSurface(
      spec({ t: { type: "Text", props: { text: "x" }, on: { press: { action: "sendPrompt" } } } }),
      narrowed,
    )
    expect(codes(result.issues)).toEqual(["unknown_component", "unknown_action"])
  })
})

describe("validateSurface: validation checks", () => {
  test("patterns the safe matcher cannot run are reported, before and after normalizing", () => {
    const raw = spec({
      f: {
        type: "Input",
        props: {
          label: "F",
          checks: [
            { type: "pattern", args: { pattern: "^(a+)+$" }, message: "ok, runs safely" },
            { type: "pattern", args: { pattern: "^(\\w)\\1$" }, message: "backreference" },
            { type: "pattern", args: { pattern: "(?=x)" }, message: "lookahead" },
          ],
        },
      },
    })
    for (const input of [raw, normalizeSpec(raw)]) {
      expect(only(validateSurface(input).issues, "unsupported_pattern").map((issue) => issue.message)).toEqual([
        "the pattern of checks[1] is ignored: backreferences are not supported",
        "the pattern of checks[2] is ignored: lookarounds are not supported",
      ])
    }
  })

  test("checks written as expressions are reported, before and after normalizing", () => {
    const raw = spec({
      a: { type: "Input", props: { label: "A", checks: { $state: "/rules" } } },
      b: { type: "Input", props: { label: "B", checks: [{ type: { $state: "/t" }, message: "m" }] } },
    })
    for (const input of [raw, normalizeSpec(raw)]) {
      const issues = only(validateSurface(input).issues, "dynamic_check")
      expect(issues.map((issue) => issue.elementKey)).toEqual(["a", "b"])
      expect(issues.every((issue) => issue.severity === "warning")).toBe(true)
    }
  })
})

describe("formatIssuesForAgent", () => {
  const issues: SurfaceIssue[] = [
    { severity: "warning", code: "unknown_action", message: 'unknown action "deploy" in on.press', elementKey: "go" },
    { severity: "error", code: "unknown_component", message: 'unknown component "Dropdown"', elementKey: "env-select" },
    { severity: "error", code: "missing_root", message: "no root is set" },
  ]

  test("names the surface, lists errors first, and asks for the block again", () => {
    const text = formatIssuesForAgent({
      issues,
      lineErrors: [{ line: 3, text: '{"op":"add"', message: "Unexpected end of JSON input" }],
      kind: "canvas",
      id: "deploy",
      title: "Deploy dashboard",
    })
    expect(text).toBe(
      [
        'The UI "Deploy dashboard" (canvas `deploy`) has problems:',
        '- element `env-select`: unknown component "Dropdown"',
        "- no root is set",
        '- line 3: Unexpected end of JSON input in `{"op":"add"`',
        '- element `go`: unknown action "deploy" in on.press',
        "",
        "Please resend the corrected ```canvas block.",
      ].join("\n"),
    )
  })

  test("inline surfaces ask for a spec block; a missing title is left out", () => {
    const text = formatIssuesForAgent({ issues: issues.slice(1), kind: "inline", id: "a1b2" })
    expect(text.split("\n")[0]).toBe("The UI (inline spec `a1b2`) has problems:")
    expect(text.endsWith("Please resend the corrected ```spec block.")).toBe(true)
  })

  test("deduplicates", () => {
    const text = formatIssuesForAgent({ issues: [...issues, ...issues], kind: "canvas", id: "x" })
    expect(text.match(/unknown component/g)).toHaveLength(1)
  })

  test("keeps model-written text on one line and without backticks", () => {
    const text = formatIssuesForAgent({
      issues: [{ severity: "error", code: "x", message: "line one\nline two", elementKey: "a`b\nc" }],
      kind: "canvas",
      id: "x",
      title: 'A "quoted"\ntitle',
    })
    const lines = text.split("\n")
    expect(lines[0]).toBe("The UI \"A 'quoted' title\" (canvas `x`) has problems:")
    expect(lines[1]).toBe("- element `a'b c`: line one line two")
  })

  test("caps the length and says how many problems were left out", () => {
    const many: SurfaceIssue[] = Array.from({ length: 200 }, (_, index) => ({
      severity: index % 2 ? "warning" : "error",
      code: "missing_child",
      message: `child "element-number-${index}" is not defined`,
      elementKey: `parent-${index}`,
    }))
    const text = formatIssuesForAgent({ issues: many, kind: "canvas", id: "big", title: "T".repeat(500) })
    expect(text.length).toBeLessThanOrEqual(MAX_AGENT_MESSAGE)
    expect(text).toMatch(/- \.\.\. and \d+ more\n\nPlease resend the corrected ```canvas block\.$/)
    // Errors come before warnings.
    const bullets = text.split("\n").filter((line) => line.startsWith("- element"))
    expect(bullets.every((line) => /parent-\d*[02468]`/.test(line))).toBe(true)
  })

  test("still asks for a resend when there are no details", () => {
    expect(formatIssuesForAgent({ issues: [], kind: "canvas", id: "x" })).toContain("- the UI could not be rendered")
  })
})
