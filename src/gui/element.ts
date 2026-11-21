import {
  createComponent,
  createComputed,
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
import * as core from "@json-render/core"
import { getByPath, resolveRepeatStatePath, type DirectiveDefinition } from "@json-render/core"
import type { BaseComponentProps, ComponentRegistry, ComponentRenderProps } from "@json-render/solid"
import {
  budgetVersion,
  createMeter,
  defer,
  fitsIn,
  freed,
  keep,
  keptFreed,
  keptRoom,
  keptVersionRead,
  release,
  sliceAllows,
  sliceCost,
  spend,
  take,
  type Hold,
  type Meter,
  type Waiter,
} from "../runtime/budget.ts"
import { MAX_DEPTH, MAX_REPEAT_ROWS, RENDER_UNITS, SLOT_UNITS, TEXT_PER_UNIT } from "../shared/constants.ts"
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
 * The spec's elements as written, before json-render resolves them for each instance: a parent charges its child
 * renderers by them (see `childSlots`). Each surface provides it (src/gui/surface.tsx); without it, a child takes one
 * slot.
 */
export const SpecElementsContext = createContext<Accessor<Readonly<Record<string, unknown>> | undefined>>()

// The text bounds of object values, by identity (see `textBound`).
const texts = new WeakMap<object, number>()

// "[object Object]", what String() makes of an object.
const OBJECT_TEXT = 15

/**
 * At most how many characters of text a value, or any value inside it, turns into as json-render's core builds text (a
 * list joined with commas, an object as "[object Object]", a number as its digits), up to just past SIZE_LIMIT; walked
 * once per object, as `sizeOf` is.
 */
export function textBound(value: unknown): number {
  if (typeof value === "string") return value.length
  if (value === null || value === undefined) return 0
  if (typeof value !== "object") return String(value).length
  const known = texts.get(value)
  if (known !== undefined) return known
  let size = 0
  const stack: unknown[] = [value]
  while (stack.length > 0 && size <= SIZE_LIMIT) {
    const next = stack.pop()
    if (typeof next === "string") size += next.length
    else if (next === null || next === undefined) continue
    else if (typeof next !== "object") size += String(next).length
    else {
      const remembered = next === value ? undefined : texts.get(next)
      if (remembered !== undefined) {
        size += remembered
        continue
      }
      if (Array.isArray(next)) {
        size += next.length
        for (const item of next) stack.push(item)
      } else {
        size += OBJECT_TEXT
        for (const key in next) if (Object.hasOwn(next, key)) stack.push((next as Record<string, unknown>)[key])
      }
    }
  }
  const result = Math.min(size, SIZE_LIMIT + 1)
  texts.set(value, result)
  return result
}

/**
 * What one expression that builds a text ($template, $concat, $join, $truncate) reads, linear in what it reads, so an
 * upper bound: each state path read (a template's absolute reference, and the state path a relative one falls back to;
 * a `$state` part), each path read in the repeat item (a relative reference, an `$item` part), each with how many times
 * its text is copied (a $join's list once per character of its separator besides), and the characters copied that are
 * not written in the element (separators, a `$truncate` length). `sure` holds the state paths it copies whatever else
 * happens (a template's absolute references, the `$state` parts of a $concat): the text of what they read now is a
 * lower bound of what it builds.
 */
interface BuildPlan {
  readonly extra: number
  readonly state: ReadonlyMap<string, number>
  /** The item paths read: of a child's expressions, the first MAX_ITEM_PATHS distinct ones; `more` counts the rest. */
  readonly item: ReadonlyMap<string, number>
  readonly more: number
  readonly sure: ReadonlyMap<string, number>
}

/**
 * A child's expressions that build texts, by the prop they are in. An expression found only inside a directive or a
 * condition may not be evaluated at all (`certain` false).
 */
type ChildPlan = ReadonlyArray<ReadonlyArray<{ readonly plan: BuildPlan; readonly certain: boolean }>>

/** How many distinct item paths of one child are read one by one (the rest count as the whole item; see BuildPlan). */
export const MAX_ITEM_PATHS = 64

const NO_PLAN: ChildPlan = Object.freeze([])
const plans = new WeakMap<object, ChildPlan>()
const BUILDS = ["$template", "$concat", "$join", "$truncate"] as const
const TEMPLATE_REF = /\$\{([^}]+)\}/g
const isBuilder = (value: object): boolean => BUILDS.some((key) => Object.hasOwn(value, key))

