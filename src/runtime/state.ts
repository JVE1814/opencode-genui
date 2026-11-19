import type { StateModel, StateStore } from "@json-render/core"
import { jsonEqual } from "../protocol/fold.ts"
import { applyPatch, getAt, parsePointer } from "../protocol/patch.ts"
import { UI_SECRET_ROOT } from "../shared/constants.ts"

/**
 * One persisted user edit: its path, its value and, when known, the agent's value at that path when the user made it
 * (`{ b }`, or `{}` for none). Entries without the third member come from an older version.
 */
export type OverrideEntry =
  | readonly [path: string, value: unknown]
  | readonly [path: string, value: unknown, against: { readonly b?: unknown }]

/**
 * A json-render state store with two layers: the agent's state from the spec (the base) and the user's edits on top.
 * The renderer reads the merged snapshot; the edits are what the GUI persists, so a re-fold of the spec or a remount
 * keeps what the user typed, and a new canvas generation can drop them.
 *
 * The newest writer wins: an edit stays on top while the agent's value at its path is the one the user changed, and is
 * dropped once the agent writes a different value there (at the path, under it, or by replacing a parent). Edits the
 * user made under a dropped edit's path go with it: they were made on top of it, and would land on other data.
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

const EMPTY_STATE: StateModel = Object.freeze({}) as StateModel

/** The agent's value at an edit's path when the user made it; `UNKNOWN` until a base is known. */
type Against = { readonly value: unknown } | typeof UNKNOWN
const UNKNOWN = Symbol("unknown")

interface Edit {
  readonly path: string
  readonly tokens: readonly string[]
  readonly value: unknown
  readonly persist: boolean
  against: Against
}

const SECRET = `/${UI_SECRET_ROOT}`

/** Whether a state path is under the secret root, whose values are never persisted. */
export const isSecretPath = (path: string) => path === SECRET || path.startsWith(`${SECRET}/`)

/** A secret path pattern as tokens; `*` matches one segment, a leading `**` any number of them. */
type Pattern = readonly string[]

const ANY_DEPTH = "**"
const REMOVE = Symbol("remove")

const matches = (want: string, token: string) => want === "*" || want === token

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
  let secrets: readonly Pattern[] = []
  let secretKey = ""
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

  // A write replaces earlier edits of the same path and of everything under it. Returns whether old edits were dropped
  // for the cap, which means the snapshot must be composed again.
  const record = (path: string, value: unknown, against?: Against) => {
    const prefix = `${path}/`
    const tokens = parsePointer(path)!
    edits = edits.filter((edit) => edit.path !== path && !edit.path.startsWith(prefix))
    edits.push({ path, tokens, value, persist: isJsonValue(value), against: against ?? baseAt(tokens) })
    persisted = undefined
    if (edits.length <= MAX_OVERRIDES) return false
    edits = edits.slice(edits.length - MAX_OVERRIDES)
    return true
  }

  // Newest writer wins: drops the edits whose path the agent's state changed since the user made them, and the later
  // edits under their paths. Edits that did not know their base yet take the current one. Returns whether any edit was
  // dropped.
  const reconcile = () => {
    if (!based) return false
    const dropped: string[] = []
    const kept = edits.filter((edit) => {
      // An edit made on top of a dropped one (under its path, later) goes too.
      if (dropped.some((path) => edit.path.startsWith(`${path}/`))) return false
      const now = getAt(layer, edit.tokens)
      if (edit.against === UNKNOWN) {
        edit.against = { value: now }
        return true
      }
      if (jsonEqual(edit.against.value, now)) return true
      dropped.push(edit.path)
      return false
    })
    if (kept.length === edits.length) return false
    edits = kept
    persisted = undefined
    return true
  }

  const isSecret = (edit: Edit) => isSecretPath(edit.path) || coveredBy(secrets, edit.tokens)
  // Whether an edit is the kind that is stored: JSON, and not a secret.
  const stored = (edit: Edit) => edit.persist && !isSecret(edit)

  const overrides = () => {
    persisted ??= edits.filter(stored).map((edit): OverrideEntry => {
      const value = withoutSecrets(edit.value, edit.tokens, secrets)
      const against = edit.against === UNKNOWN ? UNKNOWN : edit.against.value
      if (against === undefined) return [edit.path, value, {}]
      if (against === UNKNOWN || !isJsonValue(against)) return [edit.path, value]
      // (The agent's value is the spec's own state, never something the user typed.)
      return [edit.path, value, { b: against }]
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
      if (target === undefined || Object.is(read(target), value)) return
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
        if (Object.is(getAt(preview, tokens), value)) continue
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
      secrets = patterns.flatMap((pattern) => {
        const tokens = parsePointer(pattern)
        return tokens && tokens.length > 0 ? [tokens] : []
      })
      const before = persisted
      persisted = undefined
      // The stored copy follows when it held what is now known to be a secret.
      if (before && JSON.stringify(before) !== JSON.stringify(overrides())) emit(editListeners)
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
          // An older entry did not record what it changed: it takes the current state as its base.
          const against: Against = isRecord(stored)
            ? { value: Object.hasOwn(stored, "b") ? stored.b : undefined }
            : UNKNOWN
          record(target, entry[1], against)
        }
      for (const edit of unstored) record(edit.path, edit.value, edit.against)
      reconcile()
      commit(compose())
    },
    reset() {
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
