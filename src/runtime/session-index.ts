import { createMemo, createSignal, getOwner, runWithOwner, untrack, type Accessor } from "solid-js"
import { scanFences } from "../protocol/fence.ts"
import {
  compareRefs,
  createCanvasFolder,
  type CanvasBlock,
  type CanvasSnapshot,
  type CanvasState,
} from "../protocol/fold.ts"
import { blockKind, canvasIdOf, parseBlock, type ParsedBlock } from "../protocol/surface.ts"
import { LANGUAGES } from "../shared/constants.ts"

/** The fields of a session message the index reads (the client's `SessionMessageInfo` fits). */
export interface MessageLike {
  readonly id: string
  readonly type: string
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly time?: { readonly completed?: number }
}

export interface SessionIndexInput {
  /** The client's loaded window of the session's messages (a Solid store array). */
  readonly messages: Accessor<readonly MessageLike[]>
  /** The persisted canvas snapshots (`readCanvasSnapshots`). */
  readonly snapshots: Accessor<Readonly<Record<string, CanvasSnapshot>>>
  /** Older messages from `backfill`, merged with the window and deduplicated by id. */
  readonly extra?: Accessor<readonly MessageLike[]>
  /** The window has loaded at least once. Defaults to: `messages()` was non-empty once. */
  readonly loaded?: Accessor<boolean>
  /**
   * The session's staged revert point (`session.revert.messageID`). Messages from it on stay in the store until the
   * revert is committed but are no longer part of the transcript, so the index ignores them.
   */
  readonly revert?: Accessor<string | undefined>
  /** Messages the server no longer has (see `unverified`): the snapshots taken after one of them are gone. */
  readonly deleted?: Accessor<ReadonlySet<string>>
  /**
   * The session's whole history is loaded (a backfill reached its first message): a canvas whose base is not found
   * has none, and settles as it is (see `baseUnknown` in src/protocol/fold.ts).
   */
  readonly searched?: Accessor<boolean>
}

export interface SessionIndex {
  /** The live canvases, ordered by first appearance. Changes on every streaming update of any canvas. */
  readonly canvases: Accessor<readonly CanvasState[]>
  /** The ids of the live canvases, in the same order; notifies only when the ids change. */
  readonly canvasIds: Accessor<readonly string[]>
  /** One canvas, reactively; notifies only when that canvas changes. */
  canvas(id: string): CanvasState | undefined
  /** Whether a canvas is live, reactively; notifies only when that flips. */
  exists(id: string): boolean
  /** Canvases a block closed; their snapshots should be deleted. */
  readonly removed: Accessor<ReadonlySet<string>>
  /** Canvases not opened because MAX_CANVASES were open (see FoldResult.refused in src/protocol/fold.ts). */
  readonly refused: Accessor<ReadonlySet<string>>
  /**
   * Whether a `spec` or `canvas` block with exactly this normalized text (`ParsedBlock.text`) is in an assistant text
   * part: the block is the agent's own (trust). Compared exactly, never by hash.
   */
  knows(text: string): boolean
  /**
   * The normalized text of the newest closed inline block whose header has this `id`, or undefined. Blocks the agent
   * re-sent with the same id share their UI state; only the newest one drives it.
   */
  latestInline(id: string): string | undefined
  /**
   * Canvases that started live (in a reply still being written when the index became ready, or in a later one) and have
   * drawn something, not consumed yet. A patch whose base is not loaded is an update, never a new canvas.
   */
  readonly fresh: Accessor<readonly string[]>
  consumeFresh(id: string): void
  /**
   * Canvases reported fresh that the agent closed again in the reply that started them, not consumed yet: a tab opened
   * for such a canvas should close again (a reply that opened and closed 650 canvases left a tab for each).
   */
  readonly withdrawn: Accessor<readonly string[]>
  consumeWithdrawn(id: string): void
  /**
   * A canvas lacks its base (a patch with no earlier version loaded, even one that renders, while the history has not
   * been searched to its start), or a snapshot is newer than the newest loaded message (a revert). Older messages
   * should be loaded with `backfill`.
   */
  readonly needsBackfill: Accessor<boolean>
  /**
   * Canvases whose stored snapshot was taken after a message that is gone: its id is inside the loaded messages' range
   * (or newer than all of them) but no such message is loaded, as after a committed revert. Their snapshots should be
   * deleted. Empty while a revert is staged or the transcript is empty.
   */
  readonly staleSnapshots: Accessor<readonly string[]>
  /**
   * The messages of stored snapshots that are older than every loaded message, so the loaded messages cannot tell
   * whether they still exist (a revert committed while no window had the session open deleted them, and nothing
   * older is left). The server should be asked, and the ones it no longer has passed as `deleted`. Empty while a
   * revert is staged or the transcript is empty.
   */
  readonly unverified: Accessor<readonly string[]>
  readonly ready: Accessor<boolean>
}