/** The plan of one building expression (see BuildPlan); `items` is shared by the child's expressions. */
function expressionPlan(expression: Readonly<Record<string, unknown>>, items: { paths: Set<string> }): BuildPlan {
  let extra = 0
  let more = 0
  const state = new Map<string, number>()
  const item = new Map<string, number>()
  const sure = new Map<string, number>()
  const add = (map: Map<string, number>, path: string, copies: number) => map.set(path, (map.get(path) ?? 0) + copies)
  const readItem = (path: string, copies: number) => {
    if (items.paths.has(path) || items.paths.size < MAX_ITEM_PATHS) {
      items.paths.add(path)
      add(item, path, copies)
    } else more += copies
  }
  const template = (text: string, copies: number, certain: boolean) => {
    for (const [, ref] of text.matchAll(TEMPLATE_REF)) {
      if (ref!.startsWith("/")) {
        add(state, ref!, copies)
        if (certain) add(sure, ref!, copies)
      } else {
        readItem(ref!, copies)
        add(state, `/${ref}`, copies)
      }
    }
  }
  // Values to look through, inside the expression: every value read is copied into its text.
  const stack: Array<readonly [unknown, number]> = []
  if (typeof expression.$template === "string") template(expression.$template, 1, true)
  else if (Array.isArray(expression.$concat)) {
    for (const part of expression.$concat) {
      const raw = part as Readonly<Record<string, unknown>> | null
      if (raw && typeof raw === "object" && typeof raw.$state === "string") {
        add(state, raw.$state, 1)
        add(sure, raw.$state, 1)
      } else if (raw && typeof raw === "object" && typeof raw.$template === "string") template(raw.$template, 1, true)
      else stack.push([part, 1])
    }
  } else stack.push([expression, 1])
  let visited = 0
  while (stack.length > 0 && visited++ <= SIZE_LIMIT) {
    const [value, copies] = stack.pop()!
    if (value === null || typeof value !== "object") {
      if (typeof value === "number") extra += copies * String(value).length
      continue
    }
    if (Array.isArray(value)) {
      extra += copies * value.length
      for (const entry of value) stack.push([entry, copies])
      continue
    }
    const raw = value as Readonly<Record<string, unknown>>
    if (typeof raw.$template === "string") template(raw.$template, copies, false)
    else if (Array.isArray(raw.$concat)) {
      for (const part of raw.$concat) stack.push([part, copies])
    } else if (Object.hasOwn(raw, "$join")) {
      const separator = typeof raw.separator === "string" ? raw.separator.length : 2
      stack.push([raw.$join, copies * (1 + separator)])
    } else if (Object.hasOwn(raw, "$truncate")) {
      const length = raw.length
      if (typeof length === "number" && length >= 0 && length <= 1024) extra += copies * (length + 3)
      else stack.push([raw.$truncate, copies])
      if (raw.suffix !== undefined) stack.push([raw.suffix, copies])
    } else if (typeof raw.$state === "string") add(state, raw.$state, copies)
    else if (typeof raw.$bindState === "string") add(state, raw.$bindState, copies)
    else if (typeof raw.$item === "string") readItem(raw.$item, copies)
    else if (typeof raw.$bindItem === "string") readItem(raw.$bindItem, copies)
    else if (Object.hasOwn(raw, "$cond")) {
      stack.push([raw.$then, copies])
      stack.push([raw.$else, copies])
    } else if (Object.keys(raw).some((key) => key.charCodeAt(0) === 36)) {
      // Another directive ($format, $math, $count, $pluralize): its text is about as long as it is written.
      extra += copies * 32
      for (const entry of Object.values(raw)) stack.push([entry, copies])
    } else extra += copies * OBJECT_TEXT
  }
  return { extra, state, item, more, sure }
}

