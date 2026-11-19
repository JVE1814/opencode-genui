import { createEffect, on, onCleanup, untrack, type Accessor } from "solid-js"
import { readSurfaceOverrides, writeSurfaceOverrides, type PersistedSession } from "../runtime/snapshot.ts"
import type { SurfaceRuntime } from "../runtime/surfaces.ts"

/** The session store the GUI declares (`ctx.stores.session(session)`), as persistence reads and writes it. */
export interface SessionStore {
  /** Undefined until the session's store has loaded. */
  readonly value: PersistedSession | undefined
  ready(): boolean
  set(next: PersistedSession): void
}

/** How long edits wait before they are written, so typing does not write on every key. */
export const SURFACE_SAVE_DELAY_MS = 500

// Runtimes whose persisted edits were loaded, with the entry they were loaded from. A runtime outlives its components
// (timeline rows remount), and after the first load its own edits are newer than the stored copy.
const hydrated = new WeakMap<SurfaceRuntime, string>()

// Writes waiting for their delay, so a reload or the plugin going away can flush them first.
const pending = new Set<() => void>()

/** Writes every pending surface edit now (before a reload, or when the plugin goes away). */
export function flushSurfaceWrites(): void {
  for (const flush of [...pending]) flush()
}

/** Updates the stored value with `write` if the store is ready and the result differs. */
export function writeStore(store: SessionStore | undefined, write: (value: PersistedSession) => PersistedSession) {
  if (!store?.ready()) return
  const current = store.value
  if (!current) return
  const next = write(current)
  if (next !== current) store.set(next)
}

/** The persisted entry id of a surface: canvases keep their edits per generation, so a replaced canvas starts clean. */
export function surfaceEntry(kind: "inline" | "canvas", id: string, generation?: number): string {
  return kind === "canvas" ? `canvas/${id}@${generation ?? 0}` : `inline/${id}`
}

/**
 * Keeps a surface runtime's user edits in the session store. Call it in the component that renders the surface; it
 * stops with that component's owner.
 *
 * - The first time a runtime is used in this window, the stored edits for `entry()` are loaded into its store, once
 *   the session store is ready.
 * - Each change of the edits is written after SURFACE_SAVE_DELAY_MS (and right away when the component goes away).
 * - When `entry()` changes (a canvas's new generation), the store's edits are reset and the old entry is deleted,
 *   then the new entry's edits (if any) are loaded.
 */
export function persistSurface(input: {
  readonly runtime: Accessor<SurfaceRuntime>
  readonly store: Accessor<SessionStore | undefined>
  /** The persisted entry id (`surfaceEntry`); undefined while it is not known yet. */
  readonly entry: Accessor<string | undefined>
}): void {
  // Load (or switch entries) once the session store is ready.
  createEffect(
    on(
      () => [input.runtime(), input.entry(), input.store()?.ready() ?? false] as const,
      ([runtime, entry, ready]) => {
        if (!ready || entry === undefined) return
        const store = untrack(input.store)
        const loaded = hydrated.get(runtime)
        if (loaded === entry) return
        if (loaded !== undefined) {
          // A new canvas generation: what the user typed belonged to the replaced UI.
          hydrated.delete(runtime)
          runtime.store.reset()
          writeStore(store, (value) => writeSurfaceOverrides(value, loaded, []))
        }
        // Edits made before the store was ready (rare: it loads within a tick) win over the stored copy.
        if (runtime.store.overrides().length === 0)
          runtime.store.loadOverrides(readSurfaceOverrides(store?.value, entry))
        hydrated.set(runtime, entry)
      },
    ),
  )

  // Writes follow the runtime (and the store) that changed: a group render that switches canvases, or a session
  // switch, must not send one surface's edits to another's entry.
  createEffect(
    on(input.runtime, (runtime) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let store: SessionStore | undefined
      const write = () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        pending.delete(write)
        const entry = hydrated.get(runtime)
        if (entry === undefined) return
        const overrides = runtime.store.overrides()
        writeStore(store, (value) => writeSurfaceOverrides(value, entry, overrides))
      }
      const stop = runtime.store.onOverridesChange(() => {
        store = untrack(input.store)
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(write, SURFACE_SAVE_DELAY_MS)
        pending.add(write)
      })
      onCleanup(() => {
        stop()
        if (pending.has(write)) write()
      })
    }),
  )
}
