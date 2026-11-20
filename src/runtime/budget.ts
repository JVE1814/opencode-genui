import { batch, createSignal, type Accessor, type Setter } from "solid-js"
import { RENDER_UNITS, SLOT_UNITS } from "../shared/constants.ts"
import { afterTask } from "./task.ts"

// How much rendering the window does: what each surface and all surfaces together may hold, and how much may start in
// one task. src/gui/element.ts charges every element here; nothing in this file knows about json-render.

/**
 * Units and child slots in use against their caps. An element that renders holds its units (one, plus its props' size,
 * see unitsOf in src/gui/element.ts) and one slot for each child renderer it builds (each child of its `children`, or
 * rows × children for a repeat): a child that does not fit is still built, to render nothing, so slots bound how many
 * renderers exist at all, not only how many show.
 */
export interface Meter {
  units: number
  slots: number
  readonly maxUnits: number
  readonly maxSlots: number
}

export const createMeter = (maxUnits: number, maxSlots: number): Meter => ({ units: 0, slots: 0, maxUnits, maxSlots })

/**
 * The window-wide pools: the agent's canvases, the agent's inline UIs, the older copies of an inline UI the agent sent
 * again with the same id, and UIs outside the agent's reply.
 */
export type PoolKind = "canvas" | "inline" | "superseded" | "untrusted"

/**
 * How many whole surfaces' worth (RENDER_UNITS and SLOT_UNITS) each pool holds for all of its surfaces together. One
 * canvas shows at a time (two with the narrow-screen view), a reply's inline UIs share three, and blocks in tool output
 * or files, which anyone can write, share one: twenty copies of a block that fills its own budget render once, not
 * twenty times, and cannot starve the agent's own UIs. Older copies of a re-sent UI share one of their own, so they
 * never take room from the newest copy, which holds the live state.
 */
export const POOL_SURFACES: Readonly<Record<PoolKind, number>> = { canvas: 2, inline: 3, superseded: 1, untrusted: 1 }

const pools = new Map<PoolKind, Meter>()

/** A window-wide pool: one per window (the module is loaded once), so no remount or second surface resets it. */
export function windowPool(kind: PoolKind): Meter {
  let pool = pools.get(kind)
  if (!pool) {
    pool = createMeter(POOL_SURFACES[kind] * RENDER_UNITS, POOL_SURFACES[kind] * SLOT_UNITS)
    pools.set(kind, pool)
  }
  return pool
}

// --- The newest inline surface ---------------------------------------------------------------------------------------

/**
 * Of the agent's inline pool, the share surfaces other than the newest may hold: all but one surface's worth. The
 * newest (the inline UI mounted last, usually the one the agent just sent, or one scrolled back into view) always has
 * that one surface's worth, which is all its own budget allows: older UIs that filled the pool first left it a part.
 * When another surface becomes the newest, the previous one's elements take their room again with this share, and what
 * no longer fits waits for freed room.
 */
const olderInline = createMeter((POOL_SURFACES.inline - 1) * RENDER_UNITS, (POOL_SURFACES.inline - 1) * SLOT_UNITS)

interface PoolMember {
  readonly newest: Accessor<boolean>
  readonly setNewest: Setter<boolean>
}

// The mounted inline surfaces in mount order; the last is the newest.
const inlineMembers: PoolMember[] = []

const crown = () => {
  const newest = inlineMembers.at(-1)
  for (const member of inlineMembers) member.setNewest(member === newest)
}

/**
 * Adds a surface to the agent's inline pool, as its newest member (see olderInline). Returns the meters its elements
 * charge (reactively: they change when it stops or starts being the newest), and the function that removes it.
 */
export function joinInlinePool(): { readonly meters: () => readonly Meter[]; readonly leave: () => void } {
  const [newest, setNewest] = createSignal(true)
  const member: PoolMember = { newest, setNewest }
  inlineMembers.push(member)
  crown()
  const shared = [windowPool("inline")] as const
  const older = [windowPool("inline"), olderInline] as const
  return {
    meters: () => (newest() ? shared : older),
    leave: () => {
      const at = inlineMembers.indexOf(member)
      if (at >= 0) inlineMembers.splice(at, 1)
      crown()
    },
  }
}

/** What an element holds while it renders, and from which meters. */
export interface Hold {
  readonly units: number
  readonly slots: number
  readonly meters: readonly Meter[]
}

/** Whether `units` and `slots` fit in every meter. */
export const fitsIn = (meters: readonly Meter[], units: number, slots: number): boolean =>
  meters.every((meter) => meter.units + units <= meter.maxUnits && meter.slots + slots <= meter.maxSlots)

export function take(meters: readonly Meter[], units: number, slots: number): Hold {
  for (const meter of meters) {
    meter.units += units
    meter.slots += slots
  }
  return { units, slots, meters }
}