/** The plan of a child's props (see ChildPlan), worked out once per props object (spec values never change in place). */
function planOf(props: object): ChildPlan {
  const known = plans.get(props)
  if (known) return known
  const items = { paths: new Set<string>() }
  const found: Array<Array<{ readonly plan: BuildPlan; readonly certain: boolean }>> = []
  for (const value of Object.values(props)) {
    const expressions: Array<{ readonly plan: BuildPlan; readonly certain: boolean }> = []
    // [value, reached through plain lists and objects only]
    const stack: Array<readonly [unknown, boolean]> = [[value, true]]
    let visited = 0
    while (stack.length > 0 && visited++ <= SIZE_LIMIT) {
      const [next, certain] = stack.pop()!
      if (!next || typeof next !== "object") continue
      if (!Array.isArray(next) && isBuilder(next)) {
        expressions.push({ plan: expressionPlan(next as Record<string, unknown>, items), certain })
        continue
      }
      const plain = Array.isArray(next) || !Object.keys(next).some((key) => key.charCodeAt(0) === 36)
      for (const entry of Array.isArray(next) ? next : Object.values(next))
        if (entry && typeof entry === "object") stack.push([entry, certain && plain])
    }
    if (expressions.length > 0) found.push(expressions)
  }
  const plan = found.length === 0 ? NO_PLAN : found
  plans.set(props, plan)
  return plan
}

/**
 * What an element's children read as json-render resolves them (see `childSlots`): the state, and the text bound (see
 * `textBound`) of what a path reads in the repeat item of the row they render in, or of the whole item (`wholeItem`).
 * For the rows of a repeat these are averages over the rows' items, so the rows together are charged what they read.
 * Each is read only when a child's expressions need it, so an element whose children build nothing does not follow the
 * state.
 */
export interface ChildReads {
  readonly state: () => unknown
  readonly itemText: (path: string) => number
  readonly wholeItem: () => number
}

// What a plan's state paths read (`upper`), and the exact text of its sure ones (`lower`), for the last state it was
// worked out for (shared by every instance of the child).
const stateReads = new WeakMap<BuildPlan, { readonly state: unknown; readonly upper: number; readonly lower: number }>()

// The exact length of the text json-render's core makes of a value it copies, where that is known without a walk.
const exactText = (value: unknown): number =>
  typeof value === "string" ? value.length : typeof value === "number" ? String(value).length : 0

function stateReadsOf(plan: BuildPlan, reads: ChildReads): { readonly upper: number; readonly lower: number } {
  if (plan.state.size === 0) return { upper: 0, lower: 0 }
  const state = reads.state()
  const known = stateReads.get(plan)
  if (known && known.state === state) return known
  let upper = 0
  for (const [path, copies] of plan.state) {
    if (upper > SIZE_LIMIT) break
    upper += copies * textBound(getByPath(state as Record<string, unknown>, path))
  }
  let lower = 0
  for (const [path, copies] of plan.sure) {
    if (lower > MAX_EXPANSION) break
    lower += copies * exactText(getByPath(state as Record<string, unknown>, path))
  }
  const result = { state, upper, lower }
  stateReads.set(plan, result)
  return result
}

/** The most characters one expression builds (json-render's core: see MAX_EXPANSION in patches/@json-render%2Fcore). */
export const MAX_EXPANSION = 1_000_000

