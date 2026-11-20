import type { Spec } from "@json-render/core"
import { applyPatches, EMPTY_SPEC, type Patch } from "./patch.ts"
import type { LineError, ParsedBlock } from "./surface.ts"

/** Where a block sits in the transcript. Message ids are time-ordered, so comparing refs compares transcript order. */
export interface BlockRef {
  readonly messageID: string
  /** The index of the text part in the message's content. */
  readonly part: number
  /** The block's position among the fenced blocks of that part. */
  readonly ordinal: number
}

export function compareRefs(a: BlockRef, b: BlockRef): number {
  if (a.messageID !== b.messageID) return a.messageID < b.messageID ? -1 : 1
  return a.part - b.part || a.ordinal - b.ordinal
}

const sameRef = (a: BlockRef | undefined, b: BlockRef | undefined) =>
  a === b || (a !== undefined && b !== undefined && compareRefs(a, b) === 0)

/** One canvas block of the transcript, as the session index finds it. */
export interface CanvasBlock {
  readonly ref: BlockRef
  readonly canvas: string
  readonly block: ParsedBlock
  /** The block's closing fence has arrived. */
  readonly closed: boolean
  /** The block's message has completed. */
  readonly complete: boolean
}

/** A canvas's folded spec after a block of a completed message: what the GUI persists, and where a later fold starts. */
export interface CanvasSnapshot {
  readonly title?: string
  readonly spec: Spec
  /** The last block folded into `spec`. A fold skips this canvas's blocks up to and including it. */
  readonly after: BlockRef
  readonly generation: number
  /** Where the canvas first appeared, so tabs keep their order across reloads. Defaults to `after`. */
  readonly first?: BlockRef
}

export interface CanvasState {
  readonly id: string
  readonly title?: string
  /** The raw folded spec (normalization happens later); null while nothing has been drawn. */
  readonly spec: Spec | null
  /** Bumps on every replace; UI state resets when it changes. */
  readonly generation: number
  /** The latest block is still being written: its fence is open and its message has not completed. */
  readonly streaming: boolean
  /** A patch arrived with no earlier version known; the spec is built on an empty one. */
  readonly missingBase: boolean
  /** The first block seen in this fold, or where the snapshot it started from says the canvas first appeared. */
  readonly first: BlockRef
  /** The last block applied. */
  readonly last: BlockRef
  /** Lines of the latest block that are not patches. */
  readonly lineErrors: readonly LineError[]
  /**
   * The state after the last block whose message completed and whose fence closed: what to persist. Absent while the
   * spec rests on a missing base, so an incomplete spec never becomes a base.
   */
  readonly settled?: CanvasSnapshot
}

export interface FoldResult {
  /** The live canvases, ordered by where they first appeared. */
  readonly canvases: ReadonlyMap<string, CanvasState>
  /** Canvases a block closed (and no later block recreated). Their snapshots should be deleted. */
  readonly removed: ReadonlySet<string>
}

type Fold = (base: Readonly<Record<string, CanvasSnapshot>>, blocks: readonly CanvasBlock[]) => FoldResult

/**
 * Folds canvas blocks, in transcript order, onto the canvases' snapshots: a block that sets `/root` (or says
 * `"mode":"replace"`) starts a new generation from scratch, any other block patches the current spec, and
 * `"close":true` removes the canvas. Pure.
 *
 * A block that only points `/root` at an element the canvas already has, without adding that element itself, switches
 * the view and patches (see `replaces`): it keeps the canvas's elements, state and the user's edits.
 */
export function foldCanvases(
  base: Readonly<Record<string, CanvasSnapshot>>,
  blocks: readonly CanvasBlock[],
): FoldResult {
  return createCanvasFolder()(base, blocks)
}

/**
 * Deep equality for JSON-like values: plain objects and arrays compare by content, anything else only equals itself.
 * Gives up (unequal) past a nesting depth, which only costs a recomputation.
 */
export function jsonEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || depth > 200) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) if (!jsonEqual(a[index], b[index], depth + 1)) return false
    return true
  }
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b) || (proto !== Object.prototype && proto !== null)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) if (!Object.hasOwn(right, key) || !jsonEqual(left[key], right[key], depth + 1)) return false
  return true
}

const samePatch = (a: Patch, b: Patch) =>
  a === b || (a.op === b.op && a.path === b.path && a.from === b.from && jsonEqual(a.value, b.value))

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

const NO_ERRORS: readonly LineError[] = Object.freeze([])

