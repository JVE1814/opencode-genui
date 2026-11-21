import type { StateModel, StateStore } from "@json-render/core"
import { jsonEqual } from "../protocol/fold.ts"
import { applyPatch, getAt, parsePointer, replaceAll } from "../protocol/patch.ts"
import { UI_SECRET_ROOT } from "../shared/constants.ts"
import type { ItemKey } from "./item-keys.ts"
import { MAX_ENTRY_BYTES, utf8Length } from "./snapshot.ts"
import { afterTask } from "./task.ts"

/**
 * One persisted user edit: its path, its value and, when known, the agent's value at that path when the user made it
 * (`b`, absent for none) and the array items its path goes through (`i`, see `Level`). Entries without the third member
 * (or with `u`) did not know the agent's value. When the stored edits are of more than one user action, the first edit
 * of each run of one action's edits records the number of its action among them (`a`), and the edits after it, up to
 * the next that records one, are of the same action. (An earlier version recorded it on every edit.)
 */
export type OverrideEntry =
  | readonly [path: string, value: unknown]
  | readonly [
      path: string,
      value: unknown,
      against: { readonly b?: unknown; readonly i?: readonly StoredLevel[]; readonly a?: number; readonly u?: 1 },
    ]

/** A `Level` as stored: the item's depth in the path, the agent's item, and the array's length. */
type StoredLevel = readonly [depth: number, item: unknown, length: number]

/**
 * A json-render state store with two layers: the agent's state from the spec (the base) and the user's edits on top.
 * The renderer reads the merged snapshot; the edits are what the GUI persists, so a re-fold of the spec or a remount
 * keeps what the user typed, and a new canvas generation can drop them.
 *
 * The newest writer wins: an edit stays on top while the agent's value at its path is the one the user changed, and is
 * dropped once the agent writes a different value there (at the path, under it, or by replacing a parent). Edits the
 * user made under a dropped edit's path go with it: they were made on top of it, and would land on other data.
 *
 * An edit of a list item (`/todos/1/done`, written by `$bindItem`) belongs to that item, not to the index: when the
 * agent inserts, removes or moves items, the edit follows its item to its new index, and goes when the item does. The
 * item is recognized by its `repeat.key` field when the spec declares one (see setItemKeys), else by its content: the
 * same item apart from the edited field, or, while the list keeps its length, the item at the same index.
 */
export interface TrackedStore extends StateStore {
  /**
   * Sets the agent's state from the spec. A no-op for the same object; subscribers hear only a real change. Edits whose
   * path the new state changed are dropped, and `onOverridesChange` listeners hear of it so the persisted copy follows.
   */
  setBase(state: Record<string, unknown> | undefined): void
  /**
   * Declares the state paths that hold secrets besides `/${UI_SECRET_ROOT}`: the paths password Inputs are bound to
   * (see secretPaths in src/protocol/normalize.ts). A `*` token matches any one segment, a leading `**` any number.
   */
  setSecrets(patterns: readonly string[]): void
  /**
   * Declares the lists the spec repeats with a `repeat.key` (see itemKeys in ./item-keys.ts), so edits of their items
   * follow the item with that key. Takes effect at the next `setBase`.
   */
  setItemKeys(keys: readonly ItemKey[]): void
  /**
   * The user's edits in the order they apply, without values that cannot be stored as JSON and without secrets: edits
   * under `/${UI_SECRET_ROOT}` or a secret path are left out, and an edit of a parent has the secrets under it removed.
   * Secrets the user typed live in memory only. At most MAX_OVERRIDES edits, in whole user actions (see
   * MAX_OVERRIDES); the live state keeps them all.
   */
  overrides(): readonly OverrideEntry[]
  /**
   * Restores persisted edits, replacing the stored kind of edits; entries at secret paths are ignored, and edits that
   * are never stored (secrets typed before the load) stay on top. Edits the current state has changed since are
   * dropped (or, before the first `setBase`, at that call). Does not call `onOverridesChange` listeners.
   */
  loadOverrides(entries: ReadonlyArray<readonly unknown[]>): void
  /** Drops the user's edits (and tells `onOverridesChange` listeners, so the persisted copy goes too). */
  reset(): void
  /** Takes the store's edits out of the window's bound (MAX_WINDOW_LIVE_SIZE): the window forgot the store. */
  dispose(): void
  /** json-render skipped part of the work a change of this store set off (see patches/@json-render%2Fsolid). */
  noteSkipped(): void
  /** Whether work was skipped since the agent's state last changed (see `noteSkipped`). */
  skippedWork(): boolean
  /**
   * Whether the agent's last change left edits of list items not looked up, or compared, for MAX_HASHED_ITEMS or
   * MAX_RECONCILE_WORK: such an edit stayed at its index when the list kept its length, and was dropped otherwise.
   */
  editsUnmatched(): boolean
  /** Hears `skippedWork` and `editsUnmatched` change. */
  onSkippedWork(listener: () => void): () => void
  onOverridesChange(listener: () => void): () => void
}

/**
 * How many edits the stored copy keeps (see TrackedStore.overrides), and how large they may be in all (MAX_STORED_SIZE,
 * in UTF-8 bytes of the stored entry: each edit written out with the separator and the action number it may get, so
 * the entry always fits in what snapshot.ts writes, MAX_ENTRY_BYTES; a stored copy measured in characters passed it,
 * and the stale entry stayed). It keeps whole
 * user actions, newest first, while they fit: the edits of one action (a click and the writes of the watches it wakes,
 * also in later tasks) are stored together or not at all, also across a reload (each stored edit records its action),
 * so a reload never brings back half of a select-all. An action that does not fit is left out with every older one.
 * Twice what one change may write (2,000 state actions, see patches/@json-render%2Fsolid), so a select-all over a
 * whole UI and the edits after it fit. The live state is not trimmed to this: a select-all over 600 rows dropped its
 * own click and its first rows from what the user saw.
 */
export const MAX_OVERRIDES = 4000
export const MAX_STORED_SIZE = MAX_ENTRY_BYTES - 64

/** What an action's number adds to the edit that starts a run of its edits: `,"a":4000`, or `,{"u":1,"a":4000}`. */
const MARK_BYTES = 17

/**
 * How many edits the live state keeps at most, a bound on memory for a spec that writes ever new paths: beyond it the
 * oldest go (EVICTED_TOGETHER at a time), never those of the current action. Far above what a UI can show (2,000 rows
 * of a repeat).
 */
export const MAX_LIVE_EDITS = 10_000
export const EVICTED_TOGETHER = 1000

/**
 * How large the live edits of one state store may be in all, and those of every store in the window together, in the
 * measure of MAX_EDIT_SIZE (each edit counted in full, also where it shares a value with another). An edit past either
 * is ignored (none of the store's other edits is dropped for it), and the console says so. Each edit holds at most a
 * million characters, and a store up to 10,000 of them: a key press whose watches each wrote a long text to a new path
 * kept 150 MB per key, and the window ran out of memory at the 18th key.
 */
