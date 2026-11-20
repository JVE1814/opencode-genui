import { afterEach, describe, expect, test } from "bun:test"
import {
  compilePattern,
  IGNORED_CHECK,
  MAX_EMAIL_LENGTH,
  MAX_PATTERN_INPUT,
  MAX_PATTERN_LENGTH,
  PATTERN_BUDGET,
  PATTERN_BUDGET_WINDOW_MS,
  patternProblem,
  SAFE_CHECKS,
  VALIDATION_FUNCTIONS,
} from "../../src/protocol/pattern.ts"
import { seeded } from "./random.ts"

const safePattern = VALIDATION_FUNCTIONS[SAFE_CHECKS.pattern]!
const safeEmail = VALIDATION_FUNCTIONS[SAFE_CHECKS.email]!

const timed = <T>(run: () => T): [T, number] => {
  const start = performance.now()
  const result = run()
  return [result, performance.now() - start]
}

describe("safe pattern checks", () => {
  test("the review's catastrophic pattern runs in linear time (RegExp takes seconds at 30 characters)", () => {
    for (const length of [30, 40, MAX_PATTERN_INPUT - 1]) {
      const [valid, ms] = timed(() => safePattern(`${"a".repeat(length)}!`, { pattern: "^(a+)+$" }))
      expect(valid).toBe(false)
      expect(ms).toBeLessThan(200)
    }
    expect(safePattern("aaaa", { pattern: "^(a+)+$" })).toBe(true)
  })

  test("other classic blow-ups stay fast", () => {
    const cases: [string, string][] = [
      ["^(a|a)*$", `${"a".repeat(900)}!`],
      ["^(a*)*b$", "a".repeat(900)],
      ["^(\\w+x){10}\\w+y$", "x".repeat(900)],
      ["^(.*a){12}$", "a".repeat(900)],
      ["(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u|v|w|x|y|z){1,60}!", "a".repeat(999)],
    ]
    for (const [pattern, value] of cases) {
      const [, ms] = timed(() => safePattern(value, { pattern }))
      expect(ms).toBeLessThan(500)
    }
  })

  test("matches as RegExp#test does (a search, no flags)", () => {
    const cases: [string, string[]][] = [
      ["^[a-z0-9-]+$", ["api", "api-gateway", "API", "a b", ""]],
      ["^v?\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$", ["1.2.3", "v1.2.3-rc.1", "1.2", "v1.2.3-"]],
      ["^\\d{1,3}(\\.\\d{1,3}){3}$", ["10.0.0.1", "1.2.3", "1234.1.1.1"]],
      ["\\bfoo\\b", ["a foo b", "food", "foo"]],
      ["^(?<year>\\d{4})-(?:\\d{2})$", ["2024-01", "24-01"]],
      ["[^@\\s]+@[^@\\s]+\\.[^@\\s]+", ["a@b.co", "a@b", "x a@b.c y"]],
      ["^[\\d-z]+$", ["1-z", "a"]],
      ["^.{2,3}$", ["ab", "abcd", "a\nb"]],
      ["a{", ["a{", "a"]],
      ["^\\x41\\u0042$", ["AB", "ab"]],
      ["[]", ["", "x"]],
      ["^[^]*$", ["anything\nat all"]],
      ["a|", ["", "b"]],
    ]
    for (const [pattern, values] of cases) {
      const compiled = compilePattern(pattern)
      expect(typeof compiled).not.toBe("string")
      if (typeof compiled === "string") continue
      for (const value of values)
        expect([pattern, value, compiled.test(value)]).toEqual([pattern, value, new RegExp(pattern).test(value)])
    }
  })

  // Valid JavaScript that was once refused with a wrong reason ("nothing to repeat", "backreferences are not
  // supported"): a quantified group that holds only an assertion, and Annex B's legacy escapes.
  const LEGACY: string[] = [
    "(^)?a",
    "(?:\\b)+a",
    "($){1,3}",
    "(?<g>\\B)+x",
    "(?<g4>\\b)+",
    "-+?(\\B)?",
    "(?:^){2,} .",
    "(^$)*x",
    ".[^\\00\\[]",
    "[^\\00^]b",
    "^\\1$",
    "^\\8$",
    "^\\9+$",
    "^\\12$",
    "^\\123$",
    "^\\400$",
    "^\\477$",
    "^\\0777$",
    "^\\05$",
    "^\\08$",
    "^(a)\\10$",
    "^(a)\\2$",
    "^[\\1]$",
    "^[\\8]$",
    "^[\\18]+$",
    "^[\\00]$",
    "^[\\05]$",
    "^[\\123]$",
    "^\\k$",
    "^\\k<a>$",
    "^\\c1$",
    "^\\c$",
    "^[\\c1]$",
    "^[\\c_]$",
    "^[\\c*]+$",
    "^\\cJ$",
  ]
  const POOL = [
    "\x00",
    "\x01",
    "\x05",
    "\x08",
    "\n",
    "\x11",
    "\x1f",
    "'",
    "?",
    "S",
    "1",
    "7",
    "8",
    "9",
    "0",
    "a",
    "b",
    "x",
  ]
  const MORE = [" ", "k", "<", ">", "c", "J", "\\", "*", "^", "[", "-", "_", "aa"]
  const samples = (() => {
    // Every string of up to two characters from POOL, a few longer ones, and a fixed pseudo-random batch.
    const out = new Set<string>(["", ...POOL, ...MORE])
    for (const a of POOL) for (const b of POOL) out.add(a + b)
    for (const text of [
      "a\x08",
      "aa0",
      "\x0a",
      " 0",
      "'7",
      "?7",
      "\x008",
      "k<a>",
      "\\c1",
      "\\c",
      "ba",
      "ab",
      "x ",
      "a .",
      "\x05b",
    ])
      out.add(text)
    const draw = seeded(7)
    const chars = [...POOL, ...MORE]
    for (let index = 0; index < 300; index++) {
      let text = ""
      for (let length = draw(5); length > 0; length--) text += chars[draw(chars.length)]
      out.add(text)
    }
    return [...out]
  })()

  test.each(LEGACY)("runs %s as RegExp does", (pattern) => {
    const compiled = compilePattern(pattern)
    expect(compiled).not.toBeTypeOf("string")
    if (typeof compiled === "string") return
    const regexp = new RegExp(pattern)
    const wrong = samples.filter((value) => compiled.test(value) !== regexp.test(value))
    expect(wrong.map((value) => JSON.stringify(value))).toEqual([])
  })

  test("a backreference is still refused, also to a later group, and \\k once the pattern has a named group", () => {
    for (const pattern of ["(a)\\1", "\\1(a)", "(a)(b)\\2", "(?<n>a)\\k<n>", "(a)[\\1]\\1"])
      expect([pattern, patternProblem(pattern)]).toEqual([pattern, "backreferences are not supported"])
    // A bare quantified assertion is not valid JavaScript at all.
    expect(patternProblem("\\b+")).toContain("not a valid regular expression")
  })

  test("refuses what an automaton cannot run, and what is too big", () => {
    expect(patternProblem("(a)\\1")).toBe("backreferences are not supported")
    expect(patternProblem("(?<n>a)\\k<n>")).toBe("backreferences are not supported")
    expect(patternProblem("(?=a)b")).toBe("lookarounds are not supported")
    expect(patternProblem("(?<!a)b")).toBe("lookarounds are not supported")
    expect(patternProblem("x".repeat(MAX_PATTERN_LENGTH + 1))).toContain("longer than")
    expect(patternProblem("(a{100}){100}")).toBe("the pattern is too complex")
    expect(patternProblem("a**")).toContain("not a valid regular expression")
    expect(patternProblem("^[a-z]+$")).toBeUndefined()
  })

  test("an unusable pattern is ignored (passes); a value that is too long or not a string fails", () => {
    expect(safePattern("anything", { pattern: "(a)\\1" })).toBe(true)
    expect(safePattern("a".repeat(MAX_PATTERN_INPUT + 1), { pattern: "^a+$" })).toBe(false)
    expect(safePattern("a".repeat(MAX_PATTERN_INPUT), { pattern: "^a+$" })).toBe(true)
    expect(safePattern(5, { pattern: "5" })).toBe(false)
    expect(safePattern("x", {})).toBe(false)
  })

  test("the email check caps the value it runs json-render's regex on (quadratic on crafted values)", () => {
    expect(safeEmail(" ada@example.com ")).toBe(true)
    expect(safeEmail("not an email")).toBe(false)
    const [valid, ms] = timed(() => safeEmail(`a@${".".repeat(50_000)}@`))
    expect(valid).toBe(false)
    expect(ms).toBeLessThan(50)
    expect(safeEmail(`${"a".repeat(MAX_EMAIL_LENGTH)}@example.com`)).toBe(false)
  })

  test("the ignored check always passes", () => {
    expect(VALIDATION_FUNCTIONS[IGNORED_CHECK]!("x")).toBe(true)
  })

  describe("the shared work budget", () => {
    const realNow = Date.now
    afterEach(() => {
      Date.now = realNow
    })
    // About 2000 live states, each a test against a class of ~75 ranges, on the longest value: the most one check costs.
    let cls = "["
    for (let code = 0x100; cls.length < 230; code += 2)
      cls += `${String.fromCharCode(code)}-${String.fromCharCode(code)}`
    const heavy = `(?:${cls}a]*){999}x`
    const long = "a".repeat(MAX_PATTERN_INPUT)

    test("caps the work of all checks in a window, however many there are; a check past it is skipped (passes)", () => {
      Date.now = () => 1000
      const [results, ms] = timed(() => Array.from({ length: 100 }, () => safePattern(long, { pattern: heavy })))
      expect(ms).toBeLessThan(500)
      expect(results.every(Boolean)).toBe(true)
      // While the window's budget is spent, even a cheap check is skipped.
      expect(safePattern("abc9", { pattern: "^[a-z]+$" })).toBe(true)
      // The next window has a fresh budget.
      Date.now = () => 1000 + PATTERN_BUDGET_WINDOW_MS
      expect(safePattern("abc9", { pattern: "^[a-z]+$" })).toBe(false)
      expect(safePattern("abc", { pattern: "^[a-z]+$" })).toBe(true)
    })

    test("a budget passed to test() is spent as the automaton works, and running out gives undefined", () => {
      const compiled = compilePattern("^(a+)+$")
      if (typeof compiled === "string") throw new Error(compiled)
      const budget = { left: PATTERN_BUDGET }
      expect(compiled.test(long, budget)).toBe(true)
      expect(budget.left).toBeLessThan(PATTERN_BUDGET)
      expect(budget.left).toBeGreaterThan(PATTERN_BUDGET - 50_000)
      expect(compiled.test(long, { left: 100 })).toBeUndefined()
      expect(compiled.test(long)).toBe(true)
    })
  })
})