/** Gives a hold back. The caller says whether that freed room (see `freed`). */
export function release(hold: Hold): void {
  for (const meter of hold.meters) {
    meter.units -= hold.units
    meter.slots -= hold.slots
  }
}

// --- Freed room -------------------------------------------------------------------------------------------------------

let version: [Accessor<undefined>, Setter<undefined>] | undefined
const versionSignal = () => (version ??= createSignal(undefined, { equals: false }))

/**
 * Read by an element that did not fit, so it tries again once room is freed anywhere in the window (another element
 * shrank or went away, here or in another surface of the same pool). Changes at most once per task.
 */
export const budgetVersion = (): undefined => versionSignal()[0]()

let bumpScheduled = false

/** Room was freed: elements waiting for room try again in a later task (once, however much was freed meanwhile). */
export function freed(): void {
  if (bumpScheduled) return
  bumpScheduled = true
  afterTask(() => {
    bumpScheduled = false
    freshSlice()
    versionSignal()[1](undefined)
  })
}

// --- One task's work --------------------------------------------------------------------------------------------------

/** How much rendering may start in one task, in units plus a quarter unit per slot (a skipped child costs little). */
export const TASK_UNITS = 1000

/** How long one task may spend starting elements, in milliseconds, whatever their units (some components cost more). */
export const TASK_MS = 100

/** What starting an element costs one task's slice. */
export const sliceCost = (units: number, slots: number): number => units + slots / 4

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now())

let slice: { spent: number; readonly start: number } | undefined

function currentSlice() {
  if (!slice) {
    const mine = { spent: 0, start: now() }
    slice = mine
    afterTask(() => {
      if (slice === mine) slice = undefined
    })
  }
  return slice
}

// Our own callbacks run in a task of their own.
function freshSlice() {
  slice = undefined
  currentSlice()
}

/**
 * Whether this task may start another element: it has started less than TASK_UNITS and spent less than TASK_MS on
 * it. One element always starts (a task that started none has spent nothing), so each task does some work.
 */
export function sliceAllows(): boolean {
  const current = currentSlice()
  return current.spent === 0 || (current.spent < TASK_UNITS && now() - current.start < TASK_MS)
}

export function spend(cost: number): void {
  if (cost > 0) currentSlice().spent += cost
}

// --- Elements waiting for a later task --------------------------------------------------------------------------------

/** An element that fits but found this task's slice spent. */
export interface Waiter {
  readonly wake: () => void
  queued: boolean
  disposed: boolean
  /**
   * What the task that deferred it lends to its mount, if anything: a runner that wakes it with that task's activation
   * in place (see `lendActivation` in src/gui/outward.ts), so a later task mounts it as the activation would have.
   */
  around?: ((run: () => void) => void) | undefined
}

/**
 * How many waiters wake together, in one Solid batch: a parent re-reads its whole list of children each time one of
 * them starts rendering, so waking 2,000 siblings one at a time cost 2,000 passes over 2,000 children.
 */
const WAKE_CHUNK = 32

let queue: Waiter[] = []
let head = 0
let resumeScheduled = false
let told = false
// While a chunk wakes: its waiters that find the slice spent again keep their place at the front.
let waking: Set<Waiter> | undefined
let carried: Waiter[] = []

/**
 * Puts an element at the end of the window's queue: a later task wakes waiters in order, as far as its slice goes, and
 * the window answers input in between. The first deferral of a burst is logged.
 */
export function defer(waiter: Waiter): void {
  if (waiter.queued || waiter.disposed) return
  waiter.queued = true
  if (waking?.has(waiter)) carried.push(waiter)
  else queue.push(waiter)
  if (!told) {
    told = true
    console.info(
      `genui: rendering more than ${TASK_UNITS} units or ${TASK_MS} ms in one task; the rest renders in the next tasks`,
    )
  }
  if (!resumeScheduled) {
    resumeScheduled = true
    afterTask(resume)
  }
}

function resume() {
  resumeScheduled = false
  freshSlice()
  carried = []
  while (head < queue.length && sliceAllows() && carried.length === 0) {
    // A chunk is waiters in a row that their tasks lent the same thing (or nothing): each wakes with only its own.
    const around = queue[head]!.around
    let end = head + 1
    while (end < queue.length && end - head < WAKE_CHUNK && queue[end]!.around === around) end++
    const chunk = queue.slice(head, end)
    head = end
    waking = new Set(chunk)
    const run = () =>
      batch(() => {
        for (const waiter of chunk) {
          waiter.queued = false
          if (!waiter.disposed) waiter.wake()
        }
      })
    try {
      if (around) around(run)
      else run()
    } finally {
      waking = undefined
    }
  }
  queue = [...carried, ...queue.slice(head)]
  carried = []
  head = 0
  if (queue.length === 0) {
    told = false
    return
  }
  if (!resumeScheduled) {
    resumeScheduled = true
    afterTask(resume)
  }
}

/** How many elements wait for a later task (for tests). */
export const waiting = (): number => queue.length - head