export const MAX_LIVE_SIZE = 8_000_000
export const MAX_WINDOW_LIVE_SIZE = 32_000_000

// The size of every store's live edits together (see MAX_WINDOW_LIVE_SIZE).
let windowLiveSize = 0

let action = 0
let actionOpen = false
let workOf: (() => object | undefined) | undefined
const actionOfWork = new WeakMap<object, number>()

/**
 * Keeps a user action's edits together by `work`, json-render's current work (as patched, see src/gui/registry.tsx): a
 * change and everything it sets off, also what json-render's time slice sends on to later tasks (a select-all over
 * thousands of rows). Without it, an action is one task.
 */
export function groupEditsBy(work: (() => object | undefined) | undefined): void {
  workOf = work
}

/**
 * The user action an edit belongs to: a click, or a key press, and the watches it wakes (see `groupEditsBy`), else every
 * edit made in one task.
 */
function currentAction(): number {
  const work = workOf?.()
  if (work) {
    let id = actionOfWork.get(work)
    if (id === undefined) {
      id = ++action
      actionOfWork.set(work, id)
    }
    return id
  }
  if (!actionOpen) {
    actionOpen = true
    action++
    afterTask(() => {
      actionOpen = false
    })
  }
  return action
}

/**
 * The actions of `edits` whose edits are stored, newest first (by their newest edit): whole actions while they fit in
 * MAX_OVERRIDES edits (the newest whatever its count) and MAX_STORED_SIZE bytes, the newest included; an action that does
 * not fit ends the list. Each edit takes `sizeOf` it as stored, and once two actions or more are stored, each run of an
 * action's edits takes MARK_BYTES more (the number of its action, see `overrides`). An action's edits need not be next
 * to each other: a key press can come between the tasks of a select-all.
 */
function storedActions<T extends { readonly action: number }>(
  edits: readonly T[],
  sizeOf: (edit: T) => number,
): Set<number> {
  // How many runs each action's edits make (at most: leaving an action out can only join the runs around it).
  const runs = new Map<number, number>()
  for (let index = 0; index < edits.length; index++) {
    const made = edits[index]!.action
    if (index === 0 || edits[index - 1]!.action !== made) runs.set(made, (runs.get(made) ?? 0) + 1)
  }
  const markOf = (made: number) => (runs.get(made) ?? 1) * MARK_BYTES
  const byAction = new Map<number, T[]>()
  const newestFirst: number[] = []
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!
    let list = byAction.get(edit.action)
    if (!list) {
      byAction.set(edit.action, (list = []))
      newestFirst.push(edit.action)
    }
    list.push(edit)
  }
  const kept = new Set<number>()
  let count = 0
  let size = 0
  let marks = 0
  for (const made of newestFirst) {
    const list = byAction.get(made)!
    if (kept.size > 0 && count + list.length > MAX_OVERRIDES) break
    // The first action's marks are paid once a second one is stored.
    const marked = kept.size > 0
    let added = 0
    for (const edit of list) {
      added += sizeOf(edit)
      if (size + added + (marked ? marks + markOf(made) : 0) > MAX_STORED_SIZE) return kept
    }
    kept.add(made)
    count += list.length
    size += added
    marks += markOf(made)
  }
  return kept
}

/**
 * How large a value one edit may write, in characters of its strings plus entries of its lists and objects. A larger
 * one is ignored: a pair of watches can double a string on every round (`{"$template":"${/a}${/a}"}`), which reached a
 * billion characters, and the window ran out of memory, before any other bound stopped it.
 */
export const MAX_EDIT_SIZE = 1_000_000

/**
 * The size of a value in characters of its strings plus entries of its lists and objects (a shared part counted each
 * time it is reached), up to just past MAX_EDIT_SIZE: the walk stops there.
 */
export function editSize(value: unknown): number {
  let size = 0
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const item = stack.pop()
    if (typeof item === "string") size += item.length
    else if (Array.isArray(item)) {
      size += item.length
      for (const entry of item) stack.push(entry)
    } else if (item && typeof item === "object") {
      const entries = Object.values(item)
      size += entries.length
      for (const entry of entries) stack.push(entry)
    }
    if (size > MAX_EDIT_SIZE) return size
  }
  return size
}

/** Whether a value is larger than MAX_EDIT_SIZE (see there); the walk stops once it is. */
export const tooLarge = (value: unknown): boolean => editSize(value) > MAX_EDIT_SIZE

/** How many characters of JSON an edit's stored levels may take. */
const MAX_STORED_LEVELS = 2048

const EMPTY_STATE: StateModel = Object.freeze({}) as StateModel

/** The agent's value at an edit's path when the user made it; `UNKNOWN` until a base is known. */
type Against = { readonly value: unknown } | typeof UNKNOWN
const UNKNOWN = Symbol("unknown")

/**
 * An array item an edit's path goes through (`/todos/1` for `/todos/1/done`): the agent's item when the user made the
 * edit, refreshed each time the edit follows it, and the array's length then.
 */
interface Level {
  /** The index of the item's token in the edit's path. */
  readonly depth: number
  item: unknown
  length: number
}

interface Edit {
  path: string
  tokens: readonly string[]
  readonly value: unknown
  readonly persist: boolean
  against: Against
  /** The array items on the path, outermost first; undefined until a base is known. */
  levels: Level[] | undefined
  /** The user action that made it (see currentAction); loaded edits count from below zero. */
  readonly action: number
  /** Its value's size (see editSize). */
  readonly size: number
  /** Replaced by a later write: skipped until the list is compacted. */
  dead?: boolean
}

// The ancestor paths of a pointer: `/a`, `/a/b` for `/a/b/c`.
function ancestorsOf(path: string): string[] {
  const result: string[] = []
  for (let index = path.indexOf("/", 1); index !== -1; index = path.indexOf("/", index + 1))
    result.push(path.slice(0, index))
  return result
}

const SECRET = `/${UI_SECRET_ROOT}`

/** Whether a state path is under the secret root, whose values are never persisted. */
export const isSecretPath = (path: string) => path === SECRET || path.startsWith(`${SECRET}/`)

/** A secret path pattern as tokens; `*` matches one segment, a leading `**` any number of them. */
type Pattern = readonly string[]

const ANY_DEPTH = "**"
const REMOVE = Symbol("remove")

const matches = (want: string, token: string) => want === "*" || want === token

const INDEX = /^(0|[1-9]\d*)$/

// Whether a path is exactly a pattern (as opposed to at or under it).
const isExactly = (pattern: Pattern, tokens: readonly string[]) => {
  const body = pattern[0] === ANY_DEPTH ? pattern.slice(1) : pattern
  if (pattern[0] !== ANY_DEPTH ? tokens.length !== body.length : tokens.length < body.length) return false
  const start = tokens.length - body.length
  return body.every((want, index) => matches(want, tokens[start + index]!))
}

const own = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined

// --- Finding a list's items by content ------------------------------------------------------------------------------