interface ScannedBlock {
  readonly ordinal: number
  readonly closed: boolean
  readonly parsed: ParsedBlock
  /** The canvas a canvas block targets; undefined for inline blocks. */
  readonly canvas?: string
}

interface PartScan {
  readonly text: string
  readonly blocks: readonly ScannedBlock[]
}

interface Scan {
  readonly blocks: readonly CanvasBlock[]
  /** Every loaded message id, also those a staged revert hides, and the oldest and newest of them. */
  readonly ids: ReadonlySet<string>
  readonly first?: string
  readonly last?: string
  /** The normalized texts of every block in assistant text. */
  readonly texts: ReadonlySet<string>
  /** Inline header id -> the normalized text of the newest closed block with that id. */
  readonly latest: ReadonlyMap<string, string>
  /** The newest message that is not a reply still being written. */
  readonly settled?: string
  /** Whether each assistant message has completed. */
  readonly complete: ReadonlyMap<string, boolean>
}

const PARSE_CACHE_SIZE = 512
const RECENT_SETTLED = 8
const KNOWN_LANGUAGES: ReadonlySet<string> = new Set(LANGUAGES)
const NO_IDS: readonly string[] = Object.freeze([])

const sameArray = <T>(a: readonly T[], b: readonly T[]) =>
  a === b || (a.length === b.length && a.every((item, index) => item === b[index]))

const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

const sameMap = <K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>) => {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

const sameRecord = <T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>) => {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}

// The same snapshot after a JSON round trip: the fold is deterministic, so position and generation identify it.
const sameSnapshot = (a: CanvasSnapshot, b: CanvasSnapshot) =>
  compareRefs(a.after, b.after) === 0 && a.generation === b.generation && a.title === b.title

function createParser() {
  const cache = new Map<string, ParsedBlock>()
  return (body: string, closed: boolean) => {
    const key = (closed ? "1" : "0") + body
    let parsed = cache.get(key)
    if (parsed) {
      cache.delete(key)
    } else {
      parsed = parseBlock(body, { partial: !closed })
      if (cache.size >= PARSE_CACHE_SIZE) cache.delete(cache.keys().next().value!)
    }
    cache.set(key, parsed)
    return parsed
  }
}

function scanPart(text: string, parse: (body: string, closed: boolean) => ParsedBlock): ScannedBlock[] {
  if (!text.includes("```") && !text.includes("~~~")) return []
  const blocks: ScannedBlock[] = []
  for (const fence of scanFences(text)) {
    if (!KNOWN_LANGUAGES.has(fence.language)) continue
    const parsed = parse(fence.body, fence.closed)
    let canvas: string | undefined
    if (blockKind(fence.language, parsed.header) === "canvas") {
      // While the first line streams, the header (and so the target canvas) is not known yet: wait for it.
      const nothingYet =
        !fence.closed &&
        parsed.patches.length === 0 &&
        parsed.errors.length === 0 &&
        Object.keys(parsed.header).length === 0
      if (!nothingYet) canvas = canvasIdOf(parsed.header)
    }
    blocks.push({ ordinal: fence.ordinal, closed: fence.closed, parsed, ...(canvas !== undefined ? { canvas } : {}) })
  }
  return blocks
}

/**
 * Follows a session's transcript: finds the `spec` and `canvas` blocks in assistant text (including the message still
 * streaming), folds canvas blocks onto the persisted snapshots, and tracks which canvases appeared live.
 *
 * Create it inside a reactive root; it lives as long as that root. The message store changes every ~100 ms while the
 * agent streams, so each text part is scanned again only when its text changed, parsed blocks are cached by body, and
 * the fold re-applies only changed blocks. Canvases that did not change keep their `CanvasState` object.
 */