/**
 * At most how many characters the expressions in an element's props build and keep once json-render resolves them
 * ($template, $concat, $join and $truncate copy what they read into a text of their own), from what they read now (see
 * BuildPlan), up to just past SIZE_LIMIT. Each expression keeps at most MAX_EXPANSION; one that surely builds more is
 * left empty by json-render's core, with the rest of its prop, and keeps nothing.
 */
export function builtOf(element: unknown, reads: ChildReads): number {
  const props = (element as { readonly props?: unknown } | null)?.props
  if (!props || typeof props !== "object") return 0
  const plan = planOf(props)
  let size = 0
  for (const expressions of plan) {
    if (size > SIZE_LIMIT) break
    let prop = 0
    for (const { plan: expression, certain } of expressions) {
      const { upper, lower } = stateReadsOf(expression, reads)
      if (certain && lower > MAX_EXPANSION) {
        prop = 0
        break
      }
      let built = expression.extra + upper
      for (const [path, copies] of expression.item) {
        if (built > MAX_EXPANSION) break
        built += copies * reads.itemText(path)
      }
      if (expression.more > 0 && built <= MAX_EXPANSION) built += expression.more * reads.wholeItem()
      prop += Math.min(built, MAX_EXPANSION)
    }
    size += prop
  }
  return Math.min(size, SIZE_LIMIT + 1)
}

/**
 * The slots one child renderer of an element takes (see SLOT_UNITS): one, plus one for every TEXT_PER_UNIT characters
 * of the child's element as written (see `sizeOf`) and of what its expressions build from what they read now (see
 * `builtOf`, given `reads`). json-render resolves an instance's props into values of its own, and keeps them, before
 * the instance can tell whether it fits: 4,000 entries of a child whose prop held a list of 40,000 numbers and one
 * expression kept 700 MB, and 2,000 rows of it 360 MB; 2,000 rows of a Text of 80 characters whose templates read a
 * text of 90,000 characters 44 times would build 8 billion. Charged at the parent, such a child is refused before
 * json-render builds it (and what instances keep is bounded besides: see createKeptLedger).
 */
export function childSlots(element: unknown, reads?: ChildReads): number {
  const built = reads ? builtOf(element, reads) : 0
  return 1 + Math.floor(Math.min(sizeOf(element) + built, SIZE_LIMIT + 1) / TEXT_PER_UNIT)
}

/**
 * The slots of one entry of each of an element's `children` together (see `childSlots`; `slotOf` gives a child key's),
 * or 1 for none: what one row of a repeat takes. Counted only to just past what a surface holds.
 */
export function rowSlots(
  element: { readonly children?: unknown } | undefined,
  slotOf: (key: unknown) => number = () => 1,
): number {
  const children = Array.isArray(element?.children) ? element.children : []
  let slots = 0
  for (let index = 0; index < children.length && slots <= SLOT_UNITS; index++) slots += slotOf(children[index])
  return Math.max(1, Math.min(slots, SLOT_UNITS + 1))
}

/**
 * How many slots an element's child renderers take once it renders (see SLOT_UNITS and `childSlots`): those of each
 * entry of its `children`, or, for a repeat, those of one row (see `rowSlots`) for each of its rows, whether each child
 * then fits or not.
 */
export function slotsOf(
  element: { readonly children?: unknown; readonly repeat?: unknown } | undefined,
  rows: number,
  slotOf: (key: unknown) => number = () => 1,
) {
  if (element?.repeat) return Math.min(rows, MAX_REPEAT_ROWS) * rowSlots(element, slotOf)
  return Array.isArray(element?.children) && element.children.length > 0 ? rowSlots(element, slotOf) : 0
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
  /** How many mounted elements render nothing because they nest deeper than MAX_DEPTH. */
  readonly tooDeep: Accessor<number>
  readonly setTooDeep: (update: (count: number) => number) => void
  /** The errors of mounted elements that could not render (see RenderErrors in src/gui/registry.tsx), oldest first. */
  readonly failed: Accessor<readonly string[]>
  readonly setFailed: (update: (errors: readonly string[]) => readonly string[]) => void
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
  const [tooDeep, setTooDeep] = createSignal(0)
  const [failed, setFailed] = createSignal<readonly string[]>([])
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
    tooDeep,
    setTooDeep,
    failed,
    setFailed,
  }
}

