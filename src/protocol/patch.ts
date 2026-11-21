import type { Spec } from "@json-render/core"

/** One RFC 6902 operation, as json-render streams them, one per line. */
export interface Patch {
  readonly op: "add" | "replace" | "remove" | "move" | "copy" | "test"
  readonly path: string
  readonly value?: unknown
  readonly from?: string
}

export const EMPTY_SPEC: Spec = Object.freeze({ root: "", elements: Object.freeze({}) }) as Spec

// A model-written path must never reach an object's prototype.
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"])

/**
 * How deep and long a JSON pointer may be (spec patches, state actions, bindings, agent patches). Nothing a UI does
 * needs more, and a pointer of 50,000 segments in a 100 KB block cost seconds wherever it was walked (the stack
 * overflowed, and a click crashed the window's renderer). Longer pointers are refused: a patch line with one is a line
 * error (see parseBlock in ./surface.ts), and a write to one is ignored.
 */
export const MAX_POINTER_DEPTH = 64
export const MAX_POINTER_LENGTH = 2048

/** Why a pointer is refused for its size (see MAX_POINTER_DEPTH), or undefined when it is within the bounds. */
export function pointerTooLarge(path: string): string | undefined {
  if (path.length > MAX_POINTER_LENGTH)
    return `the path is ${path.length.toLocaleString("en-US")} characters long: a path has at most ${MAX_POINTER_LENGTH.toLocaleString("en-US")} characters and ${MAX_POINTER_DEPTH} levels`
  let depth = 0
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1))
    if (++depth > MAX_POINTER_DEPTH)
      return `the path is nested more than ${MAX_POINTER_DEPTH} levels deep: a path has at most ${MAX_POINTER_DEPTH} levels`
  return undefined
}

/**
 * Splits an RFC 6901 pointer into tokens, or returns undefined for a pointer that is not one, or that is deeper or
 * longer than MAX_POINTER_DEPTH and MAX_POINTER_LENGTH allow.
 */
export function parsePointer(path: string): string[] | undefined {
  if (path === "") return []
  if (!path.startsWith("/") || pointerTooLarge(path) !== undefined) return undefined
  const tokens = path
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
  return tokens.some((token) => FORBIDDEN.has(token)) ? undefined : tokens
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const arrayIndex = (token: string, length: number, allowEnd: boolean) => {
  if (token === "-") return allowEnd ? length : -1
  if (!/^(0|[1-9]\d*)$/.test(token)) return -1
  const index = Number(token)
  return index < length || (allowEnd && index === length) ? index : -1
}

/** Reads the value at a pointer, or undefined when the path does not exist. */
export function getAt(doc: unknown, tokens: readonly string[]): unknown {
  let current = doc
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = arrayIndex(token, current.length, false)
      if (index < 0) return undefined
      current = current[index]
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, token)) return undefined
      current = current[token]
    } else return undefined
  }
  return current
}

// Sets `value` at `tokens`, copying only the containers on the path. Missing parents are created as objects, because a
// stream may add `/elements/a` before anything created `/elements`. `insert` shifts later array items, as "add" does.
function setAt(doc: unknown, tokens: readonly string[], value: unknown, insert: boolean, depth = 0): unknown {
  const head = tokens[depth]
  if (head === undefined) return value
  const last = depth === tokens.length - 1

  if (Array.isArray(doc)) {
    const index = arrayIndex(head, doc.length, true)
    if (index < 0) return doc
    if (last) {
      if (!insert && index < doc.length && Object.is(doc[index], value)) return doc
      const next = doc.slice()
      if (insert) next.splice(index, 0, value)
      else next[index] = value
      return next
    }
    const child = setAt(doc[index], tokens, value, insert, depth + 1)
    if (child === doc[index]) return doc
    const next = doc.slice()
    next[index] = child
    return next
  }

  const source = isObject(doc) ? doc : {}
  const child = last ? value : setAt(source[head], tokens, value, insert, depth + 1)
  if (isObject(doc) && Object.hasOwn(source, head) && Object.is(source[head], child)) return doc
  return { ...source, [head]: child }
}

// setAt for "replace", into containers of `owned` (made by this same run) in place: each container on the paths is
// copied at most once, whatever number of values are set under it.
function setOwned(doc: unknown, tokens: readonly string[], depth: number, value: unknown, owned: Set<object>): unknown {
  const head = tokens[depth]
  if (head === undefined) return value
  if (Array.isArray(doc)) {
    const index = arrayIndex(head, doc.length, true)
    if (index < 0) return doc
    const child = setOwned(doc[index], tokens, depth + 1, value, owned)
    if (index < doc.length && Object.is(doc[index], child)) return doc
    let target = doc
    if (!owned.has(doc)) owned.add((target = doc.slice()))
    target[index] = child
    return target
  }
  const source = isObject(doc) ? doc : {}
  const child = setOwned(source[head], tokens, depth + 1, value, owned)
  if (isObject(doc) && Object.hasOwn(source, head) && Object.is(source[head], child)) return doc
  let target = source
  if (source !== doc || !owned.has(source)) owned.add((target = { ...source }))
  target[head] = child
  return target
}

/**
 * `replace` operations applied in order, as many `applyPatch` calls would (the same result), copying each container
 * on their paths once: one at a time, each copied every container on its path, so ten thousand values set under one
 * object copied it ten thousand times. Each path must be a parsed pointer (see `parsePointer`). `owned` receives the
 * containers made by this call.
 */
