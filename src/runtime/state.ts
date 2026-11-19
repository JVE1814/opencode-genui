import type { StateModel, StateStore } from "@json-render/core"
import { jsonEqual } from "../protocol/fold.ts"
import { applyPatch, getAt, parsePointer } from "../protocol/patch.ts"

/**
 * A json-render state store with two layers: the agent's state from the spec (the base) and the user's edits on top.
 * The renderer reads the merged snapshot; the edits are what the GUI persists, so a re-fold of the spec or a remount
 * keeps what the user typed, and a new canvas generation can drop them.
 */
export interface TrackedStore extends StateStore {
  /** Sets the agent's state from the spec. A no-op for the same object; subscribers hear only a real change. */
  setBase(state: Record<string, unknown> | undefined): void
  /** The user's edits in the order they apply, without values that cannot be stored as JSON. */
  overrides(): ReadonlyArray<readonly [path: string, value: unknown]>
  /** Restores persisted edits, replacing the current ones. Does not call `onOverridesChange` listeners. */
  loadOverrides(entries: ReadonlyArray<readonly [string, unknown]>): void
  /** Drops the user's edits (and tells `onOverridesChange` listeners, so the persisted copy goes too). */
  reset(): void
  onOverridesChange(listener: () => void): () => void
}

export const MAX_OVERRIDES = 500

const EMPTY_STATE: StateModel = Object.freeze({}) as StateModel

interface Edit {
  readonly path: string
  readonly value: unknown
  readonly persist: boolean
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
  let edits: Edit[] = []
  let snapshot: StateModel = layer
  let persisted: ReadonlyArray<readonly [string, unknown]> | undefined
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

  // A write replaces earlier edits of the same path and of everything under it. Returns whether old edits were dropped
  // for the cap, which means the snapshot must be composed again.
  const record = (path: string, value: unknown) => {
    const prefix = `${path}/`
    edits = edits.filter((edit) => edit.path !== path && !edit.path.startsWith(prefix))
    edits.push({ path, value, persist: isJsonValue(value) })
    persisted = undefined
    if (edits.length <= MAX_OVERRIDES) return false
    edits = edits.slice(edits.length - MAX_OVERRIDES)
    return true
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
      if (next === layer) return
      layer = next
      commit(compose())
    },
    overrides() {
      persisted ??= edits.filter((edit) => edit.persist).map((edit) => [edit.path, edit.value] as const)
      return persisted
    },
    loadOverrides(entries) {
      edits = []
      persisted = undefined
      if (Array.isArray(entries))
        for (const entry of entries) {
          if (!Array.isArray(entry)) continue
          const target = pointer(entry[0])
          if (target !== undefined) record(target, entry[1])
        }
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