/** The surface's render budget (none outside a surface: unit tests render without a limit unless they provide one). */
export const RenderBudgetContext = createContext<RenderBudget>()

// --- What rendered elements keep --------------------------------------------------------------------------------------

/** What one element instance keeps of its resolved props (see KeptLedger), and the render meters it is charged to. */
export interface KeptHold {
  readonly size: number
  meters: readonly Meter[]
  /** A prop was left empty for want of room. */
  readonly cut: boolean
  /** The ledger took the hold back (its surface's pools changed and it no longer fit); its instance evaluates again. */
  evicted: boolean
  readonly keeper: { readonly wake: () => void }
  readonly withdraw: (() => void) | undefined
}

/** What an evaluation kept (see `keep` in patches/@json-render%2Fcore's withEvaluation). */
export interface Kept {
  readonly kept: number
  readonly cut: boolean
}

/**
 * The ledger json-render's renderer charges what each element instance keeps of its resolved props to (KeptValuesContext
 * in patches/@json-render%2Fsolid). json-render resolves the props of every instance (each row of a repeat, each entry
 * of a parent's children) and keeps them for as long as the instance lives, rendered or not; the bounds on what
 * expressions build per task (4 million characters) let 2,000 rows build and keep 4 million more every task until the
 * window ran out of memory. An instance evaluates its props with the room the ledger gives it (`room`), the evaluation
 * stops there and leaves the prop that would pass it empty, and the instance holds what it kept (`take`) until it
 * evaluates again or goes (`release`).
 */
export interface KeptLedger {
  readonly room: (hold: KeptHold | undefined) => number
  readonly take: (
    previous: KeptHold | undefined,
    kept: Kept,
    keeper: { readonly wake: () => void },
    elementKey?: string,
  ) => KeptHold
  readonly release: (hold: KeptHold) => void
}

const NO_METERS: readonly Meter[] = Object.freeze([])

/**
 * A surface's KeptLedger, charged to the kept meters (see keptMeter in src/runtime/budget.ts) of the same meters as its
 * render budget: the surface's own (KEPT_PER_SURFACE) and its kind's window-wide pool, of which the agent's newest
 * inline UI keeps a share of its own as it does for rendering (see joinInlinePool). A remount or a second surface
 * charges the same pools, and gives back what its instances held as they go. When the surface's pools change (it stops
 * or starts being the newest inline UI), its holds take their room again, oldest first; an instance whose hold no longer
 * fits is evaluated again with the room left. An instance that left a prop empty is evaluated again once room is
 * freed anywhere in the window (at most once per task), and `onCut` reports it while it holds such a hold (`pooled`:
 * the room went to other surfaces of its pool). Call it under an owner (it follows the pools reactively).
 */
