import type { SurfaceKind } from "../protocol/surface.ts"
import { createTrackedStore, type TrackedStore } from "./state.ts"

/**
 * What a rendered surface keeps outside its components. Timeline rows unmount when they scroll off screen and canvas
 * tabs remount, so the UI state (and the last measured height, to avoid layout jumps) lives here, keyed by session and
 * surface, and survives for the window's lifetime.
 */
export interface SurfaceRuntime {
  readonly key: string
  readonly store: TrackedStore
  /** The surface's last rendered height in pixels, reserved while it remounts. */
  height?: number
  /** The canvas generation the store's edits belong to; a new generation resets them. */
  generation?: number
  /**
   * UI state components keep per element besides the state store (which sections of an Accordion or Collapsible are
   * open), so a remount shows what the user left. In memory only; a new canvas generation clears it.
   */
  readonly memory: Map<string, unknown>
  /**
   * For the shared runtime of an agent block id: the content id (`contentId`) of the block that drives it now, so a
   * re-sent block that takes over can hand the edits to the copy it replaces (see handOverInline in src/gui/persist.ts).
   */
  driver?: string
}

export const MAX_SURFACES = 200

// Insertion order is recency: a hit moves the entry to the end, eviction takes the first.
const surfaces = new Map<string, SurfaceRuntime>()

/** The prefix every surface key of a session starts with, for `clearSurfaces`. */
export const surfaceKeyPrefix = (sessionKey: string | undefined) => `${sessionKey ?? "-"}/`

export function surfaceKey(sessionKey: string | undefined, kind: SurfaceKind, id: string): string {
  return `${surfaceKeyPrefix(sessionKey)}${kind}/${id}`
}

/** The surface's runtime, created on first use. The least recently used one goes once there are more than 200. */
export function getSurface(key: string): SurfaceRuntime {
  const existing = surfaces.get(key)
  if (existing) {
    surfaces.delete(key)
    surfaces.set(key, existing)
    return existing
  }
  const created: SurfaceRuntime = { key, store: createTrackedStore(), memory: new Map() }
  surfaces.set(key, created)
  for (const oldest of surfaces.keys()) {
    if (surfaces.size <= MAX_SURFACES) break
    surfaces.delete(oldest)
  }
  return created
}

/** The surface's runtime if it exists, without creating it or marking it used. */
export function peekSurface(key: string): SurfaceRuntime | undefined {
  return surfaces.get(key)
}

/** Forgets every surface, or those whose key matches. */
export function clearSurfaces(predicate?: (key: string) => boolean): void {
  if (!predicate) {
    surfaces.clear()
    return
  }
  for (const key of [...surfaces.keys()]) if (predicate(key)) surfaces.delete(key)
}
