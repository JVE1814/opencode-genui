import * as core from "@json-render/core"
import { resolvePropValue, type DirectiveDefinition } from "@json-render/core"

// json-render's standard directives (@json-render/directives) with the same results, at a bounded cost. Every row of a
// repeat resolves its element's props, on mount and on every change of the state they read, so what one directive
// costs is multiplied by the rows: `$format` built a new Intl formatter on every call (about 50 µs, so a block of 6 KB
// with 50 of them in each of 2,000 rows froze the window for 13 s), and `$truncate`, `$math`, `$pluralize` and `$format`
// turned a list into text in full first (String() of a list in state that holds one long list many times over is a
// hundred million characters). Here formatters are made once per directive in the spec, and a list is turned into
// text only as far as the result needs. `$count` costs nothing; `$concat` and `$join` are bounded in json-render's core
// (patches/@json-render%2Fcore). How many expressions are evaluated, and for how long, is bounded there too, which
// needs each of them to be cheap: Number(), new Date() and the Intl formatters read a string whole (2.5 ms for a million
// digits), and a tree of copies shares one node thousands of times, so a number or a date is read from at most
// MAX_PARSED_TEXT characters, and turning a list into text counts each item as an expression evaluated.

/** The most characters a directive turns a list into text for, when the result needs all of it. */
export const MAX_DIRECTIVE_TEXT = 1_000_000

/** The longest text read as a number or a date; a longer one is neither (as json-render's checks read it, see patches/). */
export const MAX_PARSED_TEXT = 512

// Counts expressions evaluated against the evaluation running now (patches/@json-render%2Fcore); without the patch, nothing.
const chargeEvaluation =
  (core as unknown as { readonly chargeEvaluation?: (cost: number) => void }).chargeEvaluation ?? (() => {})

/**
 * String(value), up to just past `max` characters: a list is joined with "," as String() does (an item that is null or
 * undefined adds nothing, a list inside is joined too), item by item, and the walk stops once the text is longer than
 * `max`. `cut` says that the whole text is longer than `max`; `text` then holds at least its first `max` characters.
 */
export function textOf(value: unknown, max: number): { readonly text: string; readonly cut: boolean } {
  if (value === null || value === undefined) return { text: "", cut: false }
  if (!Array.isArray(value)) {
    const text = String(value)
    return { text, cut: text.length > max }
  }
  let text = ""
  const stack: Array<{ readonly list: readonly unknown[]; index: number }> = [{ list: value, index: 0 }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    if (top.index >= top.list.length) {
      stack.pop()
      continue
    }
    if (top.index > 0) text += ","
    const item = top.list[top.index++]
    chargeEvaluation(1)
    if (Array.isArray(item)) stack.push({ list: item, index: 0 })
    else if (item !== null && item !== undefined) {
      const part = String(item)
      text += part.length > max + 1 - text.length ? part.slice(0, Math.max(0, max + 1 - text.length)) : part
    }
    if (text.length > max) return { text, cut: true }
  }
  return { text, cut: false }
}

/**
 * Number(value) without turning a list into text: a list of two or more items reads as text with a comma in it, so
 * NaN; an empty list as 0; a list of one item as that item's text. A text longer than MAX_PARSED_TEXT is NaN. Anything
 * else as Number() reads it.
 */
export function numberOf(value: unknown): number {
  if (!Array.isArray(value)) return typeof value === "string" && value.length > MAX_PARSED_TEXT ? NaN : Number(value)
  let current: unknown = value
  while (Array.isArray(current)) {
    if (current.length === 0) return 0
    if (current.length > 1) return NaN
    current = current[0]
  }
  if (current === null || current === undefined) return 0
  if (typeof current === "object") return NaN
  const text = String(current)
  return text.length > MAX_PARSED_TEXT ? NaN : Number(text)
}

/**
 * The value as `new Date()` or an Intl number formatter reads it, with a list turned into at most a little text; a text
 * longer than MAX_PARSED_TEXT, or such a list, is NaN.
 */
export function primitiveOf(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_PARSED_TEXT ? NaN : value
  if (!Array.isArray(value)) return value
  const { text, cut } = textOf(value, MAX_PARSED_TEXT)
  return cut ? NaN : text
}

// Formatters by the `$format` object of the spec they were made for (spec values are never changed in place), or the
// error making one threw (a bad locale or option), thrown again on every use.
const formatters = new WeakMap<object, Intl.DateTimeFormat | Intl.NumberFormat | { readonly error: unknown }>()

