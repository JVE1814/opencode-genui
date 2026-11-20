import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import { OUTWARD_BURST } from "../../src/catalog/actions.ts"
import { compileSpec } from "../../src/protocol/compile.ts"
import { normalizeNotes, normalizeSpec } from "../../src/protocol/normalize.ts"
import { formatIssuesForAgent, validateSurface } from "../../src/protocol/validate.ts"

// What the issues footer and "Ask agent to fix" see is compileSpec: the normalizer first, then the validator. Mistakes the
// normalizer removes before validation must still be reported (review 4, CORRECTNESS#3), and so must bindings that
// cannot run as written (CORRECTNESS#4, CORRECTNESS#5, USE#7).

const spec = (elements: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    root: "root",
    elements: { root: { type: "Stack", props: {}, children: Object.keys(elements) }, ...elements },
    ...extra,
  }) as unknown as Spec

const button = (on: unknown) => ({ type: "Button", props: { label: "Go" }, on, children: [] })

const found = (raw: Spec, options: { streaming?: boolean } = {}) =>
  compileSpec(raw, options).issues.map((issue) => `${issue.code}@${issue.elementKey ?? ""}`)

const issue = (raw: Spec, code: string) => compileSpec(raw).issues.find((entry) => entry.code === code)

describe("what the normalizer removes is still reported", () => {
  test.each([
    ["an element without a type", spec({ card: { props: { title: "Settings" }, children: [] } }), "missing_type@card"],
    ["an element that is not an object", spec({ card: "Card" }), "invalid_element@card"],
    ["an element that is null", spec({ card: null }), "invalid_element@card"],
    ["a binding written as a string", spec({ b: button({ press: "sendPrompt" }) }), "invalid_binding@b"],
    ["a string in an array of bindings", spec({ b: button({ press: ["sendPrompt"] }) }), "invalid_binding@b"],
    ["an `on` that is not a map", spec({ b: button("press") }), "invalid_binding@b"],
    [
      "a `watch` that is not a map",
      spec({ i: { type: "Input", props: { label: "Q" }, watch: ["/q"], children: [] } }),
      "invalid_binding@i",
    ],
    [
      "an invalid repeat",
      spec(
        {
          list: { type: "Stack", props: {}, repeat: { path: "/items" }, children: ["row"] },
          row: { type: "Text", props: { text: { $item: "name" } }, children: [] },
        },
        { state: { items: [{ name: "a" }] } },
      ),
      "invalid_repeat@list",
    ],
    [
      "children that are not an array",
      spec({ s: { type: "Stack", props: {}, children: "row" } }),
      "invalid_children@s",
    ],
    [
      "children that are not keys",
      spec({ s: { type: "Stack", props: {}, children: [{ type: "Text" }] } }),
      "invalid_children@s",
    ],
    [
      "a child that names an inherited property",
      spec({ s: { type: "Stack", props: {}, children: ["toString"] } }),
      "missing_child@s",
    ],
    [
      "a navigate handler",
      spec({ b: button({ press: { action: "showToast", params: { title: "x" }, onSuccess: { navigate: "/next" } } }) }),
      "invalid_chain@b",
    ],
    [
      "a handler written as a string",
      spec({ b: button({ press: { action: "copyText", params: { text: "x" }, onSuccess: "showToast" } }) }),
      "invalid_chain@b",
    ],
    [
      "a confirm on a built-in",
      spec({
        b: button({ press: { action: "removeState", params: { statePath: "/todos", index: 0 }, confirm: "Delete?" } }),
      }),
      "confirm_on_builtin@b",
    ],
  ] as const)("%s", (_, raw, code) => {
    expect(found(raw)).toContain(code)
    // The element or binding is gone from what renders.
    expect(normalizeNotes(compileSpec(raw).spec).map((note) => `${note.code}@${note.elementKey ?? ""}`)).toContain(code)
  })

  test("a chain nested deeper than the normalizer follows", () => {
    let handler: Record<string, unknown> = { action: "showToast", params: { title: "deep" } }
    for (let depth = 0; depth < 10; depth++)
      handler = { action: "showToast", params: { title: "x" }, onSuccess: handler }
    expect(issue(spec({ b: button({ press: handler }) }), "invalid_chain")?.message).toContain("at most 8 deep")
  })

  test('an element under the key "__proto__"', () => {
    const raw = JSON.parse(
      '{"root":"root","elements":{"root":{"type":"Stack","props":{},"children":[]},"__proto__":{"type":"Text","props":{"text":"x"}}}}',
    )
    expect(found(raw)).toContain("invalid_element@")
  })

  test('an event named "__proto__"', () => {
    const raw = JSON.parse(
      '{"root":"b","elements":{"b":{"type":"Button","props":{"label":"Go"},"on":{"__proto__":{"action":"showToast","params":{"title":"x"}}}}}}',
    )
    expect(issue(raw, "invalid_binding")?.message).toBe('on.__proto__ is ignored: "__proto__" is reserved')
  })

  test("the messages say where, in the validator's own words", () => {
    const raw = spec({ b: button({ press: [{ action: "showToast", params: { title: "x" } }, "copyText"] }) })
    expect(issue(raw, "invalid_binding")).toEqual({
      severity: "warning",
      code: "invalid_binding",
      message: 'on.press[1] is not an action binding ({ "action": "...", "params": {...} })',
      elementKey: "b",
    })
    expect(issue(spec({ card: { props: {} } }), "missing_type")).toEqual({
      severity: "error",
      code: "missing_type",
      message: "has no component type",
      elementKey: "card",
    })
  })

  test("they reach the agent through Ask agent to fix", () => {
    const compiled = compileSpec(spec({ b: button({ press: "sendPrompt" }), card: { props: {} } }))
    const message = formatIssuesForAgent({ issues: compiled.issues, kind: "inline", id: "x" })
    expect(message).toContain("element `card`: has no component type")
    expect(message).toContain("element `b`: on.press is not an action binding")
  })

  test("the notes stay with the normalized spec, also when it is normalized again; other specs have none", () => {
    const raw = spec({ card: { props: {} } })
    const once = normalizeSpec(raw)
    expect(normalizeSpec(once)).toBe(once)
    expect(validateSurface(normalizeSpec(once)).issues.map((entry) => entry.code)).toContain("missing_type")
    expect(normalizeNotes(raw)).toEqual([])
    expect(normalizeNotes(spec({ t: { type: "Text", props: { text: "fine" } } }))).toEqual([])
  })

  test("they show while a canvas streams too, unlike references to elements still to come", () => {
    const raw = spec({ card: { props: {} }, s: { type: "Stack", props: {}, children: ["later"] } })
    expect(found(raw, { streaming: true })).toEqual(["missing_type@card"])
  })

  test("a well-formed spec gets no notes", () => {
    const raw = spec({
      list: { type: "Stack", props: {}, repeat: { statePath: "/items" }, children: ["row"] },
      row: { type: "Text", props: { text: { $item: "name" } }, children: [] },
      b: button({ press: { action: "sendPrompt", params: { text: "Go" }, onSuccess: { set: { "/sent": true } } } }),
    })
    expect(compileSpec({ ...raw, state: { items: [] } } as Spec).issues.map((entry) => entry.code)).toEqual([])
  })
})

