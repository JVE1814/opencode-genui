import type { StateModel, StateStore } from "@json-render/core"
import { jsonEqual } from "../protocol/fold.ts"
import { applyPatch, getAt, parsePointer } from "../protocol/patch.ts"
import { UI_SECRET_ROOT } from "../shared/constants.ts"
import type { ItemKey } from "./item-keys.ts"

/**
 * One persisted user edit: its path, its value and, when known, the agent's value at that path when the user made it
 * (`b`, absent for none) and the array items its path goes through (`i`, see `Level`). Entries without the third member
 * come from an older version.
 */
export type OverrideEntry =
  | readonly [path: string, value: unknown]
  | readonly [path: string, value: unknown, against: { readonly b?: unknown; readonly i?: readonly StoredLevel[] }]

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
   * Secrets the user typed live in memory only.
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
  onOverridesChange(listener: () => void): () => void
}

export const MAX_OVERRIDES = 500

/**
 * How large a value one edit may write, in characters of its strings plus entries of its lists and objects. A larger
 * one is ignored: a pair of watches can double a string on every round (`{"$template":"${/a}${/a}"}`), which reached a
 * billion characters, and the window ran out of memory, before any other bound stopped it.
 */
export const MAX_EDIT_SIZE = 1_000_000

/** Whether a value is larger than MAX_EDIT_SIZE (see there); the walk stops once it is. */
export function tooLarge(value: unknown): boolean {
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
    if (size > MAX_EDIT_SIZE) return true
  }
  return false
}

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

