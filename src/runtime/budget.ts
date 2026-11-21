import { batch, createMemo, createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { RENDER_UNITS, SLOT_UNITS, TEXT_PER_UNIT } from "../shared/constants.ts"
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
  readonly setNewest: Setter<boolean>
  previous: PoolMember | undefined
  next: PoolMember | undefined
  joined: boolean
}

// The mounted inline surfaces in mount order, as a list linked both ways: the last is the newest. Joining and leaving
// touch only the member and its neighbours, and change the newest flag of at most two members: a message of 1,700
// small blocks set every member's flag each time one joined (1,700² writes).
let newestMember: PoolMember | undefined

/**
 * Adds a surface to the agent's inline pool, as its newest member (see olderInline). Returns the meters its elements
 * charge (reactively: they change when it stops or starts being the newest), and the function that removes it.
 */
export function joinInlinePool(): { readonly meters: () => readonly Meter[]; readonly leave: () => void } {
  const [newest, setNewest] = createSignal(true)
  const member: PoolMember = { setNewest, previous: newestMember, next: undefined, joined: true }
  if (newestMember) {
    newestMember.next = member
    newestMember.setNewest(false)
  }
  newestMember = member
  const shared = [windowPool("inline")] as const
  const older = [windowPool("inline"), olderInline] as const
  return {
    meters: () => (newest() ? shared : older),
    leave: () => {
      if (!member.joined) return
      member.joined = false
      const { previous, next } = member
      if (previous) previous.next = next
      if (next) next.previous = previous
      member.previous = member.next = undefined
      if (newestMember !== member) return
      newestMember = previous
      previous?.setNewest(true)
    },
  }
}