describe("onSuccess/onError on a built-in never run", () => {
  test.each([
    [
      "validateForm then sendPrompt",
      { action: "validateForm", onSuccess: { action: "sendPrompt", params: { text: "Sent" } } },
    ],
    [
      "setState then showToast",
      {
        action: "setState",
        params: { statePath: "/saved", value: true },
        onSuccess: { action: "showToast", params: { title: "Saved" } },
      },
    ],
    [
      "removeState with onError",
      { action: "removeState", params: { statePath: "/l", index: 0 }, onError: { set: { "/e": 1 } } },
    ],
  ])("%s", (_, press) => {
    const raw = spec({ b: button({ press }) })
    const found = issue(raw, "chain_on_builtin")
    expect(found?.severity).toBe("warning")
    expect(found?.message).toContain("never runs")
    expect(found?.message).toContain("in an array")
    // Reported on the raw spec as well.
    expect(validateSurface(raw).issues.map((entry) => entry.code)).toContain("chain_on_builtin")
  })

  test("also for a built-in inside a custom action's chain; what that dead chain holds is not reported again", () => {
    const raw = spec({
      b: button({
        press: {
          action: "showToast",
          params: { title: "x" },
          onSuccess: { action: "setState", params: { statePath: "/a", value: 1 }, onSuccess: { action: "nope" } },
        },
      }),
    })
    const codes = compileSpec(raw).issues.map((entry) => entry.code)
    expect(codes).toContain("chain_on_builtin")
    expect(codes).not.toContain("unknown_action")
  })

  test("the array the message suggests is fine", () => {
    const raw = spec({
      b: button({
        press: [
          { action: "setState", params: { statePath: "/saved", value: true } },
          { action: "showToast", params: { title: "Saved" } },
        ],
      }),
    })
    expect(found(raw)).toEqual([])
  })
})

