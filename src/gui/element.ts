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
  type Context,
  type JSX,
} from "solid-js"
import { getByPath, resolveRepeatStatePath, type DirectiveDefinition } from "@json-render/core"
import type { BaseComponentProps, ComponentRegistry, ComponentRenderProps } from "@json-render/solid"
import {
  budgetVersion,
  createMeter,
  defer,
  fitsIn,
  freed,
  release,
  sliceAllows,
  sliceCost,
  spend,
  take,
  type Hold,
  type Meter,
  type Waiter,
} from "../runtime/budget.ts"
import { MAX_REPEAT_ROWS, RENDER_UNITS, SLOT_UNITS, TEXT_PER_UNIT } from "../shared/constants.ts"
import { domUnits } from "./costs.ts"
import { boundedDirective } from "./directives.ts"

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

export { RENDER_UNITS, SLOT_UNITS, TEXT_PER_UNIT }

const SIZE_LIMIT = RENDER_UNITS * TEXT_PER_UNIT

// The sizes of object prop values, by identity (see `sizeOf`).
const sizes = new WeakMap<object, number>()

/**
 * The size of a value (the length of its strings, its objects' keys included, plus the entries of its lists and
 * objects), up to just past SIZE_LIMIT. Keys count because a cell or a Text shows an object as JSON, keys and all. An
 * object's size is remembered by identity: every row of a repeat resolves its element's props on its own but shares
 * their static values (json-render resolves a value without expressions to itself, see patches/), and state values
 * are replaced, never changed in place, so a large value is walked once, not once per row.
 */
function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length
  if (!value || typeof value !== "object") return 0
  const known = sizes.get(value)
  if (known !== undefined) return known
  let size = 0
  const stack: unknown[] = [value]
  while (stack.length > 0 && size <= SIZE_LIMIT) {
    const next = stack.pop()
    if (typeof next === "string") size += next.length
    else if (next && typeof next === "object") {
      const remembered = next === value ? undefined : sizes.get(next)
      if (remembered !== undefined) {
        size += remembered
        continue
      }
      if (Array.isArray(next)) {
        size += next.length
        for (const item of next) stack.push(item)
      } else {
        for (const key in next) {
          if (!Object.hasOwn(next, key)) continue
          size += 1 + key.length
          stack.push((next as Record<string, unknown>)[key])
          if (size > SIZE_LIMIT) break
        }
      }
    }
  }
  const result = Math.min(size, SIZE_LIMIT + 1)
  sizes.set(value, result)
  return result
}

/**
 * An element's units (see RENDER_UNITS): one, plus its props' size over TEXT_PER_UNIT. The walk stops once the size
 * passes the whole budget.
 */
export function unitsOf(props: unknown): number {
  let size = 0
  if (props && typeof props === "object") {
    const entries = Array.isArray(props) ? props : Object.values(props)
    size = entries.length
    for (const value of entries) {
      if (size > SIZE_LIMIT) break
      size += sizeOf(value)
    }
  } else size = sizeOf(props)
  return 1 + Math.floor(Math.min(size, SIZE_LIMIT + 1) / TEXT_PER_UNIT)
}

/**
 * What an element costs the render budget: its props' units (see `unitsOf`), plus what its component builds from them
 * beyond that, such as a Table's rows × columns cells (see domUnits in src/gui/costs.ts).
 */
export function elementUnits(element: { readonly type?: unknown; readonly props?: unknown } | undefined): number {
  return unitsOf(element?.props) + domUnits(element?.type, element?.props)
}

/**
 * How many child renderers an element builds once it renders (see SLOT_UNITS): one per entry of its `children`, or,
 * for a repeat, one per child in each of its rows (one per row without children), whether each child then fits or not.
 */
export function slotsOf(element: { readonly children?: unknown; readonly repeat?: unknown } | undefined, rows: number) {
  const children = Array.isArray(element?.children) ? element.children.length : 0
  return element?.repeat ? Math.min(rows, MAX_REPEAT_ROWS) * Math.max(1, children) : children
}

/**
 * What one surface renders (see RENDER_UNITS and SLOT_UNITS), and the window-wide pool its surfaces share (see
 * POOL_SURFACES in src/runtime/budget.ts). A repeat inside a repeat renders the product of their lists (300 × 300 items
 * made 90,000 elements from a block of 3 KB), a repeat whose template lists many children builds rows × children
 * renderers (2,000 rows × 500 children), a long string in state shows in every row that reads it (2,000 rows of a 40 KB
 * string made 80 MB of text), and twenty copies of such a block in one tool output did all of it twenty times: each
 * froze the window for seconds. An element renders only if its units and its slots fit in what is left of the
 * surface's budget and of the pool; otherwise it renders nothing, its children are not even built, and the surface
 * reports it. It tries again when its own props change, or once room is freed anywhere in the window.
 *
 * A surface that renders through a sliced budget also starts at most TASK_UNITS (or TASK_MS) of elements per task; the
 * rest waits for later tasks, so the window keeps answering while a large UI fills in.
 */
