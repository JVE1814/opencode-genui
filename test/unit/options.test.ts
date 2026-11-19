import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions } from "../../src/shared/options.ts"

describe("parseOptions", () => {
  // Each case is wrapped in an array: test.each spreads array cases into arguments.
  test.each([
    [undefined],
    [null],
    [0],
    [42],
    ["always"],
    [true],
    [[]],
    [["always"]],
    [() => ({ instructions: "always" })],
  ])("falls back to the defaults for %p", (input: unknown) => {
    expect(parseOptions(input)).toEqual(DEFAULT_OPTIONS)
  })

  test("defaults are session instructions and no rules", () => {
    expect(DEFAULT_OPTIONS).toEqual({ instructions: "session", rules: [] })
    expect(parseOptions({})).toEqual(DEFAULT_OPTIONS)
  })

  test.each(["session", "always", "off"] as const)("accepts instructions %p", (instructions) => {
    expect(parseOptions({ instructions }).instructions).toBe(instructions)
  })

  test.each([["ALWAYS"], [" always"], ["never"], [""], [1], [true], [null], [["always"]], [{ mode: "always" }]])(
    "ignores instructions %p",
    (instructions: unknown) => {
      expect(parseOptions({ instructions }).instructions).toBe("session")
    },
  )

  test("keeps string rules in order and drops everything else", () => {
    const rules = ["Prefer canvases.", 1, null, "", "   ", { rule: "x" }, ["nested"], "Keep forms short.", undefined]
    expect(parseOptions({ rules }).rules).toEqual(["Prefer canvases.", "Keep forms short."])
  })

  test.each([["Prefer canvases."], [{ 0: "x" }], [3], [null], [true]])(
    "ignores rules that are not an array: %p",
    (rules: unknown) => {
      expect(parseOptions({ rules }).rules).toEqual([])
    },
  )

  test("keeps at most 50 rules", () => {
    const rules = Array.from({ length: 80 }, (_, index) => `Rule ${index}`)
    const parsed = parseOptions({ rules })
    expect(parsed.rules).toHaveLength(50)
    expect(parsed.rules[0]).toBe("Rule 0")
    expect(parsed.rules[49]).toBe("Rule 49")
  })

  test("ignores unknown keys and keeps valid ones next to invalid ones", () => {
    expect(parseOptions({ instructions: "off", rules: "nope", extra: true })).toEqual({
      instructions: "off",
      rules: [],
    })
    expect(parseOptions({ instructions: "bogus", rules: ["Be brief."] })).toEqual({
      instructions: "session",
      rules: ["Be brief."],
    })
  })

  test("does not share or mutate the input", () => {
    const rules = ["A rule."]
    const input = Object.freeze({ instructions: "always", rules: Object.freeze(rules) })
    const parsed = parseOptions(input)
    expect(parsed.rules).toEqual(rules)
    expect(parsed.rules).not.toBe(rules)
    expect(parseOptions(undefined).rules).not.toBe(DEFAULT_OPTIONS.rules)
  })
})
