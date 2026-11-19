import { createEffect, createMemo, createRoot, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { SessionRef } from "@opencode/plugin/gui"
import type { CanvasSnapshot } from "../protocol/fold.ts"
import { backfill } from "../runtime/backfill.ts"
import { createSessionIndex, type MessageLike, type SessionIndex } from "../runtime/session-index.ts"
import { readCanvasSnapshots, writeCanvasSnapshot } from "../runtime/snapshot.ts"
import { writeStore, type SessionStore } from "./persist.ts"

/** How long settled canvases wait before they are written, so a burst of closing blocks writes once. */
export const SNAPSHOT_SAVE_DELAY_MS = 300

/**
 * How long the index waits for the session's messages when it has snapshots, before it treats an empty transcript as
 * loaded. Until then, an empty list means "not loaded yet", and every snapshot would look newer than the transcript.
 */
export const MESSAGES_GRACE_MS = 4000

/** One session's canvas index and what keeps it in step with the store. Lives in its own reactive root. */
export interface SessionEntry {
  readonly key: string
  readonly index: SessionIndex
  /** The session's stored value (snapshots and surface edits). */
  readonly store: Accessor<SessionStore>
  /** A canvas's title: the live one, else the last one seen in this window (a canvas the agent closed keeps its name). */
  title(canvas: string): string | undefined
  /** A rescan (full backfill) is running. */
  readonly rescanning: Accessor<boolean>
  /**
   * Loads the session's assistant messages from the server (newest first, up to 1000), feeds them to the index, and
   * deletes snapshots that no message explains any more (a revert). Resolves with the number of canvases afterwards.
   */
  rescan(): Promise<number>
  /** Writes pending snapshot changes now. */
  flush(): void
  dispose(): void
}

export interface SessionRegistry {
  /** The session's entry, created on first use. */
  get(session: SessionRef): SessionEntry
  peek(key: string): SessionEntry | undefined
  keys(): readonly string[]
  /** Disposes the entries of sessions not in `keep`. */
  prune(keep: ReadonlySet<string>): void
  flush(): void
  dispose(): void
}

const isMessage = (value: unknown): value is MessageLike =>
  typeof value === "object" && value !== null && typeof (value as MessageLike).id === "string"

/** Older messages merged with what was loaded before, by id, oldest first. */
function mergeMessages(previous: readonly MessageLike[], next: readonly MessageLike[]): MessageLike[] {
  const byId = new Map<string, MessageLike>()
  for (const message of previous) byId.set(message.id, message)
  for (const message of next) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function createEntry(session: SessionRef, store: (session: SessionRef) => SessionStore): SessionEntry {
  return createRoot((dispose) => {
    const id = session.id
    // The session's server is a live ref: its data and client are read each time, as a restarted server replaces them.
    const [ref, setRef] = createSignal(session)
    const server = () => ref().server
    const persisted = createMemo(() => store(ref()))

    const messages = (): readonly MessageLike[] => {
      try {
        const list = server().data.session.message.list(id) as unknown
        return Array.isArray(list) ? (list as MessageLike[]) : []
      } catch {
        return []
      }
    }
    const revert = (): string | undefined => {
      try {
        const info = server().data.session.get(id) as { revert?: { messageID?: unknown } } | undefined
        const messageID = info?.revert?.messageID
        return typeof messageID === "string" ? messageID : undefined
      } catch {
        return undefined
      }
    }
    const snapshots = createMemo(() => readCanvasSnapshots(persisted().value))
    const [extra, setExtra] = createSignal<readonly MessageLike[]>([])

    const [grace, setGrace] = createSignal(false)
    const graceTimer = setTimeout(() => setGrace(true), MESSAGES_GRACE_MS)
    onCleanup(() => clearTimeout(graceTimer))

    // Ready once the snapshots have loaded and the window has too (or there is nothing a missing window would hide).
    const loaded = createMemo<boolean>(
      (previous) =>
        previous ||
        (persisted().ready() && (messages().length > 0 || Object.keys(snapshots()).length === 0 || grace())),
      false,
    )

    const index = createSessionIndex({ messages, snapshots, extra, loaded, revert })

    // Titles of canvases seen in this window, for canvases the agent closed since.
    const [titles, setTitles] = createSignal<ReadonlyMap<string, string>>(new Map())
    createEffect(() => {
      const known = untrack(titles)
      const next = new Map(known)
      for (const state of index.canvases()) if (state.title) next.set(state.id, state.title)
      if (next.size !== known.size || [...next].some(([canvas, title]) => known.get(canvas) !== title)) setTitles(next)
    })

    // ── Snapshots: persist each canvas's settled state, delete closed canvases ──────────────────────────────────
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const written = new Map<string, CanvasSnapshot>()
    const save = () => {
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = undefined
      const states = untrack(index.canvases)
      const removed = untrack(index.removed)
      writeStore(untrack(persisted), (value) => {
        let next = value
        for (const state of states) {
          if (!state.settled || written.get(state.id) === state.settled) continue
          next = writeCanvasSnapshot(next, state.id, state.settled)
          written.set(state.id, state.settled)
        }
        for (const canvas of removed) {
          next = writeCanvasSnapshot(next, canvas, undefined)
          written.delete(canvas)
        }
        return next
      })
    }

    createEffect(() => {
      if (!persisted().ready() || !index.ready()) return
      const changed =
        index.canvases().some((state) => state.settled && written.get(state.id) !== state.settled) ||
        index.removed().size > 0
      if (!changed) return
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = setTimeout(save, SNAPSHOT_SAVE_DELAY_MS)
    })

    // ── Backfill: load older messages when a canvas lacks its base ──────────────────────────────────────────────
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    const [rescanning, setRescanning] = createSignal(false)
    let running: Promise<readonly MessageLike[]> | undefined

    const load = (full: boolean): Promise<readonly MessageLike[]> => {
      if (running) return running
      const missing = () => untrack(index.canvases).some((state) => state.missingBase)
      running = backfill(untrack(server).client, id, {
        signal: controller.signal,
        ...(full
          ? {}
          : {
              until: (loaded: MessageLike[]) => {
                setExtra((previous) => mergeMessages(previous, loaded.filter(isMessage)))
                return !missing()
              },
            }),
      })
        .then((loaded) => {
          if (!controller.signal.aborted) setExtra((previous) => mergeMessages(previous, loaded.filter(isMessage)))
          return loaded
        })
        .finally(() => {
          running = undefined
        })
      return running
    }

    // Once per rise: a backfill that could not resolve everything (a stale snapshot) must not run again and again.
    let needed = false
    createEffect(() => {
      const need = index.needsBackfill()
      if (need && !needed) void load(false)
      needed = need
    })

    const rescan = async () => {
      setRescanning(true)
      try {
        const loaded = await load(true)
        if (controller.signal.aborted) return 0
        // Snapshots newer than every message (after a revert) describe messages that are gone. Only judge them when
        // there is a transcript to judge by, so a failed request never deletes canvases.
        const cut = revert()
        const ids = [...untrack(messages), ...loaded]
          .map((message) => message.id)
          .filter((messageID) => cut === undefined || messageID < cut)
        if (ids.length > 0) {
          const newest = ids.reduce((a, b) => (a > b ? a : b))
          const stale = Object.entries(untrack(snapshots))
            .filter(([, snapshot]) => snapshot.after.messageID > newest)
            .map(([canvas]) => canvas)
          if (stale.length > 0)
            writeStore(untrack(persisted), (value) =>
              stale.reduce((next, canvas) => writeCanvasSnapshot(next, canvas, undefined), value),
            )
        }
        return untrack(index.canvases).length
      } finally {
        setRescanning(false)
      }
    }

    return {
      key: session.key,
      index,
      store: persisted,
      title: (canvas: string) => index.canvas(canvas)?.title ?? titles().get(canvas) ?? snapshots()[canvas]?.title,
      rescanning,
      rescan,
      flush: () => {
        if (saveTimer !== undefined) save()
      },
      dispose: () => {
        if (saveTimer !== undefined) save()
        dispose()
      },
      // Keeps the newest ref for the live server (a ref from another list read carries the same server).
      update(next: SessionRef) {
        if (next.server !== untrack(ref).server) setRef(next)
      },
    } as SessionEntry & { update(next: SessionRef): void }
  })
}

/**
 * The per-session canvas indexes of this window, one reactive root each, created when a session is first rendered and
 * disposed when its shell tab closes (`prune`).
 */
export function createSessionRegistry(store: (session: SessionRef) => SessionStore): SessionRegistry {
  const entries = new Map<string, SessionEntry & { update(next: SessionRef): void }>()
  return {
    get(session) {
      const existing = entries.get(session.key)
      if (existing) {
        existing.update(session)
        return existing
      }
      const created = createEntry(session, store) as SessionEntry & { update(next: SessionRef): void }
      entries.set(session.key, created)
      return created
    },
    peek: (key) => entries.get(key),
    keys: () => [...entries.keys()],
    prune(keep) {
      for (const [key, entry] of entries) {
        if (keep.has(key)) continue
        entries.delete(key)
        entry.dispose()
      }
    },
    flush() {
      for (const entry of entries.values()) entry.flush()
    },
    dispose() {
      for (const entry of entries.values()) entry.dispose()
      entries.clear()
    },
  }
}