export interface RenderBudget {
  /** The units the surface's rendered elements hold. */
  readonly used: number
  readonly meter: Meter
  /**
   * The window-wide pool (or pools) the surface's elements also charge. An element takes its room again when they
   * change (a surface that stops being the newest inline one, see joinInlinePool in src/runtime/budget.ts).
   */
  readonly pool?: () => Meter | readonly Meter[] | undefined
  /** Whether elements start in task-sized slices (see TASK_UNITS in src/runtime/budget.ts). */
  readonly sliced: boolean
  /** What the current task lends to the elements it defers to a later one (see `Waiter.around`). */
  readonly lend?: () => ((run: () => void) => void) | undefined
  /** How many mounted elements render nothing, or only some of their rows, because they did not fit. */
  readonly skipped: Accessor<number>
  readonly setSkipped: (update: (count: number) => number) => void
  /** How many of those would fit in the surface's own budget: the room went to other surfaces of the pool. */
  readonly pooled: Accessor<number>
  readonly setPooled: (update: (count: number) => number) => void
}

export function createRenderBudget(
  options: {
    readonly pool?: () => Meter | readonly Meter[] | undefined
    readonly sliced?: boolean
    readonly lend?: () => ((run: () => void) => void) | undefined
  } = {},
): RenderBudget {
  const meter = createMeter(RENDER_UNITS, SLOT_UNITS)
  const [skipped, setSkipped] = createSignal(0)
  const [pooled, setPooled] = createSignal(0)
  return {
    get used() {
      return meter.units
    },
    meter,
    ...(options.pool ? { pool: options.pool } : {}),
    ...(options.lend ? { lend: options.lend } : {}),
    sliced: options.sliced ?? false,
    skipped,
    setSkipped,
    pooled,
    setPooled,
  }
}

/** The surface's render budget (none outside a surface: unit tests render without a limit unless they provide one). */
export const RenderBudgetContext = createContext<RenderBudget>()

/**
 * json-render's hooks for the state and repeat scope an element renders in, so a repeat's rows are known before they
 * are built. Passed in (src/gui/registry.tsx) rather than imported: @json-render/solid needs a DOM when it loads, and
 * this file loads without one in unit tests. Without them, a repeat's rows are not counted in its slots.
 */
export interface JsonRenderHooks {
  readonly useStateStore: () => { readonly state: unknown }
  readonly useRepeatScope: () => { readonly basePath: string } | null
  /**
   * Where an element tells json-render's repeat how many of its rows to render (patches/@json-render%2Fsolid): those
   * that fit in the render budget. Without it, a repeat whose rows do not all fit renders none.
   */
  readonly RepeatRowsContext?: Context<Accessor<number | undefined> | undefined>
}

/** How many rows the element's repeat has, as json-render's repeat reads them (0 for an element without one). */
function useRows(props: ComponentRenderProps, hooks: JsonRenderHooks | undefined): Accessor<number> {
  let store: { readonly state: unknown } | undefined
  try {
    store = hooks?.useStateStore()
  } catch {
    store = undefined
  }
  const scope = hooks?.useRepeatScope()
  return () => {
    const repeat = props.element?.repeat
    if (!repeat || !store) return 0
    const path = resolveRepeatStatePath(repeat.statePath, scope?.basePath)
    if (path === undefined) return 0
    const list = getByPath(store.state as Record<string, unknown>, path)
    return Array.isArray(list) ? list.length : 0
  }
}

/** Whether an element renders, and, for a repeat whose rows do not all fit, how many of its rows do. */
interface Fit {
  readonly fits: boolean
  readonly rows?: number
}
const FITS: Fit = Object.freeze({ fits: true })
const REFUSED: Fit = Object.freeze({ fits: false })

/**
 * Whether the element renders, as its props and its rows change; it holds its units and slots while it does. An
 * element that does not fit waits for freed room; one that fits while its task's slice is spent waits for a later task.
 * A repeat whose rows do not all fit in the child slots left renders as many of its first rows as do, and reports the
 * rest; more of them render once room is freed.
 */