export function replaceAll<T>(
  doc: T,
  replacements: Iterable<readonly [tokens: readonly string[], value: unknown]>,
  owned = new Set<object>(),
): T {
  let next: unknown = doc
  for (const [tokens, value] of replacements) next = setOwned(next, tokens, 0, value, owned)
  return next as T
}

function removeAt(doc: unknown, tokens: readonly string[], depth = 0): unknown {
  const head = tokens[depth]
  if (head === undefined) return doc
  const last = depth === tokens.length - 1

  if (Array.isArray(doc)) {
    const index = arrayIndex(head, doc.length, false)
    if (index < 0) return doc
    if (last) return doc.toSpliced(index, 1)
    const child = removeAt(doc[index], tokens, depth + 1)
    if (child === doc[index]) return doc
    const next = doc.slice()
    next[index] = child
    return next
  }

  if (!isObject(doc) || !Object.hasOwn(doc, head)) return doc
  if (last) {
    const { [head]: _removed, ...next } = doc
    return next
  }
  const child = removeAt(doc[head], tokens, depth + 1)
  return child === doc[head] ? doc : { ...doc, [head]: child }
}

/**
 * How much "copy" operations may add to a document in all, in characters of its strings plus entries of its lists and
 * objects, counted as the copies read written out. A copy shares the value it copies (see `applyPatch`), so copying a
 * list into a new one twice, and that one into the next, doubled what the document holds written out at each step: 24
 * such steps, 4 KB, made a state of 800 million characters, and whatever turned it into text (a canvas's stored
 * snapshot, an expression) froze the window for seconds. A copy past this is not applied (see `copiesRefused`).
 */
export const MAX_COPIED = 1_000_000

// What copies added to each document so far (carried to the documents operations make from it), and whether one was
// refused.
const copies = new WeakMap<object, { readonly added: number; readonly refused: boolean }>()

/** Whether a "copy" was left out of `doc`, or of a document it was made from, for MAX_COPIED. */
export const copiesRefused = (doc: unknown): boolean =>
  typeof doc === "object" && doc !== null && copies.get(doc)?.refused === true

/** The size of a value written out (see MAX_COPIED), counting a shared part each time it is reached, up to past `max`. */
export function writtenSize(value: unknown, max: number): number {
  let size = 0
  const stack: unknown[] = [value]
  while (stack.length > 0 && size <= max) {
    const item = stack.pop()
    if (typeof item === "string") size += item.length
    else if (item && typeof item === "object") {
      const entries = Array.isArray(item) ? item : Object.values(item)
      size += entries.length
      for (const entry of entries) stack.push(entry)
    }
  }
  return size
}

function applyOne(doc: unknown, patch: Patch, tokens: readonly string[], added: number) {
  switch (patch.op) {
    case "add":
      return { next: setAt(doc, tokens, patch.value, true), added }
    case "replace":
      return { next: setAt(doc, tokens, patch.value, false), added }
    case "remove":
      return { next: removeAt(doc, tokens), added }
    case "move":
    case "copy": {
      const from = patch.from === undefined ? undefined : parsePointer(patch.from)
      if (!from) return { next: doc, added }
      const value = getAt(doc, from)
      if (value === undefined) return { next: doc, added }
      // RFC 6902: moving a value to where it is changes nothing, and moving it into its own child is an error.
      if (patch.op === "move" && from.length <= tokens.length && from.every((token, index) => token === tokens[index]))
        return { next: doc, added }
      if (patch.op === "move") return { next: setAt(removeAt(doc, from), tokens, value, true), added }
      const size = writtenSize(value, MAX_COPIED - added)
      if (added + size > MAX_COPIED) return undefined
      return { next: setAt(doc, tokens, value, true), added: added + size }
    }
    default:
      return { next: doc, added }
  }
}

/**
 * Applies one operation without mutating `doc`: containers on the path are copied and everything else is shared, so a
 * renderer that compares by identity updates only what changed. It never throws. An operation that cannot apply (a bad
 * pointer, a missing source) returns `doc` itself; "replace" sets a missing target, as json-render's streams expect. A
 * "copy" that would take the document's copies past MAX_COPIED is not applied either.
 */
export function applyPatch<T>(doc: T, patch: Patch): T {
  const tokens = parsePointer(patch.path)
  if (!tokens) return doc
  const record = typeof doc === "object" && doc !== null ? copies.get(doc) : undefined
  const result = applyOne(doc, patch, tokens, record?.added ?? 0)
  if (!result) {
    if (typeof doc !== "object" || doc === null) return doc
    // A document of its own says so, rather than the one before this operation (still the result of the ones before).
    const marked = Array.isArray(doc) ? [...doc] : { ...doc }
    copies.set(marked, { added: record?.added ?? 0, refused: true })
    return marked as T
  }
  const next = result.next
  if (next !== doc && typeof next === "object" && next !== null && (record || result.added > 0))
    copies.set(next, { added: result.added, refused: record?.refused ?? false })
  return next as T
}

/** Applies operations in order, starting at `from`, so a growing stream only pays for what is new. */
export function applyPatches<T>(doc: T, patches: readonly Patch[], from = 0): T {
  let next = doc
  for (let index = from; index < patches.length; index++) next = applyPatch(next, patches[index]!)
  return next
}

/** Whether an operation sets the spec's root, which starts a new generation of a canvas. */
export const setsRoot = (patch: Patch) =>
  (patch.op === "add" || patch.op === "replace") && (patch.path === "/root" || patch.path === "")
