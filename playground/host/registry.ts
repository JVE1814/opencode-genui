import {
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
  useContext,
  type Accessor,
} from "solid-js"
import type { Cleanup, Registry } from "@opencode/plugin/gui"
import { LifetimeContext } from "../fake-sdk/internal.ts"

/** One contribution as the host sees it: the plugin that made it, and its current value. */
export interface Item<T> {
  readonly plugin: string
  readonly value: T
}

interface Entry {
  readonly id: number
  readonly plugin: string
  readonly registry: string
  readonly value: Accessor<unknown>
}

/**
 * Every plugin's contributions, by registry, in contribution order. Reactive. An item given as a function is
 * re-evaluated when what it reads changes; undefined withdraws it until it returns one again.
 */
export interface Contributions {
  add<T>(plugin: string, registry: Registry<T>, item: T | (() => T | undefined), lifetime: Lifetime): Cleanup
  items<T>(registry: Registry<T>): readonly Item<T>[]
}

/** Where a contribution's cleanup goes when no Solid owner is current (after an `await`). */
export interface Lifetime {
  onDispose(cleanup: () => void): void
  readonly disposed: boolean
}

export function createContributions(): Contributions {
  const [entries, setEntries] = createSignal<readonly Entry[]>([])
  const cache = new WeakMap<Entry, { value: unknown; item: Item<unknown> }>()
  let next = 0

  return {
    add(plugin, registry, item, lifetime) {
      const owner = getOwner()
      const scope = owner ? untrack(() => runWithOwner(owner, () => useContext(LifetimeContext))) : undefined
      let disposeValue: (() => void) | undefined
      let value: Accessor<unknown>
      if (typeof item === "function") {
        const read = item as () => unknown
        // A root under the current owner keeps the owner's context (usePlugin) and ends with the registration.
        value = createRoot((dispose) => {
          disposeValue = dispose
          return createMemo(read)
        }, owner ?? undefined)
      } else value = () => item

      const entry: Entry = { id: next++, plugin, registry: registry.id, value }
      setEntries((list) => [...list, entry])

      let removed = false
      const remove = () => {
        if (removed) return
        removed = true
        setEntries((list) => list.filter((candidate) => candidate !== entry))
        disposeValue?.()
      }

      // Made after its owner or the plugin ended: withdrawn at once.
      if (lifetime.disposed || scope?.ended) remove()
      else if (owner) runWithOwner(owner, () => onCleanup(remove))
      else lifetime.onDispose(remove)
      return remove
    },
    items<T>(registry: Registry<T>) {
      const result: Item<T>[] = []
      for (const entry of entries()) {
        if (entry.registry !== registry.id) continue
        const value = entry.value()
        if (value === undefined) continue
        // The same Item object while the value is unchanged, so consumers can compare by identity.
        const known = cache.get(entry)
        if (known && known.value === value) {
          result.push(known.item as Item<T>)
          continue
        }
        const item = { plugin: entry.plugin, value: value as T }
        cache.set(entry, { value, item })
        result.push(item)
      }
      return result
    },
  }
}

/** A memo of one registry's items, for components that read them often. */
export function useItems<T>(contributions: Contributions, registry: Registry<T>): Accessor<readonly Item<T>[]> {
  return createMemo(() => contributions.items(registry), [], {
    equals: (a, b) => a.length === b.length && a.every((item, index) => item === b[index]),
  })
}
