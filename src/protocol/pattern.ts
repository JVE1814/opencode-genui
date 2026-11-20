/**
 * Validation checks that are safe to run on the app's main thread.
 *
 * json-render's built-in `pattern` check runs `new RegExp(pattern).test(value)`, and a model-written pattern such as
 * `^(a+)+$` backtracks for hours on a 40-character value; its built-in `email` regex is quadratic in the value's length.
 * The normalizer (src/protocol/normalize.ts) rewrites both to the checks here, which the renderer registers as custom
 * validation functions (VALIDATION_FUNCTIONS):
 *
 * - A pattern runs on an automaton (a Thompson NFA, as RE2 does), in time linear in the value for any pattern. Its
 *   syntax is JavaScript's without flags (with Annex B's legacy escapes, such as octal `\12`), minus backreferences and
 *   lookarounds; a pattern that uses them, or is longer
 *   than MAX_PATTERN_LENGTH, or compiles to more than MAX_STATES states, is ignored (the check passes) and the validator
 *   reports it.
 * - A value longer than MAX_PATTERN_INPUT (or MAX_EMAIL_LENGTH) fails the check without running it.
 * - All pattern checks together get PATTERN_BUDGET units of work (about one automaton step each) per
 *   PATTERN_BUDGET_WINDOW_MS, however many fields and checks a spec has: a check that would exceed it is skipped (it
 *   passes, like a pattern genui cannot run). A spec cannot freeze the window with many expensive checks.
 */

/** Longest pattern a `pattern` check may have. */
export const MAX_PATTERN_LENGTH = 256
/** Longest value a pattern runs on; a longer value fails the check. */
export const MAX_PATTERN_INPUT = 1000
/** Longest value the email check runs on; a longer value fails it. */
export const MAX_EMAIL_LENGTH = 320
/** Most automaton states a pattern may compile to (repeats like `{2,40}` are expanded). */
const MAX_STATES = 2000
/**
 * Work all pattern checks may do per PATTERN_BUDGET_WINDOW_MS: one unit per automaton state visited, plus a character
 * class's size per test against it: about 25 ms of matching in the worst case. A check of an ordinary pattern on a long
 * value uses a few thousand.
 */
export const PATTERN_BUDGET = 1_000_000
export const PATTERN_BUDGET_WINDOW_MS = 1000

/** The check types the normalizer rewrites json-render's built-ins to. */
export const SAFE_CHECKS = { pattern: "genuiPattern", email: "genuiEmail" } as const

/**
 * The check a dynamic check (a `checks` list or entry written as an expression) is replaced with: it always passes, and
 * the validator reports it. A dynamic entry could resolve to a built-in `pattern` check at runtime.
 */
export const IGNORED_CHECK = "genuiIgnored"

// ---------------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------------

type Test = (code: number) => boolean
type AssertKind = "start" | "end" | "boundary" | "notBoundary"

type Node =
  | { readonly t: "char"; readonly test: Test; readonly cost?: number }
  | { readonly t: "assert"; readonly kind: AssertKind }
  | { readonly t: "seq"; readonly items: readonly Node[] }
  | { readonly t: "alt"; readonly options: readonly Node[] }
  | { readonly t: "repeat"; readonly node: Node; readonly min: number; readonly max: number }

class Unsupported extends Error {}

const isDigit: Test = (c) => c >= 48 && c <= 57
const isWord: Test = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
// JavaScript's \s: WhiteSpace and LineTerminator.
const isSpace: Test = (c) =>
  (c >= 9 && c <= 13) ||
  c === 32 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff
const isLineTerminator: Test = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029
const not =
  (test: Test): Test =>
  (c) =>
    !test(c)
const literal =
  (code: number): Test =>
  (c) =>
    c === code

const CLASS_ESCAPES: Readonly<Record<string, Test>> = {
  d: isDigit,
  D: not(isDigit),
  w: isWord,
  W: not(isWord),
  s: isSpace,
  S: not(isSpace),
}
const CONTROL_ESCAPES: Readonly<Record<string, number>> = { t: 9, n: 10, v: 11, f: 12, r: 13 }
const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/

/**
 * The capturing groups of a pattern, counted before parsing: without the `u` flag, `\N` is a backreference only when the
 * pattern has at least N capturing groups (anywhere in it), and `\k` only when it has a named one; otherwise they are
 * the legacy escapes of Annex B (see Parser#escapeCode).
 */
