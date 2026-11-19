import type { Spec } from "@json-render/core"
import type { BlockRef, CanvasSnapshot } from "../protocol/fold.ts"
import type { OverrideEntry } from "./state.ts"

/**
 * The per-session value the GUI persists (a `Store.session`). Entries are JSON strings, so the store's schema stays a
 * flat record of strings and one bad entry cannot spoil the others.
 *
 * - `canvases`: canvas id -> `CanvasSnapshot`
 * - `surfaces`: surface id -> `{ t, o }`, the user's state edits (`o`, as `TrackedStore.overrides()`) and when they
 *   were saved (`t`, for pruning)
 *
 * Every write returns a new value and never mutates its input; when nothing changes it returns the input itself.
 */
export interface PersistedSession {
  readonly v: number
  readonly canvases: Readonly<Record<string, string>>
  readonly surfaces: Readonly<Record<string, string>>
}

export const EMPTY_PERSISTED: PersistedSession = { v: 1, canvases: {}, surfaces: {} }

/** Entries bigger than this are not written; the previous entry stays. */
export const MAX_ENTRY_BYTES = 256 * 1024

/** How many surfaces keep their edits; the least recently saved go first. */
export const MAX_SURFACE_ENTRIES = 50

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0

function toRef(value: unknown): BlockRef | undefined {
  if (!isRecord(value) || typeof value.messageID !== "string" || !value.messageID) return
  if (!isIndex(value.part) || !isIndex(value.ordinal)) return
  return { messageID: value.messageID, part: value.part, ordinal: value.ordinal }
}

function toSpec(value: unknown): Spec | undefined {
  if (!isRecord(value) || typeof value.root !== "string" || !isRecord(value.elements)) return
  if (value.state !== undefined && !isRecord(value.state)) return
  return value as unknown as Spec
}

function toSnapshot(value: unknown): CanvasSnapshot | undefined {
  if (!isRecord(value)) return
  const spec = toSpec(value.spec)
  const after = toRef(value.after)
  if (!spec || !after || !isIndex(value.generation)) return
  if (value.title !== undefined && typeof value.title !== "string") return
  const first = value.first === undefined ? undefined : toRef(value.first)
  return {
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    spec,
    after,
    generation: value.generation,
    ...(first ? { first } : {}),
  }
}

function parse(text: unknown): unknown {
  if (typeof text !== "string") return
  try {
    return JSON.parse(text)
  } catch {
    return
  }
}

// Stored values come from disk and from older versions: read every field defensively.
const entriesOf = (record: unknown): Array<[string, string]> =>
  isRecord(record)
    ? Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : []

const recordOf = (record: unknown): Readonly<Record<string, string>> => (isRecord(record) ? (record as never) : {})

const ownString = (record: unknown, key: string): string | undefined =>
  isRecord(record) && Object.hasOwn(record, key) && typeof record[key] === "string" ? record[key] : undefined

const utf8Length = (text: string) => {
  let bytes = text.length
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code > 0x7f) bytes += code > 0x7ff && (code < 0xd800 || code > 0xdfff) ? 2 : 1
  }
  return bytes
}

function stringify(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value)
    return json !== undefined && utf8Length(json) <= MAX_ENTRY_BYTES ? json : undefined
  } catch {
    return undefined
  }
}

const withEntry = (record: Readonly<Record<string, string>>, key: string, value: string | undefined) => {
  if (value !== undefined) return { ...record, [key]: value }
  const { [key]: _removed, ...rest } = record
  return rest
}

const SNAPSHOT_CACHE_SIZE = 64
// Parsed snapshots by their stored text. Every write to the persisted value (a surface's edits too) reads all canvases
// again; an unchanged entry must come back as the same object, so the fold that starts from it is not rebuilt.
const parsedSnapshots = new Map<string, CanvasSnapshot | null>()

function snapshotOf(text: string): CanvasSnapshot | undefined {
  let snapshot = parsedSnapshots.get(text)
  if (snapshot !== undefined) {
    parsedSnapshots.delete(text)
  } else {
    snapshot = toSnapshot(parse(text)) ?? null
    if (parsedSnapshots.size >= SNAPSHOT_CACHE_SIZE) parsedSnapshots.delete(parsedSnapshots.keys().next().value!)
  }
  parsedSnapshots.set(text, snapshot)
  return snapshot ?? undefined
}

