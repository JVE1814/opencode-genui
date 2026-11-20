import type { Spec, UIElement } from "@json-render/core"

/** A list the spec repeats over with a `repeat.key`: its state path as a pattern, and the item field that is its id. */
export interface ItemKey {
  /** `*` matches any one segment (an outer repeat's item index); a leading `**` any number of segments. */
  readonly path: string
  readonly key: string
}

const NO_KEYS: readonly ItemKey[] = Object.freeze([])
const cache = new WeakMap<object, readonly ItemKey[]>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const absolute = (path: string) => (path.startsWith("/") ? path : `/${path}`)

/** How many path patterns one element's items may have, and the whole spec's keys; more are left out (see itemKeys). */
const MAX_PATTERNS = 64

/**
 * The state arrays the spec's repeats iterate with a `key`, so a user's edit of an item can follow that item when the
 * agent inserts, removes or moves items around it (see TrackedStore.setItemKeys). A nested repeat over a field of the
 * enclosing item (`"statePath": { "$item": "files" }`) gives a pattern with `*` for the enclosing item's index.
 *
 * Each element's patterns are worked out once: a child listed many times (`"children": ["c", "c", ...]`) cost a copy of
 * its parent list per entry, and a lattice of elements that list each other's children had exponentially many paths.
 * An element (or the spec) with more than MAX_PATTERNS patterns keeps the first ones: an edit in a list left out
 * follows its item by content, as in a list without a key.
 */
export function itemKeys(spec: Spec | null | undefined): readonly ItemKey[] {
  if (!isRecord(spec) || !isRecord(spec.elements)) return NO_KEYS
  const cached = cache.get(spec)
  if (cached) return cached
  const elements = spec.elements as Record<string, UIElement>
  const parents = new Map<string, Set<string>>()
  for (const [key, element] of Object.entries(elements))
    for (const child of Array.isArray(element?.children) ? element.children : [])
      if (typeof child === "string") {
        let set = parents.get(child)
        if (!set) parents.set(child, (set = new Set()))
        set.add(key)
      }

  const arraysOf = new Map<string, readonly string[]>()
  const itemsOf = new Map<string, readonly string[]>()
  // An element whose patterns are being worked out: met again, it is its own ancestor (a cycle), and adds nothing.
  const open = new Set<string>()
  const capped = (patterns: Set<string>) => [...patterns].slice(0, MAX_PATTERNS)

  // The state path patterns of the arrays an element repeats over (none when it has no repeat).
  const arrays = (key: string): readonly string[] => {
    const known = arraysOf.get(key)
    if (known) return known
    const repeat: unknown = elements[key]?.repeat
    const statePath = isRecord(repeat) ? repeat.statePath : undefined
    let result: readonly string[] = []
    if (typeof statePath === "string") result = statePath ? [absolute(statePath)] : []
    else if (isRecord(statePath) && typeof statePath.$item === "string") {
      const field = statePath.$item ? `/${statePath.$item}` : ""
      result = items(key).map((base) => `${base}${field}`)
    }
    arraysOf.set(key, result)
    return result
  }
  // The item path patterns of the repeats an element renders inside.
  const items = (key: string): readonly string[] => {
    const known = itemsOf.get(key)
    if (known) return known
    if (open.has(key)) return []
    open.add(key)
    const result = new Set<string>()
    for (const parent of parents.get(key) ?? []) {
      if (open.has(parent)) continue
      const own = arrays(parent)
      for (const path of own.length > 0 ? own.map((path) => `${path}/*`) : items(parent)) {
        if (result.size >= MAX_PATTERNS) break
        result.add(path)
      }
    }
    open.delete(key)
    const list = capped(result)
    itemsOf.set(key, list)
    return list
  }

  const found = new Map<string, ItemKey>()
  for (const [key, element] of Object.entries(elements)) {
    const repeat: unknown = element?.repeat
    if (!isRecord(repeat) || typeof repeat.key !== "string" || !repeat.key) continue
    for (const path of arrays(key)) {
      if (found.size >= MAX_PATTERNS) break
      found.set(`${path}\n${repeat.key}`, { path, key: repeat.key })
    }
  }
  const result = found.size === 0 ? NO_KEYS : Object.freeze([...found.values()])
  cache.set(spec, result)
  return result
}
