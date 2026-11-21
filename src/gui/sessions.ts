import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type Owner,
} from "solid-js"
import type { SessionRef } from "@opencode/plugin/gui"
import type { CanvasSnapshot } from "../protocol/fold.ts"
import { backfill } from "../runtime/backfill.ts"
import { createSessionIndex, type MessageLike, type SessionIndex } from "../runtime/session-index.ts"
import {
  deleteSurfaceOverrides,
  readCanvasSnapshots,
  writeCanvasSnapshot,
  type PersistedSession,
} from "../runtime/snapshot.ts"
import { canvasEntryOf, writeStore, type SessionStore } from "./persist.ts"

/** How long settled canvases wait before they are written, so a burst of closing blocks writes once. */
/** When to ask the server again whether a snapshot's message exists, after a failure that said nothing (per attempt). */
export const VERIFY_RETRY_MS: readonly number[] = [2000, 10_000, 30_000]

export const SNAPSHOT_SAVE_DELAY_MS = 300

/**
 * How long the index waits for the session's store and messages before it counts as loaded with whatever it has. Until
 * then, canvas tabs stay hidden; after it, a store that never loads (a failed storage read, a session whose location
 * stays unknown) leaves the index without snapshots instead of loading forever.
 */
export const MESSAGES_GRACE_MS = 4000

export interface SessionRegistryOptions {
  /**
   * The owner whose context every session root inherits: the plugin's root in setup, so an error in an index's effects
   * fails the plugin (the host's handler for it) whoever first asked for the session. Disposal stays with the registry.
   */
  readonly owner?: Owner | null
  /** MESSAGES_GRACE_MS, for tests. */
  readonly graceMs?: number
}

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

/**
 * Deletes the stored edits of canvas generations that are no longer shown: every generation of a canvas the agent
 * closed or whose creation was reverted, and all but the current one of a canvas whose generation is known (its spec
 * does not rest on a missing base). Canvases the index does not know stay as they are: their messages may not be loaded.
 */
function pruneCanvasEntries(
  value: PersistedSession,
  current: ReadonlyMap<string, number>,
  gone: ReadonlySet<string>,
): PersistedSession {
  return deleteSurfaceOverrides(value, (entry) => {
    const of = canvasEntryOf(entry)
    if (!of) return false
    const generation = current.get(of.canvas)
    return generation !== undefined ? generation !== of.generation : gone.has(of.canvas)
  })
}

/** The server's error for a message it does not have (`MessageNotFoundError` of @opencode/client). */
const isMessageNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "MessageNotFoundError"

