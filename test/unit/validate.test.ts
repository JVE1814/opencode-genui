import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import { getCatalog } from "../../src/catalog/index.ts"
import { normalizeSpec } from "../../src/protocol/normalize.ts"
import {
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
