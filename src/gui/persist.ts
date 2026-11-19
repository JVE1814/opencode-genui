import { createEffect, on, onCleanup, untrack, type Accessor } from "solid-js"
import { readSurfaceOverrides, writeSurfaceOverrides, type PersistedSession } from "../runtime/snapshot.ts"
import { contentId } from "../protocol/digest.ts"
import type { ParsedBlock } from "../protocol/surface.ts"
import type { SurfaceRuntime } from "../runtime/surfaces.ts"

type Draft = { -readonly [K in keyof PersistedSession]: PersistedSession[K] }

/** The session store the GUI declares (`ctx.stores.session(session)`), as persistence reads and writes it. */
export interface SessionStore {
  /** Undefined until the session's store has loaded. */
  readonly value: PersistedSession | undefined
  ready(): boolean
  set(next: PersistedSession): void
  /** Edits a draft of the value; before the store has loaded, it waits for the load and applies in call order. */
  update(mutate: (draft: Draft) => undefined): void
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

/**
 * Updates the stored value with `write` if the store is ready and the result differs. For writes computed from what
 * is loaded; a write that must reach a store not loaded yet uses `update` (see `clearStoredSurfaces`).
 */
export function writeStore(store: SessionStore | undefined, write: (value: PersistedSession) => PersistedSession) {
  if (!store?.ready()) return
  const current = store.value
  if (!current) return
  const next = write(current)
  if (next !== current) store.set(next)
}

/** Forgets every stored surface edit of the session, also when its store has not loaded yet (the write waits for it). */
export function clearStoredSurfaces(store: SessionStore): void {
  store.update((draft) => {
    if (Object.keys(draft.surfaces ?? {}).length > 0) draft.surfaces = {}
    return undefined
  })
}

/**
 * Runs `flush` when the plugin goes away. The host aborts the plugin's signal first, then disposes its session stores,
 * and only then its root, where `onCleanup` runs: writes made from an `onCleanup` reach a disposed store and are
 * dropped. Returns a function that removes the listener.
 */
export function flushOnAbort(signal: AbortSignal, flush: () => void): () => void {
  if (signal.aborted) return () => {}
  signal.addEventListener("abort", flush, { once: true })
  return () => signal.removeEventListener("abort", flush)
}

/** The persisted entry id of a surface: canvases keep their edits per generation, so a replaced canvas starts clean. */
export function surfaceEntry(kind: "inline" | "canvas", id: string, generation?: number): string {
  return kind === "canvas" ? `canvas/${id}@${generation ?? 0}` : `inline/${id}`
}

/**
 * Where an inline block's UI state lives, decided by provenance and content, never by the block's say-so alone:
 * - a block that is not the agent's own (tool output, a file preview) gets a store of its own, keyed by its content (a
 *   SHA-256 digest), so a header `id` can never reach the state (or the stored edits) of the agent's surface with that
 *   id, and two different blocks never share one;
 * - the agent's blocks share their state by header id, so a re-sent block keeps what the user typed, but only the
 *   newest block of an id drives it: an older copy gets a store of its own, so the two never fight over the state;
 * - an agent block without an id is keyed by its content.
 *
 * The id is used for the runtime and the stored entry alike; when a block's trust or newness flips, it remounts on the
 * other store.
 */
export function inlineSurfaceId(
  block: Pick<ParsedBlock, "header" | "text">,
  trusted: boolean,
  newest: boolean,
): string {
  // Content keys use a digest that cannot be collided on purpose (the block's FNV hash can be, in milliseconds).
  if (!trusted) return `untrusted/${contentId(block.text)}`
  const id = block.header.id
  if (id === undefined) return `trusted/${contentId(block.text)}`
  return newest ? `trusted/${id}` : `trusted/${id}@${contentId(block.text)}`
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
        if (runtime.store.overrides().length === 0) {
          const stored = readSurfaceOverrides(store?.value, entry)
          runtime.store.loadOverrides(stored)
          // Edits the agent has overwritten since (or secrets an older version stored) leave the stored copy too.
          const kept = runtime.store.overrides()
          if (kept.length !== stored.length) writeStore(store, (value) => writeSurfaceOverrides(value, entry, kept))
        }
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