/** Older messages merged with what was loaded before, by id, oldest first. */
function mergeMessages(previous: readonly MessageLike[], next: readonly MessageLike[]): MessageLike[] {
  const byId = new Map<string, MessageLike>()
  for (const message of previous) byId.set(message.id, message)
  for (const message of next) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function createEntry(
  session: SessionRef,
  store: (session: SessionRef) => SessionStore,
  options: SessionRegistryOptions,
): SessionEntry {
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
    // Messages the server said it no longer has (see `verify` below).
    const [deleted, setDeleted] = createSignal<ReadonlySet<string>>(new Set())

    const [grace, setGrace] = createSignal(false)
    const graceTimer = setTimeout(() => setGrace(true), options.graceMs ?? MESSAGES_GRACE_MS)
    onCleanup(() => clearTimeout(graceTimer))

    // Ready once the snapshots have loaded and the window has too (or there is nothing a missing window would hide), or
    // after the grace period with whatever is there: no spinner waits forever on a store that never loads.
    const loaded = createMemo<boolean>(
      (previous) =>
        previous ||
        grace() ||
        (persisted().ready() && (messages().length > 0 || Object.keys(snapshots()).length === 0)),
      false,
    )

    // A backfill reached the session's first message: a canvas whose base was not found has none.
    const [searched, setSearched] = createSignal(false)
    const index = createSessionIndex({ messages, snapshots, extra, loaded, revert, deleted, searched })

    // Titles of canvases seen in this window, for canvases the agent closed since.
    const [titles, setTitles] = createSignal<ReadonlyMap<string, string>>(new Map())
    createEffect(() => {
      const known = untrack(titles)
      const next = new Map(known)
      for (const state of index.canvases()) if (state.title) next.set(state.id, state.title)
      if (next.size !== known.size || [...next].some(([canvas, title]) => known.get(canvas) !== title)) setTitles(next)
    })

    // ── Snapshots: persist each canvas's settled state, delete closed canvases ──────────────────────────────────
    // Canvases whose snapshots a committed revert deleted: their stored edits go too unless the canvas is still shown
    // (and so do those of stale snapshots and of closed canvases).
    const [reverted, setReverted] = createSignal<ReadonlySet<string>>(new Set())
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const written = new Map<string, CanvasSnapshot>()
    const save = () => {
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = undefined
      if (!untrack(index.ready)) return
      const states = untrack(index.canvases)
      const removed = untrack(index.removed)
      const stale = untrack(index.staleSnapshots)
      const gone = new Set([...removed, ...stale, ...untrack(reverted)])
      setReverted(new Set<string>())
      writeStore(untrack(persisted), (value) => {
        let next = value
        for (const state of states) {
          if (!state.settled || written.get(state.id) === state.settled) continue
          next = writeCanvasSnapshot(next, state.id, state.settled)
          written.set(state.id, state.settled)
        }
        // Closed canvases, and snapshots of messages that are gone (a revert committed while this window was away).
        for (const canvas of [...removed, ...stale]) {
          next = writeCanvasSnapshot(next, canvas, undefined)
          written.delete(canvas)
        }
        const current = new Map<string, number>()
        // A canvas on an unknown base counts its generations from that base, not from the canvas's first block.
        for (const state of states)
          if (!state.baseUnknown && !state.missingBase && state.spec !== null) current.set(state.id, state.generation)
        return pruneCanvasEntries(next, current, gone)
      })
    }

    createEffect(() => {
      if (!persisted().ready() || !index.ready()) return
      const changed =
        index.canvases().some((state) => state.settled && written.get(state.id) !== state.settled) ||
        index.removed().size > 0 ||
        index.staleSnapshots().length > 0 ||
        reverted().size > 0
      if (!changed) return
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = setTimeout(save, SNAPSHOT_SAVE_DELAY_MS)
    })

    // ── Reverts: a staged revert hides the messages from its point on; committing it deletes them ──────────────
    // The app clears the staged revert both when the user restores the messages and when the next prompt commits the
    // revert; only a commit deletes them, right after (in the same event). So once the revert is cleared, the messages it
    // hid tell which it was (not the user's next message, newer than any message there was when the revert was staged).
    // A commit deletes the snapshots taken from those messages, and the older messages a backfill loaded from the server
    // while the revert was staged (it still lists them).
    let staged: { readonly cut: string; readonly hidden: Set<string>; ceiling?: string } | undefined
    let revertEpoch = 0
    let disposed = false
    onCleanup(() => {
      disposed = true
    })
    const dropFrom = (cut: string) =>
      setExtra((previous) =>
        previous.some((message) => message.id >= cut) ? previous.filter((message) => message.id < cut) : previous,
      )
    const commit = (cut: string) => {
      dropFrom(cut)
      const doomed = Object.entries(untrack(snapshots))
        .filter(([, snapshot]) => snapshot.after.messageID >= cut)
        .map(([canvas]) => canvas)
      if (doomed.length === 0) return
      for (const canvas of doomed) written.delete(canvas)
      writeStore(untrack(persisted), (value) =>
        doomed.reduce((next, canvas) => writeCanvasSnapshot(next, canvas, undefined), value),
      )
      setReverted((previous) => new Set([...previous, ...doomed]))
    }
    createEffect(() => {
      const cut = revert()
      if (cut !== undefined) {
        if (staged?.cut !== cut) {
          staged = { cut, hidden: new Set() }
          revertEpoch++
          dropFrom(cut)
        }
        const list = messages()
        if (staged.ceiling === undefined)
          for (const message of list)
            if (staged.ceiling === undefined || message.id > staged.ceiling) staged.ceiling = message.id
        const ceiling = staged.ceiling
        if (ceiling !== undefined)
          for (const message of list) if (message.id >= cut && message.id <= ceiling) staged.hidden.add(message.id)
        return
      }
      if (!staged) return
      const { cut: was, hidden } = staged
      staged = undefined
      revertEpoch++
      setTimeout(() => {
        if (disposed) return
        const left = new Set(untrack(messages).map((message) => message.id))
        if (![...hidden].some((id) => left.has(id))) commit(was)
      }, 0)
    })

    // ── Snapshots older than the loaded messages: ask the server whether their message still exists ─────────────
    // A revert committed while no window had the session open (a prompt from another window or the terminal, or the
    // app restarting) deleted the messages; when nothing older than the snapshot's message is left, the loaded
    // messages cannot tell. The server deletes messages only when a revert is committed, so a message it reports as
    // not found was reverted. Any other failure (offline, a timeout, a server error) leaves the snapshot as it is, and
    // the server is asked again: after VERIFY_RETRY_MS (a few times), and at once when the connection changes.
    const checked = new Set<string>()
    const failures = new Map<string, number>()
    const [retries, setRetries] = createSignal(0)
    const timers = new Set<ReturnType<typeof setTimeout>>()
    onCleanup(() => timers.forEach(clearTimeout))
    const verify = async (messageID: string) => {
      try {
        const client = untrack(server).client as unknown as {
          readonly session: {
            readonly message: { get(input: { sessionID: string; messageID: string }): Promise<unknown> }
          }
        }
        await client.session.message.get({ sessionID: id, messageID })
        failures.delete(messageID)
      } catch (error) {
        if (disposed) return
        if (isMessageNotFound(error)) {
          failures.delete(messageID)
          setDeleted((previous) => new Set([...previous, messageID]))
          return
        }
        const failed = (failures.get(messageID) ?? 0) + 1
        failures.set(messageID, failed)
        const delay = VERIFY_RETRY_MS[failed - 1]
        if (delay === undefined) return
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (checked.delete(messageID)) setRetries((count) => count + 1)
        }, delay)
        timers.add(timer)
      }
    }
    let asked: SessionRef["server"] | undefined
    createEffect(() => {
      retries()
      const current = server()
      if (current !== asked) {
        asked = current
        // A new connection: what failed before is asked again now.
        for (const messageID of failures.keys()) checked.delete(messageID)
      }
      for (const messageID of index.unverified()) {
        if (checked.has(messageID)) continue
        checked.add(messageID)
        void verify(messageID)
      }
    })

    // ── Backfill: load older messages when a canvas lacks its base ──────────────────────────────────────────────
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    const [rescanning, setRescanning] = createSignal(false)
    let running: { readonly epoch: number; readonly promise: Promise<readonly MessageLike[]> } | undefined

    const load = (full: boolean): Promise<readonly MessageLike[]> => {
      if (running?.epoch === revertEpoch) return running.promise
      const missing = () => untrack(index.canvases).some((state) => state.baseUnknown)
      // The server still lists the messages a staged revert hides, and a load that outlived a revert's change may hold
      // messages that are gone: neither joins the transcript.
      const epoch = revertEpoch
      let reachedStart = false
      const merge = (loaded: readonly unknown[]) => {
        if (controller.signal.aborted || epoch !== revertEpoch) return
        const cut = staged?.cut
        const kept = loaded.filter(isMessage).filter((message) => cut === undefined || message.id < cut)
        setExtra((previous) => mergeMessages(previous, kept))
      }
      const promise = backfill(untrack(server).client, id, {
        signal: controller.signal,
        onStart: () => (reachedStart = true),
        ...(full
          ? {}
          : {
              until: (loaded: MessageLike[]) => {
                merge(loaded)
                return !missing()
              },
            }),
      })
        .then((loaded) => {
          merge(loaded)
          // With the whole history merged, the fold settles the canvases whose base it did not find.
          if (reachedStart && !controller.signal.aborted && epoch === revertEpoch) setSearched(true)
          return loaded
        })
        .finally(() => {
          if (running?.promise === promise) running = undefined
        })
      running = { epoch, promise }
      return promise
    }

    // Once per rise: a backfill that could not resolve everything (a stale snapshot) must not run again and again. A
    // revert's change re-arms it, since what is missing has changed.
    let needed = false
    let armedAt = 0
    createEffect(() => {
      const need = index.needsBackfill()
      revert()
      if (need && (!needed || armedAt !== revertEpoch)) void load(false)
      needed = need
      armedAt = revertEpoch
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
          // Snapshots whose message the full load did not find: ask the server about each again.
          const found = new Set(ids)
          const unknown = new Set(
            Object.values(untrack(snapshots))
              .map((snapshot) => snapshot.after.messageID)
              .filter((messageID) => messageID <= newest && !found.has(messageID) && !untrack(deleted).has(messageID)),
          )
          await Promise.all([...unknown].map((messageID) => (checked.add(messageID), verify(messageID))))
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
  }, options.owner)
}

/**
 * The per-session canvas indexes of this window, one reactive root each, created when a session is first rendered and
 * disposed when its shell tab closes (`prune`).
 */
export function createSessionRegistry(
  store: (session: SessionRef) => SessionStore,
  options: SessionRegistryOptions = {},
): SessionRegistry {
  const entries = new Map<string, SessionEntry & { update(next: SessionRef): void }>()
  return {
    get(session) {
      const existing = entries.get(session.key)
      if (existing) {
        existing.update(session)
        return existing
      }
      const created = createEntry(session, store, options) as SessionEntry & { update(next: SessionRef): void }
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