export function createKeptLedger(
  budget: Pick<RenderBudget, "meter" | "pool">,
  onCut?: (pooled: boolean, elementKey: string | undefined) => (() => void) | undefined,
): KeptLedger {
  const meters = (): readonly Meter[] => {
    const pool = budget.pool?.()
    return pool === undefined ? [budget.meter] : [budget.meter, ...(Array.isArray(pool) ? pool : [pool as Meter])]
  }
  // In the order they were taken.
  const holds = new Set<KeptHold>()
  let current = untrack(meters)
  createComputed(() => {
    const next = meters()
    if (next.length === current.length && next.every((meter, index) => meter === current[index])) return
    current = next
    untrack(() => {
      const order = [...holds]
      for (const hold of order) keep(hold.meters, -hold.size)
      for (const hold of order) {
        if (keptRoom(next) >= hold.size) {
          keep(next, hold.size)
          hold.meters = next
        } else {
          hold.meters = NO_METERS
          hold.evicted = true
          hold.keeper.wake()
        }
      }
      keptFreed()
    })
  })
  const drop = (hold: KeptHold): boolean => {
    if (!holds.delete(hold)) return false
    keep(hold.meters, -hold.size)
    return true
  }
  return {
    room: (hold) => {
      // An instance that left a prop empty tries again once room is freed.
      if (hold?.cut) keptVersionRead()
      return keptRoom(current, hold)
    },
    take: (previous, kept, keeper, elementKey) => {
      const size = Math.max(0, kept.kept)
      const pooled = kept.cut && keptRoom([budget.meter], previous) > keptRoom(current, previous)
      const freedBefore = previous !== undefined && !previous.evicted && previous.meters.length > 0
      if (previous) drop(previous)
      keep(current, size)
      const withdraw = kept.cut ? onCut?.(pooled, elementKey) : undefined
      // After the new report, so an issue that stays is not withdrawn in between.
      previous?.withdraw?.()
      const hold: KeptHold = { size, meters: current, cut: kept.cut, evicted: false, keeper, withdraw }
      holds.add(hold)
      if (freedBefore && size < previous.size && !kept.cut) keptFreed()
      if (kept.cut) keptVersionRead()
      return hold
    },
    release: (hold) => {
      if (!drop(hold)) return
      hold.withdraw?.()
      if (hold.size > 0 && hold.meters.length > 0) keptFreed()
    },
  }
}

export { MAX_DEPTH }

// How deep the element being rendered is (see MAX_DEPTH).
const DepthContext = createContext(0)

/**
 * json-render's hooks for the state and repeat scope an element renders in, so a repeat's rows are known before they
 * are built. Passed in (src/gui/registry.tsx) rather than imported: @json-render/solid needs a DOM when it loads, and
 * this file loads without one in unit tests. Without them, a repeat's rows are not counted in its slots.
 */
export interface JsonRenderHooks {
  readonly useStateStore: () => { readonly state: unknown }
  readonly useRepeatScope: () => { readonly basePath: string; readonly item?: unknown } | null
  /**
   * Where an element tells json-render's repeat how many of its rows to render (patches/@json-render%2Fsolid): those
   * that fit in the render budget. Without it, a repeat whose rows do not all fit renders none.
   */
  readonly RepeatRowsContext?: Context<Accessor<number | undefined> | undefined>
}

// The average text bound of what a path reads in a list's items, over the first MAX_REPEAT_ROWS (the rows a repeat may
// render), by list and path; at most MAX_AVERAGED_PATHS paths per list, the rest bounded by the whole items' average.
const averages = new WeakMap<readonly unknown[], Map<string, number>>()
const MAX_AVERAGED_PATHS = 64

function averageText(list: readonly unknown[], path: string | undefined): number {
  const rows = Math.min(list.length, MAX_REPEAT_ROWS)
  if (rows === 0) return 0
  let known = averages.get(list)
  if (!known) averages.set(list, (known = new Map()))
  const key = path ?? "\u0000"
  let average = known.get(key)
  if (average !== undefined) return average
  if (path !== undefined && known.size >= MAX_AVERAGED_PATHS) return averageText(list, undefined)
  let total = 0
  for (let index = 0; index < rows && total <= SIZE_LIMIT; index++)
    total += textBound(path === undefined ? list[index] : getByPath(list[index] as Record<string, unknown>, path))
  average = Math.ceil(total / rows)
  known.set(key, average)
  return average
}

/**
 * What the element reads of the state and its repeat scope, as json-render reads them: how many rows its repeat has (0
 * for an element without one), and what its children read (see ChildReads; none without the state store): for the
 * rows of its repeat, averages over the items of the rows it may render; otherwise the item of the row it renders in
 * itself (nothing outside a repeat).
 */