// A structural hash of a JSON-like value, the same for values `Matcher.equal` finds equal: an object's members in any
// order, an array's items with their index. Seeded per window, so a spec cannot be written to collide. Equal hashes
// are only candidates: the caller compares the values themselves.
const HASH_SEED = (Math.random() * 0x100000000) >>> 0

function hashText(text: string): number {
  let hash = HASH_SEED ^ 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return hash >>> 0
}

const mix = (hash: number) => {
  let next = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  next = Math.imul(next ^ (next >>> 13), 0xc2b2ae35)
  return (next ^ (next >>> 16)) >>> 0
}

function leafHash(value: unknown): number {
  if (typeof value === "string") return mix(hashText(value) ^ 0x51)
  if (typeof value === "number") return mix(hashText(Object.is(value, -0) ? "-0" : String(value)) ^ 0x52)
  return mix(hashText(String(value)) ^ 0x53)
}

const isContainer = (value: unknown): value is object => typeof value === "object" && value !== null

/**
 * How tall a container may be to be compared member by member, and hashed with what lies below its members (jsonEqual
 * in src/protocol/fold.ts stops at this depth too). A taller member counts as different unless it is the very same
 * object, and adds TALL to its container's hash; walking a value stops this many levels down, so a deep chain costs
 * neither the stack nor more than these levels.
 */
const MAX_COMPARED_HEIGHT = 200
const TALL = 0x54

/**
 * How much one reconcile may hash and compare, in members (and 16 characters of a string) visited: about four times
 * the largest state a UI holds. Every container is hashed once and every pair of containers compared once per
 * reconcile (see Matcher), so this is only a backstop: past it, a list's items are looked up no more and new
 * comparisons count as changed, and the UI says so (see TrackedStore.editsUnmatched).
 */
export const MAX_RECONCILE_WORK = 4_000_000

/**
 * How many list items the lookups of one reconcile hash in all (each way of comparing a list's items hashes all of it
 * once, see Matcher.nearest): a few ways over the longest lists a UI shows. Past it, an item is looked up no more.
 */
export const MAX_HASHED_ITEMS = 200_000

/** A container's hash (see Matcher.walk) and its height, at most MAX_COMPARED_HEIGHT + 1. */
interface Hashed {
  readonly hash: number
  readonly height: number
}
/** A walk that stopped before it could tell (a lower bound of the height, see Matcher.walk). */
interface Unfinished {
  readonly hash: number
  readonly height: number
  readonly partial: true
}

const SAME = Symbol("same")
const MANY = Symbol("many")
/** How two containers differ: not at all, in one member (its key), or in more (or in kind or length). */
type Diff = string | typeof SAME | typeof MANY

/**
 * Hashes and compares the agent's values for one reconcile, each container once and each pair of containers once, so
 * what an edit costs does not grow with the size of its item. Edits under one large item each compared and hashed all
 * of it: after a select-all wrote 7,600 edits below a list inside one row of 85 KB, an agent patch that changed one
 * field of the row froze the window for 21 s, and saving the edits (see `overrides`) for 3.6 s. The agent's state is
 * never changed in place (patches copy what they change, see src/protocol/patch.ts), so nothing goes stale within a
 * reconcile.
 */
export class Matcher {
  private readonly hashes = new WeakMap<object, Hashed>()
  private readonly diffs = new WeakMap<object, WeakMap<object, Diff>>()
  private readonly keyHashes = new Map<string, number>()
  private readonly lists = new Map<readonly unknown[], Map<string, Map<number, number[]>>>()
  private hashedItems = 0
  private work = 0
  /** Whether a lookup or a comparison was given up for MAX_RECONCILE_WORK or MAX_HASHED_ITEMS. */
  cut = false

  private keyHash(key: string): number {
    let hash = this.keyHashes.get(key)
    if (hash === undefined) {
      this.work += 1 + (key.length >> 4)
      this.keyHashes.set(key, (hash = Math.imul(hashText(key), 0x9e3779b1)))
    }
    return hash
  }

  // An array index's hash, as `keyHash` gives an object key's (a list of 40,000 items hashed each index as text).
  private static indexHash(index: number): number {
    return Math.imul(mix((index + 1) ^ HASH_SEED ^ 0x2545f491), 0x9e3779b1)
  }

  // The hash of a container's member's key: an object's key, or an array's index (`key` as text).
  private keyOf(container: object, key: string): number {
    return Array.isArray(container) ? Matcher.indexHash(Number(key)) : this.keyHash(key)
  }

  // What one member adds to its container's hash, from its key's hash (see `keyOf`) and its value's.
  private static memberHash(key: number, hash: number): number {
    return mix(key ^ hash)
  }

  /**
   * A container's hash: the sum of its members' (so one member's can be taken out, see `hashExcept`), with its kind
   * and, for an array, its length, a taller member adding TALL. A pure function of the value, remembered by identity.
   * `depth` only bounds the walk: a container more than MAX_COMPARED_HEIGHT levels below the walk's start is not
   * entered, so a member's result may be a lower bound of its height (`partial`), which tells TALL apart only once it
   * passes the bound; from the start (depth 0) every member is told apart, and the result is whole.
   */
  private walk(value: object, depth: number): Hashed | Unfinished {
    const known = this.hashes.get(value)
    if (known) return known
    if (depth > MAX_COMPARED_HEIGHT) return { hash: 0, height: 1, partial: true }
    let hash = Array.isArray(value) ? mix(0x55 ^ value.length) : 0x56
    let height = 1
    let whole = true
    const add = (key: number, member: unknown) => {
      this.work++
      let contribution: number
      if (isContainer(member)) {
        const below = this.walk(member, depth + 1)
        height = Math.max(height, Math.min(below.height + 1, MAX_COMPARED_HEIGHT + 1))
        if (below.height > MAX_COMPARED_HEIGHT) contribution = TALL
        else if ("partial" in below) {
          whole = false
          return
        } else contribution = below.hash
      } else {
        if (typeof member === "string") this.work += member.length >> 4
        contribution = leafHash(member)
      }
      hash = (hash + Matcher.memberHash(key, contribution)) >>> 0
    }
    if (Array.isArray(value))
      for (let index = 0; index < value.length; index++) add(Matcher.indexHash(index), value[index])
    else for (const key of Object.keys(value)) add(this.keyHash(key), (value as Record<string, unknown>)[key])
    if (!whole && height <= MAX_COMPARED_HEIGHT) return { hash: 0, height, partial: true }
    const result: Hashed = { hash, height }
    this.hashes.set(value, result)
    return result
  }

  private tall(value: object): boolean {
    return this.walk(value, 0).height > MAX_COMPARED_HEIGHT
  }

  /** The hash of a value (see `walk`). */
  hash(value: unknown): number {
    return isContainer(value) ? this.walk(value, 0).hash : leafHash(value)
  }

  // What a member adds to its container's hash before `memberHash`.
  private contribution(member: unknown): number {
    return isContainer(member) && this.tall(member) ? TALL : this.hash(member)
  }