export function createSessionIndex(input: SessionIndexInput): SessionIndex {
  const owner = getOwner()
  const parse = createParser()
  const parts = new Map<string, PartScan>()
  const canvasBlocks = new Map<string, CanvasBlock>()
  const folder = createCanvasFolder()
  // Settled snapshots this index produced, to recognize them when they come back from the store.
  const recent = new Map<string, CanvasSnapshot[]>()

  let sawMessages = false
  const ready = createMemo(() => {
    if (input.loaded) return input.loaded()
    if (!sawMessages && (input.messages()?.length ?? 0) > 0) sawMessages = true
    return sawMessages
  })

  const merged = (): readonly MessageLike[] => {
    const window = input.messages() ?? []
    const older = input.extra?.() ?? []
    if (older.length === 0) return window
    const ids = new Set<string>()
    for (const message of window) ids.add(message.id)
    const all = older.filter((message) => !ids.has(message.id))
    for (const message of window) all.push(message)
    return all
  }

  const scan = createMemo<Scan>(() => {
    const revert = input.revert?.()
    const blocks: CanvasBlock[] = []
    const texts = new Set<string>()
    const latest = new Map<string, string>()
    const complete = new Map<string, boolean>()
    const seenParts = new Set<string>()
    const seenBlocks = new Set<string>()
    const ids = new Set<string>()
    let first: string | undefined
    let last: string | undefined
    let settled: string | undefined
    let sorted = true

    for (const message of merged()) {
      const id = message?.id
      if (typeof id !== "string") continue
      ids.add(id)
      if (first === undefined || id < first) first = id
      if (last === undefined || id > last) last = id
      if (revert !== undefined && id >= revert) continue
      const done = message.type !== "assistant" || !!message.time?.completed
      if (done && (settled === undefined || id > settled)) settled = id
      if (message.type !== "assistant") continue
      complete.set(id, done)
      const content = message.content
      if (!Array.isArray(content)) continue

      for (let part = 0; part < content.length; part++) {
        const item = content[part]
        const text = item?.type === "text" ? item.text : undefined
        if (typeof text !== "string") continue
        const partKey = `${id}\u0000${part}`
        seenParts.add(partKey)
        let cached = parts.get(partKey)
        if (!cached || cached.text !== text) {
          cached = { text, blocks: scanPart(text, parse) }
          parts.set(partKey, cached)
        }

        for (const scanned of cached.blocks) {
          texts.add(scanned.parsed.text)
          if (scanned.canvas === undefined) {
            // The app renders a block once its fence closes; one still streaming does not take over its id yet.
            const id = scanned.parsed.header.id
            if (id !== undefined && scanned.closed) latest.set(id, scanned.parsed.text)
            continue
          }
          const key = `${partKey}\u0000${scanned.ordinal}`
          seenBlocks.add(key)
          let block = canvasBlocks.get(key)
          if (
            !block ||
            block.block !== scanned.parsed ||
            block.closed !== scanned.closed ||
            block.complete !== done ||
            block.canvas !== scanned.canvas
          ) {
            block = {
              ref: block?.ref ?? { messageID: id, part, ordinal: scanned.ordinal },
              canvas: scanned.canvas,
              block: scanned.parsed,
              closed: scanned.closed,
              complete: done,
            }
            canvasBlocks.set(key, block)
          }
          const previous = blocks.at(-1)
          if (previous && compareRefs(previous.ref, block.ref) > 0) sorted = false
          blocks.push(block)
        }
      }
    }

    for (const key of parts.keys()) if (!seenParts.has(key)) parts.delete(key)
    for (const key of canvasBlocks.keys()) if (!seenBlocks.has(key)) canvasBlocks.delete(key)
    if (!sorted) blocks.sort((a, b) => compareRefs(a.ref, b.ref))
    return {
      blocks,
      ids,
      ...(first !== undefined ? { first } : {}),
      ...(last !== undefined ? { last } : {}),
      texts,
      latest,
      ...(settled !== undefined ? { settled } : {}),
      complete,
    }
  })

  const known = createMemo(() => scan().texts, undefined, { equals: sameSet })
  const latest = createMemo(() => scan().latest, undefined, { equals: sameMap })

  // A snapshot describes messages that are gone when its message is newer than every loaded message, or inside their
  // range but not among them (the loaded messages are the newest ones, without gaps, so it was deleted: a committed
  // revert), or the server said it no longer has it (older than every loaded message, see `unverified`). An empty
  // transcript says nothing (a restarted server's store before it syncs): its snapshots stand.
  const range = createMemo(
    () => {
      const { ids, first, last } = scan()
      return { ids, first, last }
    },
    undefined,
    { equals: (a, b) => a.first === b.first && a.last === b.last && sameSet(a.ids, b.ids) },
  )
  const gone = (snapshot: CanvasSnapshot) => {
    const { ids, first, last } = range()
    const after = snapshot.after.messageID
    if (input.deleted?.().has(after)) return true
    if (first === undefined || last === undefined) return false
    return after > last || (after >= first && !ids.has(after))
  }
  // A snapshot from after a revert: past the staged revert point, or gone.
  const reverted = (snapshot: CanvasSnapshot) => {
    const cut = input.revert?.()
    return (cut !== undefined && snapshot.after.messageID >= cut) || gone(snapshot)
  }

  // A snapshot from after a revert describes messages that are gone, so the fold ignores it. A snapshot that is the
  // one already in use, or one this index produced, keeps that object, so the fold resumes instead of rebuilding.
  let used: Readonly<Record<string, CanvasSnapshot>> = {}
  const base = createMemo(
    () => {
      const snapshots = input.snapshots() ?? {}
      const isReady = ready()
      const result: Record<string, CanvasSnapshot> = Object.create(null)
      for (const id of Object.keys(snapshots)) {
        const snapshot = snapshots[id]
        if (!snapshot || (isReady && reverted(snapshot))) continue
        const same = (item: CanvasSnapshot) => item === snapshot || sameSnapshot(item, snapshot)
        const current = Object.hasOwn(used, id) ? used[id] : undefined
        const kept = current && same(current) ? current : recent.get(id)?.find(same)
        Object.defineProperty(result, id, { value: kept ?? snapshot, enumerable: true })
      }
      used = result
      return result
    },
    undefined,
    { equals: sameRecord },
  )

  const fold = createMemo(() => {
    const result = folder(base(), scan().blocks, { searched: input.searched?.() ?? false })
    for (const state of result.canvases.values()) {
      const settled = state.settled
      if (!settled) continue
      const list = recent.get(state.id) ?? []
      if (list.includes(settled)) continue
      list.push(settled)
      if (list.length > RECENT_SETTLED) list.shift()
      recent.set(state.id, list)
    }
    return result
  })

  const canvases = createMemo(() => [...fold().canvases.values()], undefined, { equals: sameArray })
  const canvasIds = createMemo(() => canvases().map((state) => state.id), undefined, { equals: sameArray })
  const removed = createMemo(() => fold().removed, undefined, { equals: sameSet })
  const refused = createMemo(() => fold().refused, undefined, { equals: sameSet })

  // Per-id selectors, owned by the index's root, not by whichever component asked first.
  const byId = new Map<string, Accessor<CanvasState | undefined>>()
  const canvas = (id: string) => {
    let memo = byId.get(id)
    if (!memo) {
      memo = runWithOwner(owner, () => createMemo(() => fold().canvases.get(id)))!
      byId.set(id, memo)
    }
    return memo()
  }
  const existsById = new Map<string, Accessor<boolean>>()
  const exists = (id: string) => {
    let memo = existsById.get(id)
    if (!memo) {
      memo = runWithOwner(owner, () => createMemo(() => canvas(id) !== undefined))!
      existsById.set(id, memo)
    }
    return memo()
  }

  // The newest settled message when the index first became ready: canvases that start after it are live, including
  // those in a reply that was still being written then (the session opened, or the app restarted, mid-reply).
  const watermark = createMemo<string | undefined>(
    (previous) => previous ?? (ready() ? (untrack(scan).settled ?? "") : undefined),
  )

  const consumed = new Set<string>()
  const reported = new Set<string>()
  const retired = new Set<string>()
  const [consumedVersion, setConsumedVersion] = createSignal(0)
  // The message that started each canvas reported fresh, until it is withdrawn (see `withdrawn`) or its reply is over.
  const startedIn = new Map<string, string>()

  const fresh = createMemo(
    () => {
      consumedVersion()
      const mark = watermark()
      if (mark === undefined) return NO_IDS
      const { complete } = scan()
      const ids: string[] = []
      for (const state of canvases()) {
        const id = state.id
        if (consumed.has(id) || retired.has(id)) continue
        // Wait for the first patch: a patch with no base is an update to a canvas that started before the loaded
        // messages, not a new canvas.
        if (state.spec === null || state.missingBase) continue
        const messageID = state.first.messageID
        if (messageID > mark && complete.get(messageID) === false) {
          ids.push(id)
          startedIn.set(id, messageID)
        }
      }
      // Report each canvas at most once: one that was reported and is no longer fresh does not come back.
      for (const id of reported) if (!ids.includes(id)) retired.add(id)
      for (const id of ids) reported.add(id)
      return ids.length === 0 ? NO_IDS : ids
    },
    undefined,
    { equals: sameArray },
  )

  const [withdrawnVersion, setWithdrawnVersion] = createSignal(0)
  const withdrawn = createMemo(
    () => {
      withdrawnVersion()
      fresh()
      if (startedIn.size === 0) return NO_IDS
      const { blocks, complete } = scan()
      const gone = removed()
      // The message of each started canvas's last block: its close, once the canvas is gone.
      const lastIn = new Map<string, string>()
      for (const block of blocks) if (startedIn.has(block.canvas)) lastIn.set(block.canvas, block.ref.messageID)
      const ids: string[] = []
      for (const [id, messageID] of startedIn) {
        if (gone.has(id) && lastIn.get(id) === messageID) ids.push(id)
        // A canvas that outlived its reply stays: the agent closed it later, or never.
        else if (complete.get(messageID) !== false) startedIn.delete(id)
      }
      return ids.length === 0 ? NO_IDS : ids
    },
    undefined,
    { equals: sameArray },
  )

  const staleSnapshots = createMemo(
    () => {
      if (!ready() || input.revert?.() !== undefined) return NO_IDS
      const snapshots = input.snapshots() ?? {}
      const ids = Object.keys(snapshots).filter((id) => {
        const snapshot = snapshots[id]
        return snapshot !== undefined && gone(snapshot)
      })
      return ids.length === 0 ? NO_IDS : ids
    },
    undefined,
    { equals: sameArray },
  )

  const unverified = createMemo(
    () => {
      if (!ready() || input.revert?.() !== undefined) return NO_IDS
      const { ids, first } = range()
      if (first === undefined) return NO_IDS
      const deleted = input.deleted?.()
      const snapshots = input.snapshots() ?? {}
      const messages = new Set<string>()
      for (const id of Object.keys(snapshots)) {
        const after = snapshots[id]?.after.messageID
        if (after !== undefined && after < first && !ids.has(after) && !deleted?.has(after)) messages.add(after)
      }
      return messages.size === 0 ? NO_IDS : [...messages].sort()
    },
    undefined,
    { equals: sameArray },
  )

  const needsBackfill = createMemo(() => {
    if (!ready()) return false
    if (canvases().some((state) => state.baseUnknown)) return true
    const snapshots = input.snapshots() ?? {}
    return Object.keys(snapshots).some((id) => {
      const snapshot = snapshots[id]
      return snapshot !== undefined && reverted(snapshot)
    })
  })

  return {
    canvases,
    canvasIds,
    canvas,
    exists,
    removed,
    refused,
    knows: (text) => known().has(text),
    latestInline: (id) => latest().get(id),
    fresh,
    consumeFresh(id) {
      if (consumed.has(id)) return
      consumed.add(id)
      setConsumedVersion((version) => version + 1)
    },
    withdrawn,
    consumeWithdrawn(id) {
      if (!startedIn.delete(id)) return
      setWithdrawnVersion((version) => version + 1)
    },
    needsBackfill,
    staleSnapshots,
    unverified,
    ready,
  }
}
