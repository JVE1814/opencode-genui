import {
  createComponent,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js"
import type { DirectiveDefinition } from "@json-render/core"
import type { BaseComponentProps, ComponentRegistry, ComponentRenderProps } from "@json-render/solid"
import { RENDER_UNITS, TEXT_PER_UNIT } from "../shared/constants.ts"

// How genui plugs its components into json-render's renderer. Kept free of JSX so unit tests can run it without a DOM
// (test/unit/element.test.ts); src/gui/registry.tsx feeds it the real components.

/** A genui component as written in src/gui/components (the context json-render's defineRegistry would pass). */
export type ElementImpl = (ctx: BaseComponentProps<any>) => JSX.Element

const ELEMENT_KEY = Symbol("genui.elementKey")

/**
 * The spec key of the element a component renders (json-render passes it with the patch in patches/), for UI state a
 * component keeps per element outside the state store (see useRemembered in components/shared.tsx).
 */
export const elementKeyOf = (ctx: BaseComponentProps<any>): string | undefined =>
  (ctx as { readonly [ELEMENT_KEY]?: string })[ELEMENT_KEY]

/**
 * An element's rendered children that keep their identity while the element changes.
 *
 * json-render passes children as a getter that builds a new `<For>` (or repeat list) of child renderers on every read,
 * and tracks the element while doing so. A component that read it in JSX or a memo re-created its whole subtree each
 * time its resolved element changed: on every state change for Tabs (its `value` is always bound) or any element with a
 * `$state`/`$template` prop, and on every canvas patch that touched the element. Inputs lost focus and what they held,
 * open sections closed. Reading it once, untracked, is enough: the list inside follows the element's `children` by
 * itself. It is read again only when the element switches between plain children and `repeat`, which the getter
 * decides at read time.
 */
export function stableChildren(props: Pick<ComponentRenderProps, "element" | "children">): Accessor<JSX.Element> {
  const repeat = createMemo(() => !!props.element?.repeat)
  return createMemo(() => {
    repeat()
    return untrack(() => props.children)
  })
}

export { RENDER_UNITS, TEXT_PER_UNIT }

/**
 * An element's units (see RENDER_UNITS): one, plus its props' size over TEXT_PER_UNIT. The walk stops once the size
 * passes the whole budget.
 */
export function unitsOf(props: unknown): number {
  const limit = RENDER_UNITS * TEXT_PER_UNIT
  let size = 0
  const stack: unknown[] = [props]
  while (stack.length > 0 && size <= limit) {
    const value = stack.pop()
    if (typeof value === "string") size += value.length
    else if (Array.isArray(value)) {
      size += value.length
      for (const item of value) stack.push(item)
    } else if (value && typeof value === "object") {
      const entries = Object.values(value)
      size += entries.length
      for (const item of entries) stack.push(item)
    }
  }
  return 1 + Math.floor(Math.min(size, limit + 1) / TEXT_PER_UNIT)
}

/**
 * What one surface renders, in units (see RENDER_UNITS). A repeat inside a repeat renders the product of their lists
 * (300 × 300 items made 90,000 elements from a block of 3 KB), and a long string in state shows in every row that reads
 * it (2,000 rows of a 40 KB string made 80 MB of text): both froze the window for seconds. An element that does not fit
 * in what is left renders nothing, and its children are not even built; the surface reports it. It renders again when
 * its own props change and then fit, or when it is mounted again; not when others go away meanwhile.
 */
export interface RenderBudget {
  used: number
  /** How many mounted elements render nothing because they did not fit. */
  readonly skipped: Accessor<number>
  readonly setSkipped: (update: (count: number) => number) => void
}

export function createRenderBudget(): RenderBudget {
  const [skipped, setSkipped] = createSignal(0)
  return { used: 0, skipped, setSkipped }
}

/** The surface's render budget (none outside a surface: unit tests render without a limit unless they provide one). */
export const RenderBudgetContext = createContext<RenderBudget>()

/** Whether the element fits in the surface's budget, as its props change; takes its units while it does. */
function useFit(budget: RenderBudget, props: ComponentRenderProps): Accessor<boolean> {
  let taken = 0
  let skipped = false
  const skip = (now: boolean) => {
    if (now === skipped) return
    skipped = now
    budget.setSkipped((count) => count + (now ? 1 : -1))
  }
  onCleanup(() => {
    budget.used -= taken
    taken = 0
    skip(false)
  })
  return createMemo(() => {
    const units = unitsOf(props.element?.props)
    budget.used -= taken
    taken = budget.used + units <= RENDER_UNITS ? units : 0
    budget.used += taken
    untrack(() => skip(taken === 0))
    return taken > 0
  })
}

/**
 * The one renderer json-render calls for every element, known type or not.
 *
 * json-render picks an element's component once, when its key first renders: a non-keyed `<Show>` keeps the first
 * component while the type stays known, so a canvas patch that turned a Badge into an Alert, or fixed an unknown
 * component, kept showing the old one. This renderer follows `element.type` instead, and remounts only the element's
 * own component when it changes; its children (see `stableChildren`) are kept and move into the new component.
 *
 * Components are looked up as own properties only, so a type such as "toString" or "__proto__" is unknown, not
 * `Object.prototype`'s member. Inside a surface, an element renders only while it fits in the surface's RenderBudget.
 */
export function createElementRenderer(
  components: Readonly<Record<string, ElementImpl>>,
  unknown: Component<ComponentRenderProps>,
): Component<ComponentRenderProps> {
  const lookup = (type: unknown): ElementImpl | undefined =>
    typeof type === "string" && Object.hasOwn(components, type) ? components[type] : undefined

  function renderElement(props: ComponentRenderProps): JSX.Element {
    const kids = stableChildren(props)
    const impl = createMemo(() => lookup(props.element?.type))
    const ctx: BaseComponentProps & { readonly [ELEMENT_KEY]?: string } = {
      get [ELEMENT_KEY]() {
        return (props as { readonly elementKey?: string }).elementKey
      },
      get props() {
        return props.element.props as Record<string, unknown>
      },
      get children() {
        return kids()
      },
      get emit() {
        return props.emit
      },
      get on() {
        return props.on
      },
      get bindings() {
        return props.bindings
      },
      get loading() {
        return props.loading
      },
    }
    const view: ComponentRenderProps = {
      get element() {
        return props.element
      },
      get children() {
        return kids()
      },
      get emit() {
        return props.emit
      },
      get on() {
        return props.on
      },
      get bindings() {
        return props.bindings
      },
      get loading() {
        return props.loading
      },
    }
    const rendered = createMemo(() => {
      const fn = impl()
      return untrack(() =>
        fn ? createComponent(fn as Component<BaseComponentProps>, ctx) : createComponent(unknown, view),
      )
    })
    return rendered as unknown as JSX.Element
  }

  return function GenuiElement(props: ComponentRenderProps): JSX.Element {
    const budget = useContext(RenderBudgetContext)
    if (!budget) return renderElement(props)
    const fits = useFit(budget, props)
    return createMemo(() => (fits() ? untrack(() => renderElement(props)) : undefined)) as unknown as JSX.Element
  }
}

/**
 * A registry for json-render with every known type mapped to `element`, on an object without a prototype (json-render
 * reads `registry[type]`). Pass the same `element` as the Renderer's `fallback`, so a type that is unknown now and
 * known after a patch is rendered by the same component, which follows the type.
 */
export function buildRegistry(names: Iterable<string>, element: Component<ComponentRenderProps>): ComponentRegistry {
  const registry = Object.create(null) as ComponentRegistry
  for (const name of names) registry[name] = element
  return registry
}

/**
 * Directives that never throw. json-render resolves them inside the parent element's memo, so a directive that throws
 * (`$format: "date"` before its value has streamed in, a bad currency code, `$concat` of a non-array) blanked the
 * parent element for good: json-render's error boundaries never reset. A failing directive resolves to `undefined`
 * instead, and resolves again when its inputs change.
 */
export function guardDirectives(directives: readonly DirectiveDefinition[]): DirectiveDefinition[] {
  return directives.map((directive) => ({
    ...directive,
    resolve: (value, ctx) => {
      try {
        return directive.resolve(value, ctx)
      } catch {
        return undefined
      }
    },
  }))
}