  /**
   * The hash of a value apart from the member at `rest` (from `from` on), the same for any two values `sameExcept`
   * finds the same apart from it: the member at the end of `rest` is left out, and each member on the way to it is
   * hashed apart from what lies below it. (Hashing items without only their first member put rows that differ below
   * it, in `a.c` for an edit at `a/b`, in one bucket, and an edit whose row was gone compared itself with all of
   * them: edits × rows per agent patch.) Costs the length of `rest`: the hashes it takes apart are remembered.
   */
  hashExcept(value: unknown, rest: readonly string[], from = 0): number {
    if (!isContainer(value)) return leafHash(value)
    const whole = this.walk(value, 0).hash
    const head = rest[from]
    if (head === undefined || !Object.hasOwn(value, head)) return whole
    const member = (value as Record<string, unknown>)[head]
    // A value that is not a container has nothing below it to leave out: its member counts whole.
    if (from < rest.length - 1 && !isContainer(member)) return whole
    const key = this.keyOf(value, head)
    const without = (whole - Matcher.memberHash(key, this.contribution(member))) >>> 0
    if (from === rest.length - 1) return without
    return (without + Matcher.memberHash(key, this.hashExcept(member, rest, from + 1))) >>> 0
  }

  // Whether a container's member equals another's: the same object, or equal values short enough to compare.
  private memberEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true
    if (!isContainer(a) || !isContainer(b) || this.tall(a) || this.tall(b)) return false
    return this.equal(a, b)
  }

  /** Whether two values are the same JSON (as jsonEqual in src/protocol/fold.ts). */
  equal(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true
    if (!isContainer(a) || !isContainer(b)) return false
    if (this.hash(a) !== this.hash(b)) return false
    return this.diff(a, b) === SAME
  }

  // How two containers differ, worked out once per pair; past MAX_RECONCILE_WORK, a pair not compared yet differs.
  private diff(a: object, b: object): Diff {
    let row = this.diffs.get(a)
    const known = row?.get(b)
    if (known !== undefined) return known
    let result: Diff = SAME
    if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== (b as unknown[]).length))
      result = MANY
    else if (this.work > MAX_RECONCILE_WORK) {
      this.cut = true
      result = MANY
    } else if (Array.isArray(a)) {
      const other = b as unknown[]
      for (let index = 0; index < a.length && result !== MANY; index++) {
        this.work++
        if (!this.memberEqual(a[index], other[index])) result = result === SAME ? String(index) : MANY
      }
    } else {
      const proto = Object.getPrototypeOf(a)
      if (proto !== Object.getPrototypeOf(b) || (proto !== Object.prototype && proto !== null)) result = MANY
      else {
        const keys = Object.keys(a)
        for (let index = 0; index < keys.length && result !== MANY; index++) {
          const key = keys[index]!
          this.work++
          if (!this.memberEqual(own(a, key), own(b, key))) result = result === SAME ? key : MANY
        }
        const others = Object.keys(b)
        for (let index = 0; index < others.length && result !== MANY; index++) {
          const key = others[index]!
          if (Object.hasOwn(a, key)) continue
          this.work++
          if (!this.memberEqual(undefined, own(b, key))) result = result === SAME ? key : MANY
        }
      }
    }
    if (!row) this.diffs.set(a, (row = new WeakMap()))
    row.set(b, result)
    return result
  }

  /**
   * Whether two items are the same apart from the member at `rest` (from `from` on; an empty `rest`: the whole
   * values). Costs the length of `rest` once each pair of containers on the way has been compared.
   */
  sameExcept(a: unknown, b: unknown, rest: readonly string[], from = 0): boolean {
    if (from >= rest.length) return this.equal(a, b)
    if (Object.is(a, b)) return true
    if (!isContainer(a) || !isContainer(b)) return false
    const diff = this.diff(a, b)
    if (diff === SAME) return true
    const head = rest[from]!
    if (diff !== head) return false
    return from === rest.length - 1 || this.sameExcept(own(a, head), own(b, head), rest, from + 1)
  }

  /**
   * The index nearest `near` (the earlier on a tie) of an item of `list` that `same` accepts, among those whose hash
   * `hash` gives the same as `wanted`; undefined when there is none. For each list (by identity) and each way of
   * comparing (by key field, whole items, or items apart from a member), the indices of its items by hash are built
   * once: after a select-all wrote an edit per row, an agent patch that moved every row compared each edit with the
   * whole list (7,000 rows and 2,000 edits took 7 s per patch).
   */
  nearest(
    list: readonly unknown[],
    way: string,
    hash: (item: unknown) => number,
    wanted: number,
    near: number,
    same: (item: unknown) => boolean,
  ): number | undefined {
    let ways = this.lists.get(list)
    if (!ways) this.lists.set(list, (ways = new Map()))
    let byHash = ways.get(way)
    if (!byHash) {
      // Each way of comparing items hashes the whole list once. Edits whose paths name a different field each (written
      // through an expression) could ask for a way each: past the bounds, an item is looked up no more (as if gone).
      if (this.hashedItems + list.length > MAX_HASHED_ITEMS || this.work > MAX_RECONCILE_WORK) {
        this.cut = true
        return undefined
      }
      this.hashedItems += list.length
      byHash = new Map()
      for (let index = 0; index < list.length; index++) {
        this.work++
        const key = hash(list[index])
        const bucket = byHash.get(key)
        if (bucket) bucket.push(index)
        else byHash.set(key, [index])
      }
      ways.set(way, byHash)
    }
    const candidates = byHash.get(wanted)
    if (!candidates) return undefined
    // Outward from `near`: the first candidate below it (`left`) and at or above it (`right`).
    let low = 0
    let high = candidates.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (candidates[middle]! < near) low = middle + 1
      else high = middle
    }
    let left = low - 1
    let right = low
    while (left >= 0 || right < candidates.length) {
      const takeLeft =
        right >= candidates.length || (left >= 0 && near - candidates[left]! <= candidates[right]! - near)
      const at = takeLeft ? candidates[left--]! : candidates[right++]!
      if (same(list[at])) return at
    }
    return undefined
  }
}

// Whether `tokens` from `start` on match all of `body`: the path is at or under it.
const coversFrom = (body: Pattern, tokens: readonly string[], start: number) =>
  tokens.length - start >= body.length && body.every((want, index) => matches(want, tokens[start + index]!))

// Whether a path is at or under one of the patterns.
function coveredBy(patterns: readonly Pattern[], tokens: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern[0] !== ANY_DEPTH) return coversFrom(pattern, tokens, 0)
    const body = pattern.slice(1)
    for (let start = 0; start <= tokens.length; start++) if (coversFrom(body, tokens, start)) return true
    return false
  })
}