function countGroups(src: string): { readonly count: number; readonly named: boolean } {
  let count = 0
  let named = false
  let inClass = false
  for (let index = 0; index < src.length; index++) {
    const c = src[index]
    if (c === "\\") index++
    else if (inClass) inClass = c !== "]"
    else if (c === "[") inClass = true
    else if (c === "(") {
      if (src[index + 1] !== "?") count++
      else if (src[index + 2] === "<" && src[index + 3] !== "=" && src[index + 3] !== "!") {
        count++
        named = true
      }
    }
  }
  return { count, named }
}

const isOctal = (code: number) => code >= 48 && code <= 55

class Parser {
  private pos = 0
  private readonly src: string
  private readonly groups: ReturnType<typeof countGroups>

  constructor(src: string) {
    this.src = src
    this.groups = countGroups(src)
  }

  parse(): Node {
    const node = this.alternation()
    if (this.pos < this.src.length) throw new Unsupported(`unmatched ")" at ${this.pos}`)
    return node
  }

  private peek(offset = 0): string {
    return this.src.charAt(this.pos + offset)
  }

  private alternation(): Node {
    const options = [this.sequence()]
    while (this.peek() === "|") {
      this.pos++
      options.push(this.sequence())
    }
    return options.length === 1 ? options[0]! : { t: "alt", options }
  }

  private sequence(): Node {
    const items: Node[] = []
    while (this.pos < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      const atom = this.atom()
      items.push(this.quantified(atom))
    }
    return items.length === 1 ? items[0]! : { t: "seq", items }
  }