function formatter<T extends Intl.DateTimeFormat | Intl.NumberFormat>(raw: object, make: () => T): T {
  let known = formatters.get(raw)
  if (known === undefined) {
    let made: T | { readonly error: unknown }
    try {
      made = make()
    } catch (error) {
      made = { error }
    }
    formatters.set(raw, made)
    known = made
  }
  if ("error" in known) throw known.error
  return known as T
}

let mathWarned = false

// A directive object of the spec, as json-render passes it (its schema is checked by the catalog, not here).
type Raw = Record<string, any>
type Resolve = (raw: Raw, ctx: Parameters<DirectiveDefinition["resolve"]>[1]) => unknown

const resolvers: Readonly<Record<string, Resolve>> = {
  $format(raw: Raw, ctx) {
    const value = resolvePropValue(raw.value, ctx)
    const locale = raw.locale ?? undefined
    const extra = raw.options ?? {}
    switch (raw.$format) {
      case "date": {
        const date = value instanceof Date ? value : new Date(primitiveOf(value) as string | number)
        if (raw.style === "relative") {
          const now = raw.now ?? Date.now()
          const diff = now - date.getTime()
          if (diff === 0) return "just now"
          const absDiff = Math.abs(diff)
          const suffix = diff > 0 ? "ago" : "from now"
          const seconds = Math.floor(absDiff / 1e3)
          const minutes = Math.floor(seconds / 60)
          const hours = Math.floor(minutes / 60)
          const days = Math.floor(hours / 24)
          if (days > 0) return `${days}d ${suffix}`
          if (hours > 0) return `${hours}h ${suffix}`
          if (minutes > 0) return `${minutes}m ${suffix}`
          return `${seconds}s ${suffix}`
        }
        return formatter(raw, () => new Intl.DateTimeFormat(locale, extra)).format(date)
      }
      case "currency":
        return formatter(
          raw,
          () => new Intl.NumberFormat(locale, { style: "currency", currency: raw.currency ?? "USD", ...extra }),
        ).format(primitiveOf(value) as number)
      case "number":
        return formatter(
          raw,
          () => new Intl.NumberFormat(locale, { ...(raw.notation ? { notation: raw.notation } : {}), ...extra }),
        ).format(primitiveOf(value) as number)
      case "percent":
        return formatter(raw, () => new Intl.NumberFormat(locale, { style: "percent", ...extra })).format(
          primitiveOf(value) as number,
        )
      default:
        return value
    }
  },
  $math(raw: Raw, ctx) {
    const toNum = (v: unknown) => {
      if (v == null) return 0
      const n = numberOf(v)
      if (Number.isNaN(n)) {
        if (!mathWarned) {
          mathWarned = true
          console.warn("$math: non-numeric value coerced to 0")
        }
        return 0
      }
      return n
    }
    const a = toNum(resolvePropValue(raw.a, ctx))
    const b = toNum(resolvePropValue(raw.b, ctx))
    switch (raw.$math) {
      case "add":
        return a + b
      case "subtract":
        return a - b
      case "multiply":
        return a * b
      case "divide":
        return b !== 0 ? a / b : 0
      case "mod":
        return b !== 0 ? a % b : 0
      case "min":
        return Math.min(a, b)
      case "max":
        return Math.max(a, b)
      case "round":
        return Math.round(a)
      case "floor":
        return Math.floor(a)
      case "ceil":
        return Math.ceil(a)
      case "abs":
        return Math.abs(a)
      default:
        return a
    }
  },
  $truncate(raw: Raw, ctx) {
    const resolved = resolvePropValue(raw.$truncate, ctx)
    const maxLength = raw.length ?? 100
    const suffix = raw.suffix ?? "..."
    // A length that is not a count (negative cuts from the end) needs the whole text.
    const bounded = typeof maxLength === "number" && maxLength >= 0 && maxLength <= MAX_DIRECTIVE_TEXT
    const { text, cut } = textOf(resolved, bounded ? maxLength : MAX_DIRECTIVE_TEXT)
    if (cut && !bounded) return undefined
    if (!cut && text.length <= maxLength) return text
    return text.slice(0, maxLength) + suffix
  },
  $pluralize(raw: Raw, ctx) {
    const n = numberOf(resolvePropValue(raw.$pluralize, ctx))
    const count = Number.isNaN(n) ? 0 : n
    if (count === 0 && raw.zero != null) return raw.zero
    if (count === 1) return `${count} ${raw.one}`
    return `${count} ${raw.other}`
  },
}

/** A standard directive with its bounded resolver (see above), or the directive itself when it needs none. */
export function boundedDirective(directive: DirectiveDefinition): DirectiveDefinition {
  const resolve = Object.hasOwn(resolvers, directive.name) ? resolvers[directive.name] : undefined
  return resolve ? { ...directive, resolve: (value, ctx) => resolve(value as Raw, ctx) } : directive
}