// What a pattern marks secret inside the value at a parent path `tokens`, as patterns relative to that value.
function below(pattern: Pattern, tokens: readonly string[]): Pattern[] {
  if (pattern[0] !== ANY_DEPTH) {
    if (tokens.length >= pattern.length || !tokens.every((token, index) => matches(pattern[index]!, token))) return []
    return [pattern.slice(tokens.length)]
  }
  // The pattern's body may start anywhere inside the value, or already have started at the end of the path.
  const body = pattern.slice(1)
  const result: Pattern[] = [pattern]
  for (let done = 1; done < body.length && done <= tokens.length; done++)
    if (body.slice(0, done).every((want, index) => matches(want, tokens[tokens.length - done + index]!)))
      result.push(body.slice(done))
  return result
}

// A copy of a JSON value with each member `change` returns something else for replaced (REMOVE deletes an object
// member, and nulls an array item so later indexes stay put). The value itself when nothing changes.
function mapMembers(value: unknown, change: (member: unknown, key: string) => unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) {
    let out: unknown[] | undefined
    value.forEach((member, index) => {
      const next = change(member, String(index))
      if (next === member) return
      out ??= [...value]
      out[index] = next === REMOVE ? null : next
    })
    return out ?? value
  }
  let out: Record<string, unknown> | undefined
  for (const [key, member] of Object.entries(value)) {
    const next = change(member, key)
    if (next === member) continue
    out ??= { ...value }
    if (next === REMOVE) delete out[key]
    else out[key] = next
  }
  return out ?? value
}

// The value without the members a relative pattern names.
function strip(value: unknown, pattern: Pattern): unknown {
  if (pattern.length === 0) return value
  if (pattern[0] === ANY_DEPTH) {
    const rest = pattern.slice(1)
    if (rest.length === 0) return value
    return mapMembers(strip(value, rest), (member) => strip(member, pattern))
  }
  const [head, ...rest] = pattern
  return mapMembers(value, (member, key) =>
    !matches(head!, key) ? member : rest.length === 0 ? REMOVE : strip(member, rest),
  )
}

// The value of an edit at a parent path `tokens`, without the secrets the patterns mark under it.
function withoutSecrets(value: unknown, tokens: readonly string[], patterns: readonly Pattern[]): unknown {
  let result = value
  for (const pattern of patterns) for (const inner of below(pattern, tokens)) result = strip(result, inner)
  return result
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Levels read back from storage, when they fit the path: increasing depths of index tokens, and lengths past them.
function storedLevels(value: unknown, tokens: readonly string[]): Level[] | undefined {
  if (!Array.isArray(value)) return
  const levels: Level[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 3) return
    const [depth, item, length] = entry as [unknown, unknown, unknown]
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth >= tokens.length) return
    if (levels.length > 0 && depth <= levels.at(-1)!.depth) return
    if (!INDEX.test(tokens[depth]!) || typeof length !== "number" || !Number.isInteger(length)) return
    if (length <= Number(tokens[depth])) return
    levels.push({ depth, item, length })
  }
  return levels
}

/** Whether a value survives a JSON round trip as itself (undefined object members are dropped, which is fine). */
export function isJsonValue(value: unknown, depth = 0): boolean {
  if (value === null) return true
  switch (typeof value) {
    case "string":
    case "boolean":
      return true
    case "number":
      return Number.isFinite(value)
    case "object": {
      if (depth > 64) return false
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) if (!isJsonValue(value[index], depth + 1)) return false
        return true
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return false
      for (const member of Object.values(value))
        if (member !== undefined && !isJsonValue(member, depth + 1)) return false
      return true
    }
    default:
      return false
  }
}

/**
 * A value's length written out as JSON, or `cap + 1` once it is surely longer, or -1 when it is not JSON (see
 * isJsonValue). Its size is first counted from below (each string, key and entry takes at least its own characters
 * written out), stopping past `cap`, so a large value is not written out, nor even walked whole.
 */
export function jsonLength(value: unknown, cap: number): number {
  let least = 0
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const next = stack.pop()
    if (typeof next === "string") least += next.length + 2
    else if (Array.isArray(next)) {
      least += 1 + Math.max(1, next.length)
      for (let index = 0; index < next.length && least <= cap; index++) stack.push(next[index])
    } else if (isContainer(next)) {
      least += 1
      for (const key in next) {
        const member = (next as Record<string, unknown>)[key]
        if (!Object.hasOwn(next, key) || member === undefined) continue
        // `"key":` and a comma or the closing brace.
        least += key.length + 4
        stack.push(member)
        if (least > cap) break
      }
    } else least += 1
    if (least > cap) return cap + 1
  }
  if (!isJsonValue(value)) return -1
  const length = JSON.stringify(value).length
  return length > cap ? cap + 1 : length
}

/**
 * `next` with each member that equals the one at its place in `previous` replaced by that one, and `previous` itself
 * when all of it is equal. Only containers of `owned` (made by the compose that gave `next`) are changed, and walked
 * member by member; any other value is the agent's, kept or compared whole. The renderer compares by identity: composed
 * anew, every item the user's edits are under was a new object after each agent patch, and json-render updated every
 * row of their list (1,900 rows after a select-all, a quarter of a second per patch).
 */
function share(next: unknown, previous: unknown, owned: ReadonlySet<object>): unknown {
  if (Object.is(next, previous)) return previous
  if (!isContainer(next) || !isContainer(previous) || Array.isArray(next) !== Array.isArray(previous)) return next
  if (!owned.has(next)) return jsonEqual(next, previous) ? previous : next
  let same = true
  if (Array.isArray(next)) {
    const before = previous as unknown[]
    if (next.length !== before.length) same = false
    for (let index = 0; index < next.length; index++) {
      if (index >= before.length) continue
      const member = share(next[index], before[index], owned)
      if (member !== next[index]) next[index] = member
      if (member !== before[index]) same = false
    }
  } else {
    const target = next as Record<string, unknown>
    const before = previous as Record<string, unknown>
    const keys = Object.keys(target)
    if (keys.length !== Object.keys(before).length || Object.getPrototypeOf(target) !== Object.getPrototypeOf(before))
      same = false
    for (const key of keys) {
      if (!Object.hasOwn(before, key)) {
        same = false
        continue
      }
      const member = share(target[key], before[key], owned)
      if (member !== target[key]) target[key] = member
      if (member !== before[key]) same = false
    }
  }
  return same ? previous : next
}

// json-render writes JSON pointers, but its own reader also accepts them without the leading slash. Writing the root
// itself is not something a component does, so it is ignored rather than guessed at.
function pointer(path: unknown): string | undefined {
  if (typeof path !== "string") return
  const normalized = path.startsWith("/") ? path : `/${path}`
  if (normalized === "/") return
  return parsePointer(normalized) ? normalized : undefined
}

const replace = (doc: StateModel, path: string, value: unknown) => applyPatch(doc, { op: "replace", path, value })

function emit(listeners: Set<() => void>) {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // One failing listener must not keep the others (such as persistence) from running.
      console.error("genui: state listener failed", error)
    }
  }
}