const sameErrors = (a: readonly LineError[], b: readonly LineError[]) =>
  a === b ||
  (a.length === b.length &&
    a.every((error, index) => {
      const other = b[index]!
      return error.line === other.line && error.text === other.text && error.message === other.message
    }))

/** A canvas between blocks: its state, or a tombstone after `close` that still remembers the generation. */
interface Node {
  readonly state?: CanvasState
  readonly generation: number
  readonly removed: boolean
}

/** The last computation at one block position, so a growing block applies only its new patches. */
interface Applied {
  readonly input: Spec | null
  readonly replace: boolean
  readonly patches: readonly Patch[]
  readonly output: Spec | null
  readonly node: Node
}

interface CanvasCache {
  readonly empty: Node
  readonly snapshots: WeakMap<CanvasSnapshot, Node>
  readonly steps: WeakMap<CanvasBlock, { readonly prev: Node; readonly next: Node }>
  applied: Map<string, Applied>
}

const refKey = (ref: BlockRef) => `${ref.messageID}\u0000${ref.part}\u0000${ref.ordinal}`

const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1")

/**
 * Whether a block replaces the canvas rather than patching it. The header's `mode` decides when there is one;
 * otherwise a block that sets `/root` replaces, unless the canvas already has the element it points at and the block
 * does not add that element itself: a patch that switches the view (`{"op":"replace","path":"/root","value":"done"}`).
 * Adding it is an `add`, `copy` or `move` to `/elements/<root>`, or an `/elements` map that holds it; a `replace` of
 * that element (which RFC 6902 allows only on a member that exists) updates it as part of the patch. While a whole
 * canvas streams with the same root key, its first lines patch (the old canvas stays in view) until the root element
 * arrives.
 */
function replaces(block: ParsedBlock, current: Spec | null): boolean {
  if (block.header.mode !== undefined) return block.header.mode === "replace"
  if (!block.hasRoot) return false
  if (current === null) return true
  let root: unknown
  for (const patch of block.patches)
    if ((patch.op === "add" || patch.op === "replace") && patch.path === "/root") root = patch.value
  if (typeof root !== "string" || !Object.hasOwn(current.elements ?? {}, root)) return true
  const own = `/elements/${pointer(root)}`
  return block.patches.some(
    (patch) =>
      ((patch.op === "add" || patch.op === "copy" || patch.op === "move") && patch.path === own) ||
      ((patch.op === "add" || patch.op === "replace") &&
        patch.path === "/elements" &&
        typeof patch.value === "object" &&
        patch.value !== null &&
        Object.hasOwn(patch.value, root)),
  )
}

/**
 * A memoized `foldCanvases`. Per canvas it remembers the state after each block, keyed by the block object and the
 * state before it, so when only the streaming block changed only that block is applied again, and only its new
 * patches when the block merely grew. A canvas whose blocks did not change keeps its `CanvasState` object, and specs
 * keep the identity of everything a block did not touch, which is what the renderer compares.
 *
 * A snapshot this folder produced (a `settled` value) resumes from the state that produced it, so persisting and
 * reading back a canvas does not rebuild it.
 */