function useFit(budget: RenderBudget, props: ComponentRenderProps, hooks?: JsonRenderHooks): Accessor<Fit> {
  const rows = useRows(props, hooks)
  const units = createMemo(() => elementUnits(props.element))
  const slots = createMemo(() => slotsOf(props.element, rows()))
  // The slots one row of the element's repeat takes, or 0 without a repeat.
  const perRow = createMemo(() =>
    props.element?.repeat ? Math.max(1, Array.isArray(props.element.children) ? props.element.children.length : 0) : 0,
  )
  const [woken, setWoken] = createSignal(undefined, { equals: false })
  const waiter: Waiter = { wake: () => setWoken(undefined), queued: false, disposed: false }
  let hold: Hold | undefined
  let skipped = false
  let pooled = false
  const skip = (now: boolean, byPool: boolean) => {
    const inPool = now && byPool
    if (now !== skipped) budget.setSkipped((count) => count + (now ? 1 : -1))
    if (inPool !== pooled) budget.setPooled((count) => count + (inPool ? 1 : -1))
    skipped = now
    pooled = inPool
  }
  onCleanup(() => {
    waiter.disposed = true
    if (hold) {
      release(hold)
      if (hold.units > 0 || hold.slots > 0) freed()
    }
    hold = undefined
    skip(false, false)
  })
  return createMemo((): Fit => {
    const want = units()
    const children = slots()
    const each = perRow()
    woken()
    const before = hold
    if (before) release(before)
    hold = undefined
    const pool = budget.pool?.()
    const meters =
      pool === undefined ? [budget.meter] : [budget.meter, ...(Array.isArray(pool) ? pool : [pool as Meter])]
    let taken = children
    let limit: number | undefined
    if (!fitsIn(meters, want, children)) {
      // A repeat renders the rows that fit: its first ones.
      const room = Math.min(...meters.map((meter) => meter.maxSlots - meter.slots))
      const fitting = each > 0 ? Math.floor(room / each) : 0
      if (fitting > 0 && fitsIn(meters, want, fitting * each)) {
        limit = fitting
        taken = fitting * each
      } else {
        if (before) freed()
        untrack(() => skip(true, fitsIn([budget.meter], want, children)))
        // Try again once room is freed (also in another surface of the same pool).
        budgetVersion()
        return REFUSED
      }
    }
    if (!before && budget.sliced && !sliceAllows()) {
      untrack(() => skip(false, false))
      if (!waiter.queued) waiter.around = untrack(() => budget.lend?.())
      defer(waiter)
      return REFUSED
    }
    hold = take(meters, want, taken)
    if (budget.sliced) spend(sliceCost(want, taken) - (before ? sliceCost(before.units, before.slots) : 0))
    if (before && (want < before.units || taken < before.slots)) freed()
    if (limit === undefined) {
      untrack(() => skip(false, false))
      return FITS
    }
    // The rest of the rows wait for room.
    untrack(() => skip(true, fitsIn([budget.meter], 0, children - taken)))
    budgetVersion()
    return { fits: true, rows: limit }
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
  hooks?: JsonRenderHooks,
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

  const RowsContext = hooks?.RepeatRowsContext
  return function GenuiElement(props: ComponentRenderProps): JSX.Element {
    const budget = useContext(RenderBudgetContext)
    if (!budget) return renderElement(props)
    const fit = useFit(budget, props, hooks)
    const fits = createMemo(() => fit().fits)
    const rows = createMemo(() => fit().rows)
    const render = () =>
      RowsContext
        ? createComponent(RowsContext.Provider, {
            value: rows,
            get children() {
              return renderElement(props)
            },
          })
        : renderElement(props)
    return createMemo(() => (fits() ? untrack(render) : undefined)) as unknown as JSX.Element
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
 * Directives that never throw, at a bounded cost (see src/gui/directives.ts). json-render resolves them inside the
 * parent element's memo, so a directive that throws (`$format: "date"` before its value has streamed in, a bad currency
 * code, `$concat` of a non-array) blanked the parent element for good: json-render's error boundaries never reset. A
 * failing directive resolves to `undefined` instead, and resolves again when its inputs change. Errors from json-render's
 * own bounds (`expansionLimit`, `evaluationDeferred`: see patches/@json-render%2Fcore) pass through, so the prop as a
 * whole is left unresolved, or evaluated again in the next task, rather than shown half resolved.
 */
export function guardDirectives(directives: readonly DirectiveDefinition[]): DirectiveDefinition[] {
  return directives.map((standard) => {
    const directive = boundedDirective(standard)
    return {
      ...directive,
      resolve: (value, ctx) => {
        try {
          return directive.resolve(value, ctx)
        } catch (error) {
          const flags = error as { readonly expansionLimit?: unknown; readonly evaluationDeferred?: unknown } | null
          if (flags?.expansionLimit || flags?.evaluationDeferred) throw error
          return undefined
        }
      },
    }
  })
}
