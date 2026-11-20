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

/**
 * The state arrays the spec's repeats iterate with a `key`, so a user's edit of an item can follow that item when the
 * agent inserts, removes or moves items around it (see TrackedStore.setItemKeys). A nested repeat over a field of the
 * enclosing item (`"statePath": { "$item": "files" }`) gives a pattern with `*` for the enclosing item's index.
 */
export function itemKeys(spec: Spec | null | undefined): readonly ItemKey[] {
  if (!isRecord(spec) || !isRecord(spec.elements)) return NO_KEYS
  const cached = cache.get(spec)
  if (cached) return cached
  const elements = spec.elements as Record<string, UIElement>
  const parents = new Map<string, string[]>()
  for (const [key, element] of Object.entries(elements))
    for (const child of Array.isArray(element?.children) ? element.children : [])
      if (typeof child === "string") parents.set(child, [...(parents.get(child) ?? []), key])

  // The state path patterns of the arrays an element repeats over (none when it has no repeat).
  const arrays = (key: string, seen: Set<string>): string[] => {
    const repeat: unknown = elements[key]?.repeat
    const statePath = isRecord(repeat) ? repeat.statePath : undefined
    if (typeof statePath === "string") return statePath ? [absolute(statePath)] : []
    if (!isRecord(statePath) || typeof statePath.$item !== "string") return []
    const field = statePath.$item ? `/${statePath.$item}` : ""
    return items(key, seen).map((base) => `${base}${field}`)
  }
  // The item path patterns of the repeats an element renders inside.
  const items = (key: string, seen: Set<string>): string[] => {
    const result: string[] = []
    for (const parent of parents.get(key) ?? []) {
      if (seen.has(parent)) continue
      const next = new Set(seen).add(parent)
      const own = arrays(parent, next)
      result.push(...(own.length > 0 ? own.map((path) => `${path}/*`) : items(parent, next)))
    }
    return result
  }

  const found = new Map<string, ItemKey>()
  for (const [key, element] of Object.entries(elements)) {
    const repeat: unknown = element?.repeat
    if (!isRecord(repeat) || typeof repeat.key !== "string" || !repeat.key) continue
    for (const path of arrays(key, new Set([key]))) found.set(`${path}\n${repeat.key}`, { path, key: repeat.key })
  }
  const result = found.size === 0 ? NO_KEYS : Object.freeze([...found.values()])
  cache.set(spec, result)
  return result
}