export function createCanvasFolder(): Fold {
  const caches = new Map<string, CanvasCache>()
  const producedBy = new WeakMap<CanvasSnapshot, Node>()

  const cacheFor = (id: string) => {
    let cache = caches.get(id)
    if (!cache) {
      cache = {
        empty: { generation: 0, removed: false },
        snapshots: new WeakMap(),
        steps: new WeakMap(),
        applied: new Map(),
      }
      caches.set(id, cache)
    }
    return cache
  }

  const initial = (id: string, cache: CanvasCache, snapshot: CanvasSnapshot | undefined): Node => {
    if (!snapshot) return cache.empty
    const produced = producedBy.get(snapshot)
    if (produced?.state?.id === id) return produced
    let node = cache.snapshots.get(snapshot)
    if (!node) {
      node = {
        state: {
          id,
          ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
          spec: snapshot.spec,
          generation: snapshot.generation,
          streaming: false,
          missingBase: false,
          first: snapshot.first ?? snapshot.after,
          last: snapshot.after,
          lineErrors: NO_ERRORS,
          settled: snapshot,
        },
        generation: snapshot.generation,
        removed: false,
      }
      cache.snapshots.set(snapshot, node)
    }
    return node
  }

  // Re-applies only what is new when the block at this position grew from the same input.
  const extend = (applied: Applied | undefined, replace: boolean, input: Spec | null, patches: readonly Patch[]) => {
    if (!applied || applied.output === null || applied.replace !== replace) return
    if (!replace && applied.input !== input) return
    const known = applied.patches
    if (known.length > patches.length) return
    for (let index = 0; index < known.length; index++) if (!samePatch(known[index]!, patches[index]!)) return
    return applyPatches(applied.output, patches, known.length)
  }

  const step = (id: string, cache: CanvasCache, visited: Set<string>, prev: Node, item: CanvasBlock): Node => {
    const key = refKey(item.ref)
    visited.add(key)
    const memo = cache.steps.get(item)
    if (memo && memo.prev === prev) return memo.next

    const applied = cache.applied.get(key)
    const previous = applied?.node
    let next: Node

    if (item.block.header.close) {
      next =
        previous?.removed && previous.generation === prev.generation
          ? previous
          : { generation: prev.generation, removed: true }
      cache.applied.set(key, { input: null, replace: false, patches: [], output: null, node: next })
    } else {
      const { header, patches } = item.block
      const before = prev.state
      const input = before?.spec ?? null
      const replace = replaces(item.block, input)
      let spec: Spec | null
      let missingBase: boolean
      if (replace) {
        spec = extend(applied, true, null, patches) ?? applyPatches(EMPTY_SPEC, patches)
        missingBase = false
      } else if (patches.length === 0) {
        spec = input
        missingBase = before?.missingBase ?? false
      } else {
        spec = extend(applied, false, input, patches) ?? applyPatches(input ?? EMPTY_SPEC, patches)
        missingBase = (before?.missingBase ?? false) || input === null
      }

      const generation = replace ? prev.generation + 1 : prev.generation
      const title = header.title ?? before?.title
      const first = before?.first ?? item.ref
      const old = previous?.state
      let settled = before?.settled
      if (item.closed && item.complete && spec !== null && !missingBase) {
        const reuse = old?.settled
        settled =
          reuse &&
          reuse.spec === spec &&
          reuse.title === title &&
          reuse.generation === generation &&
          sameRef(reuse.after, item.ref) &&
          sameRef(reuse.first, first)
            ? reuse
            : { ...(title !== undefined ? { title } : {}), spec, after: item.ref, generation, first }
      }
      const lineErrors =
        item.block.errors.length === 0
          ? NO_ERRORS
          : old && sameErrors(old.lineErrors, item.block.errors)
            ? old.lineErrors
            : item.block.errors
      const streaming = !item.closed && !item.complete

      if (
        previous !== undefined &&
        old !== undefined &&
        old.spec === spec &&
        old.title === title &&
        old.generation === generation &&
        old.streaming === streaming &&
        old.missingBase === missingBase &&
        sameRef(old.first, first) &&
        sameRef(old.last, item.ref) &&
        old.lineErrors === lineErrors &&
        old.settled === settled
      ) {
        next = previous
      } else {
        next = {
          state: {
            id,
            ...(title !== undefined ? { title } : {}),
            spec,
            generation,
            streaming,
            missingBase,
            first,
            last: item.ref,
            lineErrors,
            ...(settled ? { settled } : {}),
          },
          generation,
          removed: false,
        }
      }
      if (settled && settled !== before?.settled) producedBy.set(settled, next)
      cache.applied.set(key, { input: replace ? null : input, replace, patches, output: spec, node: next })
    }

    cache.steps.set(item, { prev, next })
    return next
  }

  return (base, blocks) => {
    const nodes = new Map<string, Node>()
    const visited = new Map<string, Set<string>>()
    const start = (id: string) => {
      let node = nodes.get(id)
      if (!node) {
        node = initial(id, cacheFor(id), own(base, id))
        nodes.set(id, node)
        visited.set(id, new Set())
      }
      return node
    }

    for (const id of Object.keys(base)) start(id)
    for (const item of blocks) {
      const id = item.canvas
      const snapshot = own(base, id)
      if (snapshot && compareRefs(item.ref, snapshot.after) <= 0) continue
      const prev = start(id)
      nodes.set(id, step(id, cacheFor(id), visited.get(id)!, prev, item))
    }

    // Forget positions and canvases this fold no longer has.
    for (const [id, cache] of caches) {
      const seen = visited.get(id)
      if (!seen) {
        caches.delete(id)
        continue
      }
      for (const key of cache.applied.keys()) if (!seen.has(key)) cache.applied.delete(key)
    }

    const live: CanvasState[] = []
    const removed = new Set<string>()
    for (const [id, node] of nodes) {
      if (node.state) live.push(node.state)
      else if (node.removed) removed.add(id)
    }
    live.sort((a, b) => compareRefs(a.first, b.first) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { canvases: new Map(live.map((state) => [state.id, state])), removed }
  }
}