describe('{ "$item": ... } as a built-in\'s state path inside a chain', () => {
  const todos = (press: unknown) =>
    ({
      root: "list",
      elements: {
        list: { type: "Stack", props: {}, repeat: { statePath: "/todos" }, children: ["done"] },
        done: button({ press }),
      },
      state: { todos: [{ title: "Write tests", done: false }] },
    }) as unknown as Spec

  test("is reported: it gives the item's value there", () => {
    const raw = todos({
      action: "showToast",
      params: { title: "Done" },
      onSuccess: { action: "setState", params: { statePath: { $item: "done" }, value: true } },
    })
    const found = issue(raw, "item_path_in_chain")
    expect(found?.elementKey).toBe("done")
    expect(found?.message).toContain('{ "$item": "done" } as setState\'s statePath gives the item\'s value here')
  })

  test("is fine in the bound action itself, and as a value", () => {
    expect(found(todos({ action: "setState", params: { statePath: { $item: "done" }, value: true } }))).toEqual([])
    const asValue = todos({
      action: "showToast",
      params: { title: "Done" },
      onSuccess: { action: "pushState", params: { statePath: "/log", value: { $item: "title" } } },
    })
    expect(found(asValue)).toEqual([])
  })
})

describe("custom action params are checked against the catalog", () => {
  test.each([
    [
      "openLink {href}",
      { action: "openLink", params: { href: "https://docs.acme.dev" } },
      ['"url" is required', 'unknown param "href"', "It takes { url }"],
    ],
    [
      "copyText {value}",
      { action: "copyText", params: { value: "npm i" } },
      ['"text" is required', "It takes { text, label? }"],
    ],
    [
      "sendPrompt {message}",
      { action: "sendPrompt", params: { message: "Deploy" } },
      ['"text" is required', 'unknown param "message"'],
    ],
    ["openCanvas {id}", { action: "openCanvas", params: { id: "dashboard" } }, ['"canvas" is required']],
    [
      "showToast variant warning",
      { action: "showToast", params: { title: "Heads up", variant: "warning" } },
      ['"variant" should be one of "default", "success", "error", got "warning"'],
    ],
    ["insertPrompt without params", { action: "insertPrompt" }, ['"text" is required']],
  ])("%s", (_, press, parts) => {
    const found = issue(spec({ b: button({ press }) }), "invalid_action_params")
    expect(found?.severity).toBe("warning")
    for (const part of parts) expect(found?.message).toContain(part)
  })

  test("also inside a chain, and in watch", () => {
    const raw = spec({
      b: button({
        press: { action: "sendPrompt", params: { text: "x" }, onSuccess: { action: "showToast", params: {} } },
      }),
      i: { type: "Input", props: { label: "Q" }, watch: { "/q": { action: "showToast", params: { titel: "x" } } } },
    })
    expect(found(raw).filter((code) => code.startsWith("invalid_action_params"))).toEqual([
      "invalid_action_params@b",
      "invalid_action_params@i",
    ])
  })

  test("values only known when the action runs, reserved params and a confirm are not problems", () => {
    const raw = {
      root: "list",
      elements: {
        list: { type: "Stack", props: {}, repeat: { statePath: "/links" }, children: ["open"] },
        open: button({
          press: [
            { action: "openLink", params: { url: { $item: "href" } }, confirm: { title: "Open?" } },
            { action: "copyText", params: { text: { $template: "${/a}" }, label: "A" } },
            { action: "sendPrompt", params: { text: { $state: "/t" }, data: { $state: "/form" } } },
            { action: "showToast", params: { title: "x", variant: { $state: "/v" } } },
          ],
        }),
      },
      state: { links: [] },
    } as unknown as Spec
    expect(found(raw)).toEqual([])
  })
})

describe("more outward actions than one activation runs", () => {
  const outward = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ action: "copyText", params: { text: String(index) } }))

  test(`more than ${OUTWARD_BURST} in one event is reported; ${OUTWARD_BURST} is fine`, () => {
    expect(found(spec({ b: button({ press: outward(OUTWARD_BURST) }) }))).toEqual([])
    const found4 = issue(spec({ b: button({ press: outward(OUTWARD_BURST + 1) }) }), "outward_burst")
    expect(found4?.message).toContain(`runs ${OUTWARD_BURST + 1} of sendPrompt`)
    expect(found4?.message).toContain(`at most ${OUTWARD_BURST}`)
  })

  test("chains count along the path that runs: onSuccess or onError, not both", () => {
    const chain = (depth: number): Record<string, unknown> => ({
      action: "copyText",
      params: { text: "x" },
      ...(depth > 1 ? { onSuccess: chain(depth - 1) } : {}),
    })
    expect(found(spec({ b: button({ press: chain(OUTWARD_BURST + 1) }) }))).toContain("outward_burst@b")
    const either = {
      action: "copyText",
      params: { text: "x" },
      onSuccess: { action: "openLink", params: { url: "https://a.dev" } },
      onError: { action: "sendPrompt", params: { text: "failed" } },
    }
    expect(found(spec({ b: button({ press: [either] }) }))).toEqual([])
  })

  test("passive bindings are reported once, as never running, not as a burst", () => {
    const raw = spec({ i: { type: "Input", props: { label: "Q" }, on: { blur: outward(OUTWARD_BURST + 1) } } })
    expect(found(raw).filter((code) => code === "outward_burst@i")).toEqual([])
  })
})