  private quantified(atom: Node): Node {
    let min: number
    let max: number
    const c = this.peek()
    if (c === "*" || c === "+" || c === "?") {
      this.pos++
      min = c === "+" ? 1 : 0
      max = c === "?" ? 1 : Infinity
    } else if (c === "{") {
      const match = QUANTIFIER.exec(this.src.slice(this.pos))
      // Without the `u` flag, a `{` that does not start a quantifier is a literal.
      if (!match) return atom
      this.pos += match[0].length
      min = Number(match[1])
      max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3])
      if (max < min) throw new Unsupported("numbers out of order in a {} quantifier")
      if (min > MAX_STATES || (max !== Infinity && max > MAX_STATES))
        throw new Unsupported("a repeat count is too large")
    } else return atom
    if (atom.t === "assert") throw new Unsupported("nothing to repeat")
    // A lazy quantifier matches the same strings; only which match is found differs.
    if (this.peek() === "?") this.pos++
    return { t: "repeat", node: atom, min, max }
  }

  private atom(): Node {
    const c = this.peek()
    switch (c) {
      case "(":
        return this.group()
      case "[":
        return this.characterClass()
      case ".":
        this.pos++
        return { t: "char", test: not(isLineTerminator) }
      case "^":
        this.pos++
        return { t: "assert", kind: "start" }
      case "$":
        this.pos++
        return { t: "assert", kind: "end" }
      case "\\":
        return this.escape()
      case "*":
      case "+":
      case "?":
        throw new Unsupported("nothing to repeat")
      case "{":
        if (QUANTIFIER.test(this.src.slice(this.pos))) throw new Unsupported("nothing to repeat")
        this.pos++
        return { t: "char", test: literal(123) }
      default:
        this.pos++
        return { t: "char", test: literal(c.charCodeAt(0)) }
    }
  }

  private group(): Node {
    this.pos++
    if (this.peek() === "?") {
      const next = this.peek(1)
      if (next === ":") this.pos += 2
      else if (next === "<" && this.peek(2) !== "=" && this.peek(2) !== "!") {
        const end = this.src.indexOf(">", this.pos)
        if (end === -1 || !/^[A-Za-z_$][\w$]*$/.test(this.src.slice(this.pos + 2, end)))
          throw new Unsupported("invalid group name")
        this.pos = end + 1
      } else throw new Unsupported("lookarounds are not supported")
    }
    const node = this.alternation()
    if (this.peek() !== ")") throw new Unsupported("unterminated group")
    this.pos++
    // A group may be quantified even when all it holds is an assertion (`(^)?`, `(?:\b)+`); a bare one may not.
    return node.t === "assert" ? { t: "seq", items: [node] } : node
  }

  /**
   * Annex B's legacy octal escape, after `\` and its first digit `first` (0-7): up to three digits from 0-3, up to two
   * from 4-7 (so at most 0o377).
   */
  private octal(first: string): number {
    let value = Number(first)
    const digits = first <= "3" ? 3 : 2
    for (let count = 1; count < digits && isOctal(this.src.charCodeAt(this.pos)); count++) {
      value = value * 8 + (this.src.charCodeAt(this.pos) - 48)
      this.pos++
    }
    return value
  }

  /**
   * One escape after `\`, outside or (`inClass`) inside a character class: a single code unit, a set (\d, \w, ...),
   * or an assertion.
   */
  private escapeCode(inClass: boolean): number | Test | AssertKind {
    this.pos++
    const c = this.peek()
    if (c === "") throw new Unsupported("\\ at end of pattern")
    this.pos++
    if (Object.hasOwn(CLASS_ESCAPES, c)) return CLASS_ESCAPES[c]!
    if (Object.hasOwn(CONTROL_ESCAPES, c)) return CONTROL_ESCAPES[c]!
    if (c === "b") return inClass ? 8 : "boundary"
    if (c === "B" && !inClass) return "notBoundary"
    if (c === "0" && !isDigit(this.src.charCodeAt(this.pos))) return 0
    if (isDigit(c.charCodeAt(0))) {
      // Outside a class, `\N` refers to group N when the pattern has that many; otherwise (and always in a class) it is
      // a legacy octal escape, or 8 or 9 as itself (JavaScript without the `u` flag, Annex B).
      if (!inClass && c !== "0" && Number(c + /^\d*/.exec(this.src.slice(this.pos))![0]) <= this.groups.count)
        throw new Unsupported("backreferences are not supported")
      return c === "8" || c === "9" ? c.charCodeAt(0) : this.octal(c)
    }
    // `\k<name>` refers to a named group; in a pattern without one, `\k` is a plain "k".
    if (c === "k" && this.groups.named) throw new Unsupported("backreferences are not supported")
    if (c === "x" && /^[0-9a-fA-F]{2}/.test(this.src.slice(this.pos))) {
      const code = parseInt(this.src.slice(this.pos, this.pos + 2), 16)
      this.pos += 2
      return code
    }
    if (c === "u" && /^[0-9a-fA-F]{4}/.test(this.src.slice(this.pos))) {
      const code = parseInt(this.src.slice(this.pos, this.pos + 4), 16)
      this.pos += 4
      return code
    }
    if (c === "c") {
      const code = this.src.charCodeAt(this.pos)
      // A letter, and in a class also a digit or `_`, names a control character (Annex B for the last two).
      if (/[A-Za-z]/.test(this.peek()) || (inClass && (isDigit(code) || code === 95))) {
        this.pos++
        return code % 32
      }
      // Otherwise the `\` stands for itself and the `c` is read next (Annex B).
      this.pos--
      return 92
    }
    // Any other escaped character stands for itself (JavaScript without the `u` flag).
    return c.charCodeAt(0)
  }

  private escape(): Node {
    const result = this.escapeCode(false)
    if (typeof result === "string") return { t: "assert", kind: result }
    return { t: "char", test: typeof result === "number" ? literal(result) : result }
  }

  private characterClass(): Node {
    this.pos++
    const negate = this.peek() === "^"
    if (negate) this.pos++
    const tests: Test[] = []
    const ranges: [number, number][] = []
    // One class atom: a single code unit (a number) or a set (\d, \w, ...).
    const classAtom = (): number | Test => {
      if (this.peek() === "\\") {
        const result = this.escapeCode(true)
        if (typeof result === "string") throw new Unsupported("unexpected assertion in a class")
        return result
      }
      const code = this.src.charCodeAt(this.pos)
      this.pos++
      return code
    }
    while (this.peek() !== "]") {
      if (this.pos >= this.src.length) throw new Unsupported("unterminated character class")
      const first = classAtom()
      if (this.peek() === "-" && this.peek(1) !== "]" && this.pos + 1 < this.src.length) {
        this.pos++
        const second = classAtom()
        if (typeof first === "number" && typeof second === "number") {
          if (second < first) throw new Unsupported("range out of order in a character class")
          ranges.push([first, second])
        } else {
          // `[\d-z]`: without the `u` flag the dash is a literal.
          for (const part of [first, second]) {
            if (typeof part === "number") ranges.push([part, part])
            else tests.push(part)
          }
          ranges.push([45, 45])
        }
        continue
      }
      if (typeof first === "number") ranges.push([first, first])
      else tests.push(first)
    }
    this.pos++
    const inClass: Test = (c) => ranges.some(([low, high]) => c >= low && c <= high) || tests.some((test) => test(c))
    return { t: "char", test: negate ? not(inClass) : inClass, cost: 1 + ranges.length + tests.length }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Automaton
// ---------------------------------------------------------------------------------------------------------------------

const CHAR = 0
const SPLIT = 1
const ASSERT = 2
const MATCH = 3

interface State {
  readonly kind: typeof CHAR | typeof SPLIT | typeof ASSERT | typeof MATCH
  readonly test?: Test
  /** Work units a test against this state costs (its class's size). */
  readonly cost?: number
  readonly assert?: AssertKind
  readonly next: number[]
}

interface Fragment {
  readonly start: number
  /** Unpatched exits: [state, index into its `next`]. */
  readonly outs: [number, number][]
}

function compile(root: Node): { states: State[]; start: number } {
  const states: State[] = []
  const add = (state: State) => {
    if (states.length >= MAX_STATES) throw new Unsupported("the pattern is too complex")
    states.push(state)
    return states.length - 1
  }
  const patch = (outs: readonly [number, number][], target: number) => {
    for (const [state, index] of outs) states[state]!.next[index] = target
  }
  const empty = (): Fragment => {
    const state = add({ kind: SPLIT, next: [-1] })
    return { start: state, outs: [[state, 0]] }
  }
  const build = (node: Node): Fragment => {
    switch (node.t) {
      case "char": {
        const state = add({ kind: CHAR, test: node.test, cost: node.cost ?? 1, next: [-1] })
        return { start: state, outs: [[state, 0]] }
      }
      case "assert": {
        const state = add({ kind: ASSERT, assert: node.kind, next: [-1] })
        return { start: state, outs: [[state, 0]] }
      }
      case "seq": {
        if (node.items.length === 0) return empty()
        const fragments = node.items.map(build)
        for (let index = 0; index < fragments.length - 1; index++)
          patch(fragments[index]!.outs, fragments[index + 1]!.start)
        return { start: fragments[0]!.start, outs: fragments.at(-1)!.outs }
      }
      case "alt": {
        const fragments = node.options.map(build)
        const state = add({ kind: SPLIT, next: fragments.map((fragment) => fragment.start) })
        return { start: state, outs: fragments.flatMap((fragment) => fragment.outs) }
      }
      case "repeat": {
        const parts: Fragment[] = []
        for (let index = 0; index < node.min; index++) parts.push(build(node.node))
        const exits: [number, number][] = []
        if (node.max === Infinity) {
          const loop = add({ kind: SPLIT, next: [-1, -1] })
          const body = build(node.node)
          states[loop]!.next[0] = body.start
          patch(body.outs, loop)
          parts.push({ start: loop, outs: [[loop, 1]] })
        } else {
          // Optional copies: each may be skipped, which skips the rest too.
          for (let index = node.min; index < node.max; index++) {
            const choice = add({ kind: SPLIT, next: [-1, -1] })
            const body = build(node.node)
            states[choice]!.next[0] = body.start
            exits.push([choice, 1])
            parts.push({ start: choice, outs: body.outs })
          }
        }
        if (parts.length === 0) return empty()
        for (let index = 0; index < parts.length - 1; index++) patch(parts[index]!.outs, parts[index + 1]!.start)
        return { start: parts[0]!.start, outs: [...parts.at(-1)!.outs, ...exits] }
      }
    }
  }
  const fragment = build(root)
  patch(fragment.outs, add({ kind: MATCH, next: [] }))
  return { states, start: fragment.start }
}

/** Work units left for matching; `test` spends from it. */
export interface Budget {
  left: number
}

/**
 * A compiled pattern: `test` is RegExp#test (a search, no flags) in time linear in the value. With a budget, it gives
 * up (undefined) once the budget is spent.
 */
export interface SafePattern {
  test(value: string): boolean
  test(value: string, budget: Budget): boolean | undefined
}

const UNLIMITED: Budget = { left: Infinity }

class OutOfBudget extends Error {}

function automaton({ states, start }: { readonly states: readonly State[]; readonly start: number }): SafePattern {
  const test = (value: string, budget: Budget = UNLIMITED): boolean | undefined => {
    try {
      return run(value, budget)
    } catch (error) {
      if (error instanceof OutOfBudget) return undefined
      throw error
    }
  }
  return { test } as SafePattern

  function run(value: string, budget: Budget): boolean {
    const length = value.length
    const marks = new Int32Array(states.length).fill(-1)
    const wordAt = (index: number) => index >= 0 && index < length && isWord(value.charCodeAt(index))
    const holds = (kind: AssertKind, index: number) =>
      kind === "start"
        ? index === 0
        : kind === "end"
          ? index === length
          : (wordAt(index - 1) !== wordAt(index)) === (kind === "boundary")
    let matched = false
    const stack: number[] = []
    // Adds a state and everything reachable from it without reading a character, at position `index`.
    const close = (list: number[], from: number, index: number, generation: number) => {
      stack.push(from)
      while (stack.length > 0) {
        const id = stack.pop()!
        if (id < 0 || marks[id] === generation) continue
        if (--budget.left < 0) throw new OutOfBudget()
        marks[id] = generation
        const state = states[id]!
        if (state.kind === MATCH) matched = true
        else if (state.kind === CHAR) list.push(id)
        else if (state.kind === SPLIT) for (let k = state.next.length - 1; k >= 0; k--) stack.push(state.next[k]!)
        else if (holds(state.assert!, index)) stack.push(state.next[0]!)
      }
    }
    let current: number[] = []
    for (let index = 0; ; index++) {
      // A search: a match may start at any position.
      close(current, start, index, index)
      if (matched) return true
      if (index === length) return false
      const code = value.charCodeAt(index)
      const next: number[] = []
      for (const id of current) {
        const state = states[id]!
        if ((budget.left -= state.cost!) < 0) throw new OutOfBudget()
        if (state.test!(code)) close(next, state.next[0]!, index + 1, index + 1)
      }
      if (matched) return true
      current = next
    }
  }
}

const cache = new Map<string, SafePattern | string>()

/**
 * Compiles a pattern for safe matching, or says why it cannot be used: too long, invalid, or using a feature the
 * automaton does not support (backreferences, lookarounds).
 */
export function compilePattern(source: string): SafePattern | string {
  const cached = cache.get(source)
  if (cached !== undefined) return cached
  let result: SafePattern | string
  if (source.length > MAX_PATTERN_LENGTH) result = `it is longer than ${MAX_PATTERN_LENGTH} characters`
  else {
    try {
      // The browser's parser decides what is valid JavaScript syntax; compiling is cheap, only matching can be slow.
      new RegExp(source)
      result = automaton(compile(new Parser(source).parse()))
    } catch (error) {
      result =
        error instanceof Unsupported
          ? error.message
          : `it is not a valid regular expression${error instanceof Error ? ` (${error.message})` : ""}`
    }
  }
  if (cache.size >= 200) cache.clear()
  cache.set(source, result)
  return result
}

/** Why a literal pattern cannot be used (see compilePattern), or undefined when it can. */
export function patternProblem(source: string): string | undefined {
  const result = compilePattern(source)
  return typeof result === "string" ? result : undefined
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The budget every pattern check of the window shares (PATTERN_BUDGET per PATTERN_BUDGET_WINDOW_MS).
const budget: Budget & { since: number } = { left: PATTERN_BUDGET, since: -Infinity }
function sharedBudget(): Budget {
  const now = Date.now()
  // (A clock that went back starts a new window too.)
  if (now < budget.since || now - budget.since >= PATTERN_BUDGET_WINDOW_MS) {
    budget.since = now
    budget.left = PATTERN_BUDGET
  }
  return budget
}

/** The custom validation functions the renderer registers (json-render's ValidationProvider `customFunctions`). */
export const VALIDATION_FUNCTIONS: Readonly<
  Record<string, (value: unknown, args?: Record<string, unknown>) => boolean>
> = {
  [SAFE_CHECKS.pattern]: (value, args) => {
    if (typeof value !== "string") return false
    const source = args?.pattern
    if (typeof source !== "string") return false
    const pattern = compilePattern(source)
    // A pattern genui cannot run is ignored (the validator reports it), as json-render ignores unknown checks.
    if (typeof pattern === "string") return true
    if (value.length > MAX_PATTERN_INPUT) return false
    // So is a check that would take more than what is left of the shared budget.
    return pattern.test(value, sharedBudget()) ?? true
  },
  [SAFE_CHECKS.email]: (value) => {
    if (typeof value !== "string") return false
    const text = value.trim()
    return text.length <= MAX_EMAIL_LENGTH && EMAIL.test(text)
  },
  [IGNORED_CHECK]: () => true,
}
