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

/** Splits an RFC 6901 pointer into tokens, or returns undefined for a pointer that is not one. */
export function parsePointer(path: string): string[] | undefined {
  if (path === "") return []
  if (!path.startsWith("/")) return undefined
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
function setAt(doc: unknown, tokens: readonly string[], value: unknown, insert: boolean): unknown {
  const [head, ...rest] = tokens
  if (head === undefined) return value

  if (Array.isArray(doc)) {
    const index = arrayIndex(head, doc.length, true)
    if (index < 0) return doc
    if (rest.length === 0) {
      if (!insert && index < doc.length && Object.is(doc[index], value)) return doc
      const next = doc.slice()
      if (insert) next.splice(index, 0, value)
      else next[index] = value
      return next
    }
    const child = setAt(doc[index], rest, value, insert)
    if (child === doc[index]) return doc
    const next = doc.slice()
    next[index] = child
    return next
  }

  const source = isObject(doc) ? doc : {}
  const child = rest.length === 0 ? value : setAt(source[head], rest, value, insert)
  if (isObject(doc) && Object.hasOwn(source, head) && Object.is(source[head], child)) return doc
  return { ...source, [head]: child }
}

function removeAt(doc: unknown, tokens: readonly string[]): unknown {
  const [head, ...rest] = tokens
  if (head === undefined) return doc

  if (Array.isArray(doc)) {
    const index = arrayIndex(head, doc.length, false)
    if (index < 0) return doc
    if (rest.length === 0) return doc.toSpliced(index, 1)
    const child = removeAt(doc[index], rest)
    if (child === doc[index]) return doc
    const next = doc.slice()
    next[index] = child
    return next
  }

  if (!isObject(doc) || !Object.hasOwn(doc, head)) return doc
  if (rest.length === 0) {
    const { [head]: _removed, ...next } = doc
    return next
  }
  const child = removeAt(doc[head], rest)
  return child === doc[head] ? doc : { ...doc, [head]: child }
}

/**
 * Applies one operation without mutating `doc`: containers on the path are copied and everything else is shared, so a
 * renderer that compares by identity updates only what changed. It never throws. An operation that cannot apply (a bad
 * pointer, a missing source) returns `doc` itself; "replace" sets a missing target, as json-render's streams expect.
 */
export function applyPatch<T>(doc: T, patch: Patch): T {
  const tokens = parsePointer(patch.path)
  if (!tokens) return doc

  switch (patch.op) {
    case "add":
      return setAt(doc, tokens, patch.value, true) as T
    case "replace":
      return setAt(doc, tokens, patch.value, false) as T
    case "remove":
      return removeAt(doc, tokens) as T
    case "move":
    case "copy": {
      const from = patch.from === undefined ? undefined : parsePointer(patch.from)
      if (!from) return doc
      const value = getAt(doc, from)
      if (value === undefined) return doc
      const base = patch.op === "move" ? removeAt(doc, from) : doc
      return setAt(base, tokens, value, true) as T
    }
    default:
      return doc
  }
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