/** How many surfaces are in the agent's inline pool (for tests). */
export function inlineMembers(): number {
  let count = 0
  for (let member = newestMember; member; member = member.previous) count++
  return count
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

let slice: { spent: number; readonly start: number; ours: boolean } | undefined

function currentSlice() {
  if (!slice) {
    const mine = { spent: 0, start: now(), ours: false }
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
  currentSlice().ours = true
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
 * them starts rendering, so waking 2,000 siblings one at a time cost 2,000 passes over 2,000 children. Each still
 * checks the slice as it wakes (a surface's mount runs before the next one checks: see `sliceMount`).
 */
const WAKE_CHUNK = 32

let queue: Waiter[] = []
let head = 0
let resumeScheduled = false
let told = false
// While a chunk wakes: what finds the slice spent again keeps its place at the front (see `defer`).
let waking = false
let carried: Waiter[] = []

/**
 * Puts an element at the end of the window's queue: a later task wakes waiters in order, as far as its slice goes, and
 * the window answers input in between. The first deferral of a burst is logged.
 */
export function defer(waiter: Waiter): void {
  if (waiter.queued || waiter.disposed) return
  waiter.queued = true
  // While a chunk wakes, whatever finds the slice spent (one of the chunk, or what a woken surface or element starts)
  // goes before the rest of the queue: the window fills in in order, and a surface that mounted in this task shows
  // its elements in the next one rather than after every surface queued behind it.
  if (waking) carried.push(waiter)
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
    waking = true
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
      waking = false
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

/** How many elements and surfaces wait for a later task (for tests). */
export const waiting = (): number => queue.length - head

// --- Surfaces mounting in a later task -------------------------------------------------------------------------------

/**
 * What mounting one surface costs a task's slice, besides its elements (which charge their own): json-render's
 * providers, genui's chrome, and the issues panel or error card, about as much as ten small elements. A canvas chip
 * costs half of it (see CHIP_UNITS in src/gui/inline.tsx). A message of 1,700 small blocks mounted every surface in one
 * task (2 s); a slice now mounts at most a hundred, and the rest wait, in order, for the next tasks.
 */
export const MOUNT_UNITS = 10

/** Compiling a block costs one more unit for every MOUNT_TEXT_PER_UNIT characters of it (about 0.1 ms each). */
export const MOUNT_TEXT_PER_UNIT = TEXT_PER_UNIT

/** What mounting the surface of a block of `length` characters costs a task's slice (see MOUNT_UNITS). */
export const mountUnits = (length: number): number => MOUNT_UNITS + Math.floor(length / MOUNT_TEXT_PER_UNIT)

/**
 * How long a task that is not one of the window's own (see `freshSlice`) may spend mounting surfaces: half of TASK_MS.
 * Such a task is the app's (a message arriving, a session shown again): it rendered its Markdown before it asked for
 * the first surface, which the slice does not see (150 to 200 ms of code blocks for a message of 1,700 small blocks).
 * The window's own tasks, where the rest mounts, hold nothing else.
 */
export const HOST_MOUNT_MS = TASK_MS / 2

/** Whether this task may mount another surface: as `sliceAllows`, within HOST_MOUNT_MS in a task of the app's. */
function mountAllows(): boolean {
  const current = currentSlice()
  if (current.spent === 0) return true
  return current.spent < TASK_UNITS && now() - current.start < (current.ours ? TASK_MS : HOST_MOUNT_MS)
}

/**
 * Whether a surface (or a chip) mounts now: in a task whose slice has room (see `mountAllows`), it charges `cost` and
 * turns true for good. Otherwise it waits in the window's queue, in order with the elements waiting there, and a later
 * task mounts it; meanwhile the caller shows a light placeholder. Call it in the component that mounts the surface: it
 * stops waiting when that component goes away.
 */
export function sliceMount(cost: number): Accessor<boolean> {
  const [woken, setWoken] = createSignal(undefined, { equals: false })
  const waiter: Waiter = { wake: () => setWoken(undefined), queued: false, disposed: false }
  onCleanup(() => {
    waiter.disposed = true
  })
  let mounted = false
  return createMemo(() => {
    woken()
    if (mounted) return true
    if (!mountAllows()) {
      defer(waiter)
      return false
    }
    spend(cost)
    mounted = true
    return true
  })
}

// --- What rendered elements keep --------------------------------------------------------------------------------------

/**
 * How many characters the values an element's expressions built may hold, per surface's worth of a render meter (see
 * createKeptLedger in src/gui/element.ts). json-render keeps every instance's resolved props (each row of a repeat, each
 * entry of a parent's children) for as long as the instance lives, rendered or not, so the bounds on what expressions
 * build per task did not bound what the window held: 2,000 rows that each built 4 million characters, a task at a time,
 * crashed it out of memory. Four times what a surface shows (RENDER_UNITS × TEXT_PER_UNIT), so what renders fits.
 */
export const KEPT_PER_SURFACE = 2_000_000

/** What the elements charged to a render meter keep (characters, and one per entry of a list or object), and its cap. */
export interface KeptMeter {
  used: number
  readonly max: number
}

const keptMeters = new WeakMap<Meter, KeptMeter>()

/**
 * The kept meter of a render meter, with KEPT_PER_SURFACE for each RENDER_UNITS of its units: one per meter, so what is
 * kept is bounded by the same pools (window-wide, and the newest inline UI's share) as what renders.
 */
export function keptMeter(meter: Meter): KeptMeter {
  let kept = keptMeters.get(meter)
  if (!kept) {
    kept = { used: 0, max: Math.floor((meter.maxUnits / RENDER_UNITS) * KEPT_PER_SURFACE) }
    keptMeters.set(meter, kept)
  }
  return kept
}

/**
 * How much more every one of `meters` may keep, counting `credit` (a hold about to be replaced) as free in the meters it
 * is held in.
 */
export function keptRoom(
  meters: readonly Meter[],
  credit?: { readonly size: number; readonly meters: readonly Meter[] },
): number {
  let room = Infinity
  for (const meter of meters) {
    const kept = keptMeter(meter)
    room = Math.min(room, kept.max - kept.used + (credit?.meters.includes(meter) ? credit.size : 0))
  }
  return room === Infinity ? 0 : Math.max(0, room)
}

/** Charges `size` to the kept meters of `meters` (`size` may be negative, to give it back). */
export function keep(meters: readonly Meter[], size: number): void {
  for (const meter of meters) keptMeter(meter).used += size
}

let keptVersion: [Accessor<undefined>, Setter<undefined>] | undefined
const keptSignal = () => (keptVersion ??= createSignal(undefined, { equals: false }))

/**
 * Read by an element that left props empty for want of room to keep them, so it evaluates them again once room is freed
 * anywhere in the window. Changes at most once per task.
 */
export const keptVersionRead = (): undefined => keptSignal()[0]()

let keptBumpScheduled = false

/** Room to keep values was freed: elements that left props empty try again in a later task. */
export function keptFreed(): void {
  if (keptBumpScheduled) return
  keptBumpScheduled = true
  afterTask(() => {
    keptBumpScheduled = false
    keptSignal()[1](undefined)
  })
}