// Whether two items are the same apart from the member at `rest` (an empty `rest`: the whole values).
function sameExcept(a: unknown, b: unknown, rest: readonly string[]): boolean {
  if (rest.length === 0) return jsonEqual(a, b)
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false
  const [head, ...tail] = rest
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key !== head) {
      if (!jsonEqual(own(a, key), own(b, key))) return false
    } else if (tail.length > 0 && !sameExcept(own(a, key), own(b, key), tail)) return false
  }
  return true
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
  let edits: Edit[] = []
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

  const compose = () => edits.reduce((doc, edit) => replace(doc, edit.path, edit.value), layer)

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
          ? (item: unknown) => jsonEqual(own(item, field!), id)
          : (item: unknown) => sameExcept(item, level.item, rest)
      let at: number | undefined
      if (index < list.length && (Object.is(list[index], level.item) || same(list[index]))) at = index
      else {
        // The nearest equal item: a list of equal items keeps the edit where it was.
        for (let other = 0; other < list.length; other++)
          if (same(list[other]) && (at === undefined || Math.abs(other - index) < Math.abs(at - index))) at = other
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

  // A write replaces earlier edits of the same path and of everything under it. Returns whether old edits were dropped
  // for the cap, which means the snapshot must be composed again.
  const record = (path: string, value: unknown, against?: Against, levels?: Level[]) => {
    const prefix = `${path}/`
    const tokens = parsePointer(path)!
    edits = edits.filter((edit) => edit.path !== path && !edit.path.startsWith(prefix))
    edits.push({
      path,
      tokens,
      value,
      persist: isJsonValue(value),
      against: against ?? baseAt(tokens),
      levels: levels ?? (based ? levelsAt(tokens) : undefined),
    })
    persisted = undefined
    if (edits.length <= MAX_OVERRIDES) return false
    edits = edits.slice(edits.length - MAX_OVERRIDES)
    return true
  }

  // Newest writer wins: drops the edits whose path the agent's state changed since the user made them, and the later
  // edits under their paths; an edit of a list item first follows its item (see `follow`). Edits that did not know their
  // base yet take the current one (which only refreshes the stored form). Returns whether any edit changed (dropped,
  // moved, or the items it follows), so the stored copy can follow.
  const reconcile = () => {
    if (!based) return false
    const dropped: string[] = []
    let changed = false
    let stale = false
    const kept = edits.filter((edit) => {
      // An edit made on top of a dropped one (under its path, later) goes too.
      if (dropped.some((path) => edit.path.startsWith(`${path}/`))) return false
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
      if (tokens === undefined || !jsonEqual(edit.against.value, getAt(layer, tokens))) {
        dropped.push(edit.path)
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
    if (stale) persisted = undefined
    if (!changed && kept.length === edits.length) return false
    edits = kept
    persisted = undefined
    return true
  }

  // An edit's levels as stored: an item of a keyed list as its key alone, others whole. Levels too big to store (an
  // outer item holding a long list) are left out; the edit then takes the items at its path when it loads.
  const storable = (edit: Edit): StoredLevel[] => {
    const levels = (edit.levels ?? []).map((level): StoredLevel => {
      const field = keyOf(edit.tokens.slice(0, level.depth))
      const id = field === undefined ? undefined : own(level.item, field)
      return [level.depth, id !== undefined && id !== null ? { [field!]: id } : level.item, level.length]
    })
    if (!levels.every((level) => isJsonValue(level[1]))) return []
    return JSON.stringify(levels).length <= MAX_STORED_LEVELS ? levels : []
  }

  const isSecret = (edit: Edit) => isSecretPath(edit.path) || coveredBy(secrets, edit.tokens)
  // Whether an edit is the kind that is stored: JSON, and not a secret.
  const stored = (edit: Edit) => edit.persist && !isSecret(edit)

  const overrides = () => {
    persisted ??= edits.filter(stored).map((edit): OverrideEntry => {
      const value = withoutSecrets(edit.value, edit.tokens, secrets)
      const against = edit.against === UNKNOWN ? UNKNOWN : edit.against.value
      if (against === UNKNOWN || (against !== undefined && !isJsonValue(against))) return [edit.path, value]
      // (The agent's values, here and in the levels, are the spec's own state, never something the user typed.)
      const levels = storable(edit)
      return [
        edit.path,
        value,
        { ...(against !== undefined ? { b: against } : {}), ...(levels.length > 0 ? { i: levels } : {}) },
      ]
    })
    return persisted
  }

  const read = (path: string) => {
    if (!path || path === "/") return snapshot
    const tokens = parsePointer(path.startsWith("/") ? path : `/${path}`)
    return tokens ? getAt(snapshot, tokens) : undefined
  }

  const write = (entries: ReadonlyArray<readonly [string, unknown]>) => {
    if (entries.length === 0) return
    let next = snapshot
    let trimmed = false
    for (const [path, value] of entries) {
      trimmed = record(path, value) || trimmed
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
      if (target === undefined || Object.is(read(target), value) || tooLarge(value)) return
      write([[target, value]])
    },
    update(updates) {
      if (!isRecord(updates)) return
      const entries: Array<readonly [string, unknown]> = []
      let preview = snapshot
      for (const [path, value] of Object.entries(updates)) {
        const target = pointer(path)
        if (target === undefined) continue
        const tokens = parsePointer(target)!
        if (Object.is(getAt(preview, tokens), value) || tooLarge(value)) continue
        preview = replace(preview, target, value)
        entries.push([target, value])
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
      const dropped = reconcile()
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
      secrets = edits.length === 0 ? declared : [...declared, ...secrets.filter((old) => !known.has(old.join("/")))]
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
      const unstored = edits.filter((edit) => !stored(edit))
      edits = []
      persisted = undefined
      if (Array.isArray(entries))
        for (const entry of entries) {
          if (!Array.isArray(entry)) continue
          const target = pointer(entry[0])
          if (target === undefined || isSecretPath(target) || coveredBy(secrets, parsePointer(target)!)) continue
          const stored: unknown = entry[2]
          // An older entry did not record what it changed: it takes the current state as its base (and so do the list
          // items its path goes through, when it did not record those).
          const against: Against = isRecord(stored)
            ? { value: Object.hasOwn(stored, "b") ? stored.b : undefined }
            : UNKNOWN
          const levels = isRecord(stored) ? storedLevels(stored.i, parsePointer(target)!) : undefined
          record(target, entry[1], against, against === UNKNOWN ? undefined : levels)
        }
      for (const edit of unstored) record(edit.path, edit.value, edit.against, edit.levels)
      reconcile()
      commit(compose())
    },
    reset() {
      secrets = declared
      if (edits.length === 0) return
      edits = []
      persisted = undefined
      commit(layer)
      emit(editListeners)
    },
    onOverridesChange(listener) {
      editListeners.add(listener)
      return () => {
        editListeners.delete(listener)
      }
    },
  }
}
