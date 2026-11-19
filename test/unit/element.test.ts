import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, createSignal, type JSX } from "solid-js"
import { createDirectiveRegistry, resolvePropValue, type DirectiveDefinition, type UIElement } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import type { BaseComponentProps, ComponentRenderProps } from "@json-render/solid"
import { buildRegistry, createElementRenderer, guardDirectives, type ElementImpl } from "../../src/gui/element.ts"

type Element = UIElement<string, Record<string, unknown>>

/**
 * Render props shaped like json-render's ElementRendererContent passes them: `element` follows a signal, and the
 * `children` getter tracks the element and returns a new list on every read, as json-render's does.
 */
function fakeRenderProps(initial: Element) {
  const [element, setElement] = createSignal(initial)
  let reads = 0
  const props: ComponentRenderProps = {
    get element() {
      return element()
    },
    get children() {
      reads++
      return { list: element().repeat ? "repeat" : "for", read: reads } as unknown as JSX.Element
    },
    emit: () => {},
    on: () => ({ emit: () => {}, shouldPreventDefault: false, bound: false }),
    loading: false,
  }
  return { props, setElement, reads: () => reads }
}

const element = (type: string, props: Record<string, unknown> = {}, extra: Partial<Element> = {}): Element => ({
  type,
  props,
  children: [],
  ...extra,
})

/** Components that record their mounts and every `ctx.children` value a tracked computation sees. */
function recorder() {
  const mounts: string[] = []
  const seen: unknown[] = []
  const texts: unknown[] = []
  const impl =
    (name: string): ElementImpl =>
    (ctx: BaseComponentProps) => {
      mounts.push(name)
      createComputed(() => seen.push(ctx.children))
      createComputed(() => texts.push(ctx.props.text))
      return `${name}:${String(ctx.props.text ?? "")}` as unknown as JSX.Element
    }
  const unknown = (props: ComponentRenderProps) => {
    mounts.push(`unknown:${props.element.type}`)
    createComputed(() => seen.push(props.children))
    return "unknown" as unknown as JSX.Element
  }
  return { mounts, seen, texts, impl, unknown }
}

function mount(components: Record<string, ElementImpl>, unknown: (props: ComponentRenderProps) => JSX.Element) {
  return (initial: Element) =>
    createRoot((dispose) => {
      const fake = fakeRenderProps(initial)
      const Renderer = createElementRenderer(components, unknown)
      const rendered = Renderer(fake.props) as unknown as () => unknown
      return { ...fake, rendered, dispose }
    })
}

describe("element renderer", () => {
  test("reads json-render's children getter once while the element's props change", () => {
    const r = recorder()
    const view = mount({ Card: r.impl("Card") }, r.unknown)(element("Card", { text: "a" }))
    for (const text of ["b", "c", "d", "e"]) view.setElement(element("Card", { text }))
    expect(view.reads()).toBe(1)
    // A tracked reader of ctx.children saw one value: the subtree was never re-created.
    expect(r.seen.length).toBe(1)
    // Same type: the component itself did not remount either, and its props stay live.
    expect(r.mounts).toEqual(["Card"])
    expect(r.texts).toEqual(["a", "b", "c", "d", "e"])
    view.dispose()
  })

  test("reads the children again only when the element switches to or from repeat", () => {
    const r = recorder()
    const view = mount({ Stack: r.impl("Stack") }, r.unknown)(element("Stack"))
    view.setElement(element("Stack", { gap: "sm" }, { repeat: { statePath: "/todos" } }))
    view.setElement(element("Stack", { gap: "md" }, { repeat: { statePath: "/other" } }))
    expect(view.reads()).toBe(2)
    expect(r.seen.map((value) => (value as { list: string }).list)).toEqual(["for", "repeat"])
    view.dispose()
  })

  test("follows a type change at the same key and hands the new component the same children", () => {
    const r = recorder()
    const view = mount({ Badge: r.impl("Badge"), Alert: r.impl("Alert") }, r.unknown)(element("Badge", { text: "x" }))
    expect(view.rendered()).toBe("Badge:x")
    view.setElement(element("Alert", { text: "y" }))
    expect(view.rendered()).toBe("Alert:y")
    expect(r.mounts).toEqual(["Badge", "Alert"])
    expect(view.reads()).toBe(1)
    expect(r.seen[0]).toBe(r.seen[1])
    view.dispose()
  })

  test("an unknown type fixed by a patch renders the real component", () => {
    const r = recorder()
    const view = mount({ Table: r.impl("Table") }, r.unknown)(element("KanbanBoard"))
    expect(view.rendered()).toBe("unknown")
    view.setElement(element("Table"))
    expect(view.rendered()).toBe("Table:")
    expect(r.mounts).toEqual(["unknown:KanbanBoard", "Table"])
    view.dispose()
  })

  test("types named after Object.prototype members are unknown", () => {
    const r = recorder()
    const render = mount({ Text: r.impl("Text") }, r.unknown)
    for (const type of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) {
      const view = render(element(type))
      expect(view.rendered()).toBe("unknown")
      view.dispose()
    }
  })
})

describe("buildRegistry", () => {
  test("maps known types to the element renderer on an object without a prototype", () => {
    const renderer = () => null
    const registry = buildRegistry(["Text", "Card"], renderer)
    expect(Object.getPrototypeOf(registry)).toBeNull()
    expect(registry.Text).toBe(renderer)
    expect(registry.Card).toBe(renderer)
    for (const type of ["toString", "__proto__", "constructor", "hasOwnProperty"])
      expect(registry[type]).toBeUndefined()
  })
})

describe("guardDirectives", () => {
  const resolve = (value: unknown, directives: readonly DirectiveDefinition[], state: Record<string, unknown> = {}) =>
    resolvePropValue(value, { stateModel: state, directives: createDirectiveRegistry([...directives]) })

  test("a directive that throws resolves to undefined instead", () => {
    const value = { $format: "date", value: { $state: "/deployedAt" } }
    // json-render's own directive throws while the date has not streamed in, which blanked the parent element.
    expect(() => resolve(value, standardDirectives)).toThrow()
    const guarded = guardDirectives(standardDirectives)
    expect(resolve(value, guarded)).toBeUndefined()
    expect(resolve(value, guarded, { deployedAt: "last tuesday" })).toBeUndefined()
    expect(resolve({ $format: "currency", value: 3, currency: "not a code" }, guarded)).toBeUndefined()
  })

  test("working directives resolve as before", () => {
    const guarded = guardDirectives(standardDirectives)
    const date = { $format: "date", value: { $state: "/at" }, locale: "en-US", options: { timeZone: "UTC" } }
    expect(resolve(date, guarded, { at: "2026-11-18T10:00:00Z" })).toBe(
      resolve(date, standardDirectives, { at: "2026-11-18T10:00:00Z" }) as string,
    )
    expect(resolve({ $math: "add", a: 2, b: 3 }, guarded)).toBe(5)
    expect(guarded.map((directive) => directive.name)).toEqual(standardDirectives.map((directive) => directive.name))
  })
})