/**
 * The canvases' snapshots from a persisted value. Invalid entries are dropped. The result has no prototype, so any
 * canvas id is a safe key. An unchanged entry reads back as the same object as last time; never mutate it.
 */
export function readCanvasSnapshots(p: PersistedSession | undefined): Record<string, CanvasSnapshot> {
  const result: Record<string, CanvasSnapshot> = Object.create(null)
  for (const [id, text] of entriesOf(p?.canvases)) {
    const snapshot = snapshotOf(text)
    if (snapshot)
      Object.defineProperty(result, id, { value: snapshot, enumerable: true, writable: true, configurable: true })
  }
  return result
}

/** Stores a canvas's snapshot, or deletes it with `undefined`. A snapshot over 256 KB is skipped and the old one kept. */
export function writeCanvasSnapshot(
  p: PersistedSession | undefined,
  id: string,
  snap: CanvasSnapshot | undefined,
): PersistedSession {
  const current = p ?? EMPTY_PERSISTED
  const canvases = recordOf(current.canvases)
  const existing = ownString(canvases, id)
  if (snap === undefined) {
    if (existing === undefined) return current
    return { ...current, v: 1, canvases: withEntry(canvases, id, undefined) }
  }
  const json = stringify(snap)
  if (json === undefined || json === existing) return current
  return { ...current, v: 1, canvases: withEntry(canvases, id, json) }
}

interface SurfaceEntry {
  readonly t: number
  readonly o: OverrideEntry[]
}

function toOverride(entry: unknown): OverrideEntry[] {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return []
  if (entry.length === 2) return [[entry[0], entry[1]]]
  if (entry.length === 3 && isRecord(entry[2])) return [[entry[0], entry[1], entry[2]]]
  return []
}

function toSurfaceEntry(value: unknown): SurfaceEntry | undefined {
  if (!isRecord(value) || !Array.isArray(value.o)) return
  const o = value.o.flatMap(toOverride)
  return { t: typeof value.t === "number" && Number.isFinite(value.t) ? value.t : 0, o }
}

/** The user's persisted state edits for a surface, ready for `TrackedStore.loadOverrides`. */
export function readSurfaceOverrides(p: PersistedSession | undefined, surfaceId: string): OverrideEntry[] {
  return toSurfaceEntry(parse(ownString(p?.surfaces, surfaceId)))?.o ?? []
}

/**
 * Stores a surface's state edits with the time they were saved, keeping the 50 most recently saved surfaces. No edits
 * deletes the entry. Edits equal to the stored ones change nothing (the time is not bumped).
 */
export function writeSurfaceOverrides(
  p: PersistedSession | undefined,
  surfaceId: string,
  entries: readonly OverrideEntry[],
  now: number = Date.now(),
): PersistedSession {
  const current = p ?? EMPTY_PERSISTED
  const surfaces = recordOf(current.surfaces)
  const existing = ownString(surfaces, surfaceId)
  if (entries.length === 0) {
    if (existing === undefined) return current
    return { ...current, v: 1, surfaces: withEntry(surfaces, surfaceId, undefined) }
  }

  const previous = toSurfaceEntry(parse(existing))
  if (previous && existing === stringify({ t: previous.t, o: entries })) return current
  const json = stringify({ t: now, o: entries })
  if (json === undefined) return current

  let next = withEntry(surfaces, surfaceId, json)
  const ids = Object.keys(next)
  if (ids.length > MAX_SURFACE_ENTRIES) {
    const age = (id: string) => (id === surfaceId ? Infinity : (toSurfaceEntry(parse(next[id]))?.t ?? 0))
    const keep = new Set(
      ids
        .map((id) => [id, age(id)] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SURFACE_ENTRIES)
        .map(([id]) => id),
    )
    next = Object.fromEntries(Object.entries(next).filter(([id]) => keep.has(id)))
  }
  return { ...current, v: 1, surfaces: next }
}