function useReads(
  props: ComponentRenderProps,
  hooks: JsonRenderHooks | undefined,
): { readonly rows: Accessor<number>; readonly reads: Accessor<ChildReads | undefined> } {
  let store: { readonly state: unknown } | undefined
  try {
    store = hooks?.useStateStore()
  } catch {
    store = undefined
  }
  const scope = hooks?.useRepeatScope()
  const list = (): readonly unknown[] | undefined => {
    const repeat = props.element?.repeat
    if (!repeat || !store) return undefined
    const path = resolveRepeatStatePath(repeat.statePath, scope?.basePath)
    if (path === undefined) return undefined
    const found = getByPath(store.state as Record<string, unknown>, path)
    return Array.isArray(found) ? found : undefined
  }
  const rows = () => list()?.length ?? 0
  const reads = (): ChildReads | undefined => {
    if (!store) return undefined
    const from = store
    const state = () => from.state
    if (props.element?.repeat) {
      const items = list() ?? []
      return { state, itemText: (path) => averageText(items, path), wholeItem: () => averageText(items, undefined) }
    }
    return {
      state,
      itemText: (path) =>
        textBound(path === "" ? scope?.item : getByPath(scope?.item as Record<string, unknown>, path)),
      wholeItem: () => textBound(scope?.item),
    }
  }
  return { rows, reads }
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
  const { rows, reads } = useReads(props, hooks)
  const elements = useContext(SpecElementsContext)
  // A child's slots, with what its expressions build from what they read now (see childSlots).
  const slotOf = () => {
    const now = reads()
    return (key: unknown) => {
      const child = typeof key === "string" ? elements?.()?.[key] : undefined
      return child === undefined ? 1 : childSlots(child, now)
    }
  }
  const units = createMemo(() => elementUnits(props.element))
  // The slots one row of the element's repeat takes, or 0 without a repeat.
  const perRow = createMemo(() => (props.element?.repeat ? rowSlots(props.element, slotOf()) : 0))
  const slots = createMemo(() =>
    props.element?.repeat ? Math.min(rows(), MAX_REPEAT_ROWS) * perRow() : slotsOf(props.element, rows(), slotOf()),
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

  // The element's children render one level deeper.
  const nested = (depth: number, render: () => JSX.Element): JSX.Element =>
    createComponent(DepthContext.Provider, {
      value: depth,
      get children() {
        return render()
      },
    })

  const RowsContext = hooks?.RepeatRowsContext
  return function GenuiElement(props: ComponentRenderProps): JSX.Element {
    const budget = useContext(RenderBudgetContext)
    const depth = useContext(DepthContext) + 1
    if (depth > MAX_DEPTH) {
      if (budget) {
        budget.setTooDeep((count) => count + 1)
        onCleanup(() => budget.setTooDeep((count) => count - 1))
      }
      return undefined
    }
    if (!budget) return nested(depth, () => renderElement(props))
    const fit = useFit(budget, props, hooks)
    const fits = createMemo(() => fit().fits)
    const rows = createMemo(() => fit().rows)
    const render = () =>
      nested(depth, () =>
        RowsContext
          ? createComponent(RowsContext.Provider, {
              value: rows,
              get children() {
                return renderElement(props)
              },
            })
          : renderElement(props),
      )
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
        let result: unknown
        try {
          result = directive.resolve(value, ctx)
        } catch (error) {
          const flags = error as { readonly expansionLimit?: unknown; readonly evaluationDeferred?: unknown } | null
          if (flags?.expansionLimit || flags?.evaluationDeferred) throw error
          return undefined
        }
        // The text it returns is kept by the element (see createKeptLedger), counted whole even when it is a text of the
        // state passed through; one that does not fit leaves the prop empty.
        if (typeof result === "string") chargeKept(result.length)
        return result
      },
    }
  })
}

// Counts what an evaluation keeps (patches/@json-render%2Fcore); without the patch, nothing.
const chargeKept = (core as unknown as { readonly chargeKept?: (size: number) => void }).chargeKept ?? (() => {})
