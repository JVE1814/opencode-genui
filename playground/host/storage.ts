import { createSignal } from "solid-js"
import { Schema } from "effect"
import type { Persisted, StoreDeclaration } from "@opencode/plugin/gui"

/**
 * Where the fake host keeps stored values: memory, mirrored to sessionStorage so a page reload (the playground's
 * "restart the app") keeps them, while a new tab or a Playwright context starts empty. `?persist=0` turns the mirror off.
 */
export interface Backend {
  read(key: string): unknown
  write(key: string, value: unknown): void
  remove(key: string): void
  clear(): void
}

const PREFIX = "genui-playground:"

export function createBackend(persist: boolean): Backend {
  const memory = new Map<string, unknown>()
  const session = persist ? safeSessionStorage() : undefined

  return {
    read(key) {
      if (memory.has(key)) return memory.get(key)
      const raw = session?.getItem(PREFIX + key)
      if (raw === null || raw === undefined) return undefined
      try {
        const value = JSON.parse(raw) as unknown
        memory.set(key, value)
        return value
      } catch {
        return undefined
      }
    },
    write(key, value) {
      memory.set(key, value)
      try {
        session?.setItem(PREFIX + key, JSON.stringify(value))
      } catch {
        // Quota or serialization problems only lose the reload copy.
      }
    },
    remove(key) {
      memory.delete(key)
      session?.removeItem(PREFIX + key)
    },
    clear() {
      memory.clear()
      if (!session) return
      for (const key of Object.keys(session)) if (key.startsWith(PREFIX)) session.removeItem(key)
    },
  }
}

function safeSessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

type Codec = Schema.ConstraintCodec<object, unknown>

/**
 * Decodes a stored JSON value as the app does: the whole value through the schema; failing that, a plain object merged
 * over `initial` (so a missing or broken field takes its initial value); failing that, `initial`.
 */
export function decodeStored<T>(schema: Codec, initial: T, raw: unknown): T {
  if (raw === undefined) return initial
  const decode = Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>)
  try {
    return decode(raw) as T
  } catch {
    // Fall through to the field-wise attempt.
  }
  if (isRecord(raw) && isRecord(initial)) {
    const merged: Record<string, unknown> = { ...initial }
    for (const [key, value] of Object.entries(raw)) {
      try {
        decode({ ...merged, [key]: value })
        merged[key] = value
      } catch {
        // Keep the initial value of a field that does not decode.
      }
    }
    try {
      return decode(merged) as T
    } catch {
      return initial
    }
  }
  return initial
}

function encodeStored(schema: Codec, value: unknown): unknown {
  try {
    return Schema.encodeUnknownSync(schema as unknown as Schema.ConstraintEncoder<unknown>)(value)
  } catch {
    return structuredClone(value)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * One stored value with the app's `Persisted` semantics: `value` is undefined until it loads (unless `loaded`), writes
 * made before then wait and apply in call order, `update` edits a deep copy and must not return a value.
 */
export function createPersisted<T>(input: {
  readonly backend: Backend
  readonly key: string
  readonly schema: Codec
  readonly initial: T
  readonly from?: string | readonly string[]
  /** Load synchronously (global stores load before setup). Otherwise the value loads on a later tick. */
  readonly loaded: boolean
  readonly onWrite?: (key: string, value: T) => void
}): Persisted<T> {
  const [value, setValue] = createSignal<T | undefined>(undefined, { equals: false })
  const [ready, setReady] = createSignal(false)
  const queue: Array<(current: T) => T> = []

  const read = (): T => {
    let raw = input.backend.read(input.key)
    if (raw === undefined && input.from) {
      for (const older of typeof input.from === "string" ? [input.from] : input.from) {
        raw = input.backend.read(older)
        if (raw !== undefined) break
      }
    }
    return decodeStored(input.schema, input.initial, raw)
  }

  const commit = (next: T) => {
    setValue(() => next)
    input.backend.write(input.key, encodeStored(input.schema, next))
    input.onWrite?.(input.key, next)
  }

  const load = () => {
    let current = read()
    setValue(() => current)
    setReady(true)
    if (queue.length === 0) return
    for (const apply of queue.splice(0)) current = apply(current)
    commit(current)
  }

  if (input.loaded) load()
  else setTimeout(load, 0)

  const write = (apply: (current: T) => T) => {
    if (!ready()) {
      queue.push(apply)
      return
    }
    commit(apply(value() as T))
  }

  return {
    get value() {
      return value() as T
    },
    ready,
    update(mutate) {
      write((current) => {
        const draft = structuredClone(current) as Parameters<typeof mutate>[0]
        const result = (mutate as (draft: unknown) => unknown)(draft)
        if (result !== undefined) throw new Error("Persisted.update: return nothing; use set() to replace the value")
        return draft as T
      })
    },
    set(next) {
      write(() => next)
    },
  }
}

/** The stored key of a declared store, as the app names it. */
export const storeKey = (plugin: string, name: string, scope?: string) =>
  scope === undefined ? `plugin.${plugin}.${name}` : `plugin.${plugin}.${name}@${scope}`

export type AnyStoreDeclaration = StoreDeclaration