export function createTrackedStore(base?: Record<string, unknown>): TrackedStore {
  let layer: StateModel = isRecord(base) ? base : EMPTY_STATE
  // Until the first setBase (a runtime is created before its surface renders), edits cannot know what they changed.
  let based = base !== undefined
  // The edits in the order they apply. A write marks the edits it replaces dead (they are skipped, and compacted away
  // now and then) and finds them through `byPath` and `under`, so it costs the same however many edits there are: a
  // select-all over 2,000 rows writes 2,000 of them.
  let edits: Edit[] = []
  let dead = 0
  const byPath = new Map<string, Edit>()
  /** How many live edits are under each path. */
  const under = new Map<string, number>()
  let snapshot: StateModel = layer
  let persisted: readonly OverrideEntry[] | undefined
  // The secret patterns in force: what the spec declares now, plus, while edits exist, whatever it declared before (a
  // password the user typed stays a secret when the agent's next version drops or changes its Input).
  let secrets: readonly Pattern[] = []
  let declared: readonly Pattern[] = []
  let secretKey = ""
  let keys: ReadonlyArray<{ readonly pattern: Pattern; readonly key: string }> = []
  let keysKey = ""
  const subscribers = new Set<() => void>()
  const editListeners = new Set<() => void>()
  // The size of the live edits (see MAX_LIVE_SIZE), and whether it counts in the window's (until `dispose`).
  let liveSize = 0
  let inWindow = true
  let refusedTold = false
  let skipped = false
  // Whether the last reconcile gave up on looking up or comparing items (see `editsUnmatched`).
  let unmatched = false
  const skipListeners = new Set<() => void>()
  const grow = (size: number) => {
    liveSize += size
    if (inWindow) windowLiveSize += size
  }

  const index = (edit: Edit) => {
    byPath.set(edit.path, edit)
    grow(edit.size)
    for (const ancestor of ancestorsOf(edit.path)) under.set(ancestor, (under.get(ancestor) ?? 0) + 1)
  }
  const kill = (edit: Edit) => {
    if (edit.dead) return
    edit.dead = true
    dead++
    grow(-edit.size)
    byPath.delete(edit.path)
    for (const ancestor of ancestorsOf(edit.path)) {
      const count = (under.get(ancestor) ?? 1) - 1
      if (count > 0) under.set(ancestor, count)
      else under.delete(ancestor)
    }
  }
  // The live edits, in order.
  const live = (): Edit[] => {
    if (dead > 0) {
      edits = edits.filter((edit) => !edit.dead)
      dead = 0
    }
    return edits
  }
  const setEdits = (next: Edit[]) => {
    edits = next
    dead = 0
    byPath.clear()
    under.clear()
    grow(-liveSize)
    for (const edit of next) {
      // Two edits that followed their items to one path: the later applies last, and is the one that stays.
      const earlier = byPath.get(edit.path)
      if (earlier) kill(earlier)
      index(edit)
    }
  }

  // The agent's state with the edits on top, sharing the current snapshot's objects wherever the content is the same
  // (see `share`).
  const compose = (): StateModel => {
    const owned = new Set<object>()
    const next = replaceAll(
      layer,
      live().map((edit) => [edit.tokens, edit.value] as const),
      owned,
    )
    return share(next, snapshot, owned) as StateModel
  }

  // Keeps the current snapshot object when the content did not change, since the renderer compares by identity.
  const commit = (next: StateModel) => {
    if (next === snapshot || jsonEqual(next, snapshot)) return false
    snapshot = next
    emit(subscribers)
    return true
  }

  const baseAt = (tokens: readonly string[]): Against => (based ? { value: getAt(layer, tokens) } : UNKNOWN)

  // The array items of the agent's state that a path goes through.
  const levelsAt = (tokens: readonly string[]): Level[] => {
    const levels: Level[] = []
    let node: unknown = layer
    for (let depth = 0; depth < tokens.length; depth++) {
      const token = tokens[depth]!
      if (Array.isArray(node)) {
        if (!INDEX.test(token) || Number(token) >= node.length) break
        const length = node.length
        node = node[Number(token)]
        levels.push({ depth, item: node, length })
      } else if (isRecord(node) && Object.hasOwn(node, token)) node = node[token]
      else break
    }
    return levels
  }

  // The `repeat.key` field of the list at `tokens`, when the spec declares exactly one.
  const keyOf = (tokens: readonly string[]): string | undefined => {
    let found: string | undefined
    for (const declared of keys) {
      if (!isExactly(declared.pattern, tokens)) continue
      if (found !== undefined && found !== declared.key) return undefined
      found = declared.key
    }
    return found
  }

  // Where an edit's items are in the agent's state now: its path with each item's current index, or undefined when an
  // item is gone. Each level is refreshed to the item found (`refreshed` says whether that changed anything). A list the
  // agent replaced with something else is left to the comparison at the edit's path.
  let refreshed = false
  let matcher = new Matcher()
  const follow = (edit: Edit, levels: readonly Level[]): readonly string[] | undefined => {
    let tokens = edit.tokens
    for (const level of levels) {
      const listPath = tokens.slice(0, level.depth)
      const list = getAt(layer, listPath)
      if (!Array.isArray(list)) return tokens
      const index = Number(tokens[level.depth])
      const rest = tokens.slice(level.depth + 1)
      const field = keyOf(listPath)
      const id = field === undefined ? undefined : own(level.item, field)
      const same =
        id !== undefined && id !== null
          ? (item: unknown) => matcher.equal(own(item, field!), id)
          : (item: unknown) => matcher.sameExcept(item, level.item, rest)
      let at: number | undefined
      if (index < list.length && (Object.is(list[index], level.item) || same(list[index]))) at = index
      else {
        // The nearest equal item: a list of equal items keeps the edit where it was.
        at =
          id !== undefined && id !== null
            ? matcher.nearest(
                list,
                `key:${field}`,
                (item) => matcher.hash(own(item, field!)),
                matcher.hash(id),
                index,
                same,
              )
            : rest.length === 0
              ? matcher.nearest(list, "whole", (item) => matcher.hash(item), matcher.hash(level.item), index, same)
              : matcher.nearest(
                  list,
                  `without:${rest.join("\u0000")}`,
                  (item) => matcher.hashExcept(item, rest),
                  matcher.hashExcept(level.item, rest),
                  index,
                  same,
                )
        // No such item: one with a key is gone; without one, it changed in place if the list kept its length.
        if (at === undefined) {
          if ((id !== undefined && id !== null) || list.length !== level.length || index >= list.length) return
          at = index
        }
      }
      if (level.item !== list[at] || level.length !== list.length) refreshed = true
      level.item = list[at]
      level.length = list.length
      if (at !== index) tokens = [...listPath, String(at), ...rest]
    }
    return tokens
  }

  // Whether an edit of `size` at `path` fits in the bounds on the live edits' size (see MAX_LIVE_SIZE); said once per
  // store when it does not.
  const roomFor = (path: string, size: number): boolean => {
    const replaced = byPath.get(path)?.size ?? 0
    const whose =
      inWindow && windowLiveSize - replaced + size > MAX_WINDOW_LIVE_SIZE
        ? "the window's"
        : liveSize - replaced + size > MAX_LIVE_SIZE
          ? "this UI's"
          : undefined
    if (whose === undefined) return true
    if (!refusedTold) {
      refusedTold = true
      console.warn(
        `[genui] Ignored an edit of the UI's state: ${whose} edits would hold more than ${(whose === "the window's" ? MAX_WINDOW_LIVE_SIZE : MAX_LIVE_SIZE).toLocaleString("en-US")} characters in all.`,
      )
    }
    return false
  }

  // A write replaces earlier edits of the same path and of everything under it. Returns whether old edits were dropped
  // for MAX_LIVE_EDITS, which means the snapshot must be composed again.
  const record = (
    path: string,
    value: unknown,
    made: number,
    against?: Against,
    levels?: Level[],
    size = editSize(value),
  ) => {
    const tokens = parsePointer(path)!
    const replaced = byPath.get(path)
    if (replaced) kill(replaced)
    if (under.has(path)) {
      const prefix = `${path}/`
      for (const edit of edits) if (!edit.dead && edit.path.startsWith(prefix)) kill(edit)
    }
    const edit: Edit = {
      path,
      tokens,
      value,
      persist: isJsonValue(value),
      against: against ?? baseAt(tokens),
      levels: levels ?? (based ? levelsAt(tokens) : undefined),
      action: made,
      size,
    }
    edits.push(edit)
    index(edit)
    persisted = undefined
    if (dead > 64 && dead * 2 > edits.length) live()
    if (edits.length - dead <= MAX_LIVE_EDITS) return false
    // The oldest go, never the current action's: EVICTED_TOGETHER of them at once, so the snapshot is composed again once
    // per that many writes, not on every write at the bound.
    const all = live()
    let cut = 0
    while (cut < all.length - (MAX_LIVE_EDITS - EVICTED_TOGETHER) && all[cut]!.action !== made) cut++
    if (cut === 0) return false
    setEdits(all.slice(cut))
    return true
  }

  // Newest writer wins: drops the edits whose path the agent's state changed since the user made them, and the later
  // edits under their paths; an edit of a list item first follows its item (see `follow`). Edits that did not know their
  // base yet take the current one (which only refreshes the stored form). Returns whether any edit changed (dropped,
  // moved, or the items it follows), so the stored copy can follow.
  const reconcile = () => {
    if (!based) return false
    const dropped = new Set<string>()
    // Whether a path is under a dropped one (each "/" after the first starts a deeper path).
    const underDropped = (path: string) => {
      for (let slash = path.indexOf("/", 1); slash !== -1; slash = path.indexOf("/", slash + 1))
        if (dropped.has(path.slice(0, slash))) return true
      return false
    }
    let changed = false
    let stale = false
    matcher = new Matcher()
    const all = live()
    const kept = all.filter((edit) => {
      // An edit made on top of a dropped one (under its path, later) goes too.
      if (dropped.size > 0 && underDropped(edit.path)) return false
      // What the edit changed, and the items it belongs to, are the current ones when it did not know them yet.
      if (edit.levels === undefined) {
        edit.levels = levelsAt(edit.tokens)
        stale = true
      }
      if (edit.against === UNKNOWN) {
        edit.against = { value: getAt(layer, edit.tokens) }
        stale = true
        return true
      }
      refreshed = false
      const tokens = follow(edit, edit.levels)
      if (tokens === undefined || !matcher.equal(edit.against.value, getAt(layer, tokens))) {
        dropped.add(edit.path)
        return false
      }
      if (tokens !== edit.tokens) {
        edit.tokens = tokens
        edit.path = `/${tokens.map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
        changed = true
      }
      if (refreshed) changed = true
      return true
    })
    unmatched = matcher.cut
    matcher = new Matcher()
    if (stale) persisted = undefined
    if (!changed && kept.length === all.length) return false
    setEdits(kept)
    persisted = undefined
    return true
  }

  // An edit's levels as stored: an item of a keyed list as its key alone, others whole. Levels too big to store (an
  // outer item holding a long list) are left out; the edit then takes the items at its path when it loads. `lengthOf`
  // gives a value's JSON length (see jsonLength), remembered for the call of `overrides`: the edits under one item share
  // it, and checking and writing out the whole item for each of them made saving 7,600 edits under one row of 85 KB
  // take 3.6 s.
  const storable = (edit: Edit, lengthOf: (value: unknown) => number): StoredLevel[] => {
    // The levels written out: `[` and `]`, and for each, `[depth,item,length]` and a comma before all but the first.
    let length = 2
    const levels: StoredLevel[] = []
    for (const level of edit.levels ?? []) {
      const field = keyOf(edit.tokens.slice(0, level.depth))
      const id = field === undefined ? undefined : own(level.item, field)
      const keyed = id !== undefined && id !== null
      const item = keyed ? { [field!]: id } : level.item
      // `{"field":id}`: the braces, the field's JSON, a colon and the id's.
      const itemLength = keyed ? lengthOf(id) + JSON.stringify(field).length + 3 : lengthOf(item)
      if (itemLength < 0 || (keyed && lengthOf(id) < 0)) return []
      length += (levels.length > 0 ? 1 : 0) + 4 + String(level.depth).length + itemLength + String(level.length).length
      if (length > MAX_STORED_LEVELS) return []
      levels.push([level.depth, item, level.length])
    }
    return levels
  }

  const isSecret = (edit: Edit) => isSecretPath(edit.path) || coveredBy(secrets, edit.tokens)
  // Whether an edit is the kind that is stored: JSON, and not a secret.
  const stored = (edit: Edit) => edit.persist && !isSecret(edit)

  // An edit as stored, without what it records of its action (see `overrides`).
  const entryOf = (edit: Edit, lengthOf: (value: unknown) => number): OverrideEntry => {
    const value = withoutSecrets(edit.value, edit.tokens, secrets)
    const against = edit.against === UNKNOWN ? UNKNOWN : edit.against.value
    if (against === UNKNOWN || (against !== undefined && !isJsonValue(against))) return [edit.path, value]
    // (The agent's values, here and in the levels, are the spec's own state, never something the user typed.)
    const levels = storable(edit, lengthOf)
    return [
      edit.path,
      value,
      { ...(against !== undefined ? { b: against } : {}), ...(levels.length > 0 ? { i: levels } : {}) },
    ]
  }

  // The stored edits (see MAX_OVERRIDES), with the number of their action among them (`a`, oldest first) when they are
  // of more than one action, so a reload keeps them in whole actions; an edit whose base is not known says so (`u`).
  const overrides = () => {
    if (persisted) return persisted
    const all = live().filter(stored)
    const entries = new Map<Edit, OverrideEntry>()
    const lengths = new WeakMap<object, number>()
    const lengthOf = (value: unknown) => {
      if (!isContainer(value)) return jsonLength(value, MAX_STORED_LEVELS)
      let known = lengths.get(value)
      if (known === undefined) lengths.set(value, (known = jsonLength(value, MAX_STORED_LEVELS)))
      return known
    }
    const entry = (edit: Edit) => {
      let known = entries.get(edit)
      if (!known) entries.set(edit, (known = entryOf(edit, lengthOf)))
      return known
    }
    // An edit's stored size in UTF-8 bytes with its separator, written out only when its value alone may fit.
    const sizeOf = (edit: Edit) =>
      edit.size > MAX_STORED_SIZE ? edit.size : utf8Length(JSON.stringify(entry(edit))) + 1
    const kept = storedActions(all, sizeOf)
    const chosen = all.filter((edit) => kept.has(edit.action))
    const numbers = new Map<number, number>()
    for (const edit of chosen) if (!numbers.has(edit.action)) numbers.set(edit.action, numbers.size)
    persisted = chosen.map((edit, index): OverrideEntry => {
      const [path, value, recorded] = entry(edit)
      // The first edit of each run of an action's edits says which action (when there is more than one).
      if (numbers.size <= 1 || (index > 0 && chosen[index - 1]!.action === edit.action))
        return recorded === undefined ? [path, value] : [path, value, recorded]
      return [path, value, { ...(recorded ?? { u: 1 }), a: numbers.get(edit.action)! }]
    })
    return persisted
  }

  const read = (path: string) => {
    if (!path || path === "/") return snapshot
    const tokens = parsePointer(path.startsWith("/") ? path : `/${path}`)
    return tokens ? getAt(snapshot, tokens) : undefined
  }

  const write = (entries: ReadonlyArray<readonly [path: string, value: unknown, size: number]>) => {
    if (entries.length === 0) return
    const made = currentAction()
    let next = snapshot
    let trimmed = false
    for (const [path, value, size] of entries) {
      if (!roomFor(path, size)) continue
      trimmed = record(path, value, made, undefined, undefined, size) || trimmed
      // The newest edit applies last, so applying it to the current snapshot equals composing everything again.
      if (!trimmed) next = replace(next, path, value)
    }
    if (trimmed) next = compose()
    if (next !== snapshot) {
      snapshot = next
      emit(subscribers)
    }
    emit(editListeners)
  }

  return {
    get: read,
    set(path, value) {
      const target = pointer(path)
      if (target === undefined || Object.is(read(target), value)) return
      const size = editSize(value)
      if (size > MAX_EDIT_SIZE) return
      write([[target, value, size]])
    },
    update(updates) {
      if (!isRecord(updates)) return
      const entries: Array<readonly [string, unknown, number]> = []
      let preview = snapshot
      for (const [path, value] of Object.entries(updates)) {
        const target = pointer(path)
        if (target === undefined) continue
        const tokens = parsePointer(target)!
        if (Object.is(getAt(preview, tokens), value)) continue
        const size = editSize(value)
        if (size > MAX_EDIT_SIZE) continue
        preview = replace(preview, target, value)
        entries.push([target, value, size])
      }
      write(entries)
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe(listener) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    setBase(state) {
      const next = isRecord(state) ? state : EMPTY_STATE
      if (next === layer && based) return
      layer = next
      based = true
      if (skipped) {
        skipped = false
        emit(skipListeners)
      }
      const before = unmatched
      const dropped = reconcile()
      if (unmatched !== before) emit(skipListeners)
      commit(compose())
      if (dropped) emit(editListeners)
    },
    setSecrets(patterns) {
      const key = JSON.stringify(patterns)
      if (key === secretKey) return
      secretKey = key
      declared = patterns.flatMap((pattern) => {
        const tokens = parsePointer(pattern)
        return tokens && tokens.length > 0 ? [tokens] : []
      })
      // Patterns declared earlier stay while there are edits they may cover.
      const known = new Set(declared.map((pattern) => pattern.join("/")))
      secrets =
        edits.length - dead === 0 ? declared : [...declared, ...secrets.filter((old) => !known.has(old.join("/")))]
      const before = persisted
      persisted = undefined
      // The stored copy follows when it held what is now known to be a secret.
      if (before && JSON.stringify(before) !== JSON.stringify(overrides())) emit(editListeners)
    },
    setItemKeys(declarations) {
      const key = JSON.stringify(declarations)
      if (key === keysKey) return
      keysKey = key
      keys = declarations.flatMap((declaration) => {
        const pattern = parsePointer(declaration.path)
        return pattern && pattern.length > 0 ? [{ pattern, key: declaration.key }] : []
      })
    },
    overrides,
    loadOverrides(entries) {
      // Edits that are never stored (secrets, values that are not JSON) are not in `entries`; they stay on top.
      const unstored = live().filter((edit) => !stored(edit))
      setEdits([])
      persisted = undefined
      // Loaded edits keep the actions they record (`a`), older than any made since: an edit that records none is of the
      // action of the edit before it, or, before any that records one (all of one action, or stored by an earlier
      // version), of one action of its own.
      const loadedActions = new Map<unknown, number>()
      let current: unknown = "none"
      const loadedAction = (stored: unknown) => {
        if (isRecord(stored) && Number.isInteger(stored.a)) current = stored.a
        const key = current
        let made = loadedActions.get(key)
        if (made === undefined) loadedActions.set(key, (made = -1 - loadedActions.size))
        return made
      }
      if (Array.isArray(entries))
        for (const entry of entries) {
          if (!Array.isArray(entry)) continue
          const target = pointer(entry[0])
          if (target === undefined || isSecretPath(target) || coveredBy(secrets, parsePointer(target)!)) continue
          const stored: unknown = entry[2]
          // An older entry did not record what it changed (or says it was not known): it takes the current state as its
          // base (and so do the list items its path goes through, when it did not record those).
          const against: Against =
            isRecord(stored) && !stored.u ? { value: Object.hasOwn(stored, "b") ? stored.b : undefined } : UNKNOWN
          const levels = isRecord(stored) ? storedLevels(stored.i, parsePointer(target)!) : undefined
          record(target, entry[1], loadedAction(stored), against, against === UNKNOWN ? undefined : levels)
        }
      for (const edit of unstored) record(edit.path, edit.value, edit.action, edit.against, edit.levels, edit.size)
      const before = unmatched
      reconcile()
      if (unmatched !== before) emit(skipListeners)
      commit(compose())
    },
    reset() {
      secrets = declared
      if (edits.length - dead === 0) return
      setEdits([])
      persisted = undefined
      commit(layer)
      emit(editListeners)
    },
    noteSkipped() {
      if (skipped) return
      skipped = true
      emit(skipListeners)
    },
    skippedWork: () => skipped,
    editsUnmatched: () => unmatched,
    onSkippedWork(listener) {
      skipListeners.add(listener)
      return () => {
        skipListeners.delete(listener)
      }
    },
    dispose() {
      if (!inWindow) return
      windowLiveSize -= liveSize
      inWindow = false
    },
    onOverridesChange(listener) {
      editListeners.add(listener)
      return () => {
        editListeners.delete(listener)
      }
    },
  }
}
