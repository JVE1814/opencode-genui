import { afterEach, describe, expect, test } from "bun:test"
import * as core from "@json-render/core"
import { createDirectiveRegistry, resolvePropValue } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import { textOf, numberOf, MAX_DIRECTIVE_TEXT } from "../../src/gui/directives.ts"
import { guardDirectives } from "../../src/gui/element.ts"
import { seeded } from "./random.ts"

// Regression tests for the follow-up of the sixth review (R6S1-1, R6S1-2, R6S1-3, FV-O1): what resolving expressions
// costs is bounded, in json-render's core (patches/@json-render%2Fcore) and in genui's directives
// (src/gui/directives.ts), however a value is shaped and however many expressions a spec has.

const { withEvaluation, withExpansionAccount } = core as unknown as {
  readonly withEvaluation: <T>(deferrable: boolean, evaluate: () => T) => T
  readonly withExpansionAccount: <T>(account: object, run: () => T) => T
}
const directives = createDirectiveRegistry(guardDirectives(standardDirectives))
const plain = Object.fromEntries(standardDirectives.map((directive) => [directive.name, directive]))
const ctx = (stateModel: Record<string, unknown>) => ({ stateModel, directives })
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** What `run` threw, or undefined. */
function thrown(
  run: () => unknown,
): { readonly expansionLimit?: boolean; readonly evaluationDeferred?: boolean } | undefined {
  try {
    run()
  } catch (error) {
    return error as never
  }
  return undefined
}

/** A list that holds one list many times over (`a_k = [a_(k-1), a_(k-1)]`): 2^levels × 24 characters written out. */
function shared(levels: number): unknown[] {
  let list: unknown[] = [-2.2250738585072014e-308, "x"]
  for (let level = 0; level < levels; level++) list = [list, list]
  return list
}

const warn = console.warn
afterEach(() => {
  console.warn = warn
})
const quiet = () => {
  const warnings: string[] = []
  console.warn = (message: string) => void warnings.push(String(message))
  return warnings
}

describe("what expressions build from a list that holds one list many times over [FV-O1, R6S1-2]", () => {
  test("a $template, $concat or $join stops at the bound instead of turning the whole list into text first", async () => {
    // String() of it built 100 million characters (4 s) before the bound was checked.
    quiet()
    await nextTask()
    const state = { a: shared(21) }
    for (const value of [
      { $template: "${/a}" },
      { $concat: ["x", { $state: "/a" }] },
      { $join: { $state: "/a" } },
      { $join: [{ $state: "/a" }], separator: "," },
    ]) {
      const started = performance.now()
      expect(thrown(() => resolvePropValue(value, ctx(state)))?.expansionLimit, JSON.stringify(value)).toBe(true)
      expect(performance.now() - started).toBeLessThan(300)
      await nextTask()
    }
  })

  test("$truncate, $math, $pluralize and $format read such a list only as far as their result needs", async () => {
    quiet()
    await nextTask()
    const state = { a: shared(21) }
    const started = performance.now()
    expect(resolvePropValue({ $truncate: { $state: "/a" }, length: 8 }, ctx(state))).toBe("-2.22507...")
    expect(resolvePropValue({ $math: "add", a: { $state: "/a" }, b: 1 }, ctx(state))).toBe(1)
    expect(resolvePropValue({ $pluralize: { $state: "/a" }, one: "item", other: "items" }, ctx(state))).toBe("0 items")
    expect(resolvePropValue({ $format: "number", value: { $state: "/a" } }, ctx(state))).toBe("NaN")
    expect(resolvePropValue({ $format: "date", value: { $state: "/a" } }, ctx(state))).toBeUndefined()
    // A length past what a directive turns into text, or one that cuts from the end, leaves it unresolved: each item it
    // turns into text counts as an expression evaluated [review8#R6S2-3], so such a list is left unresolved by the
    // evaluation's bound (it resolved to undefined before, by the directive's own).
    await nextTask()
    expect(
      thrown(() => resolvePropValue({ $truncate: { $state: "/a" }, length: MAX_DIRECTIVE_TEXT + 1 }, ctx(state)))
        ?.expansionLimit,
    ).toBe(true)
    await nextTask()
    expect(
      thrown(() => resolvePropValue({ $truncate: { $state: "/a" }, length: -3 }, ctx(state)))?.expansionLimit,
    ).toBe(true)
    // 16 s for eight of these in one prop before.
    expect(performance.now() - started).toBeLessThan(300)
  })
})

describe("genui's directives give the standard results [R6S1-1]", () => {
  // A random JSON-like value: what state and expressions hold.
  const valueOf = (draw: (n: number) => number, depth: number): unknown => {
    switch (draw(depth > 3 ? 6 : 8)) {
      case 0:
        return null
      case 1:
        return undefined
      case 2:
        return ["", "a", "1", " 2 ", "1e3", "x,y", "0x10", "true"][draw(8)]
      case 3:
        return [0, -0, 1, 2.5, -7, 1e21, Number.NaN][draw(7)]
      case 4:
        return draw(2) === 0
      case 5:
        return { k: draw(3) }
      default: {
        const list: unknown[] = []
        for (let length = draw(4); length > 0; length--) list.push(valueOf(draw, depth + 1))
        return list
      }
    }
  }

  test("textOf and numberOf read a value as String() and Number() do", () => {
    const draw = seeded(0x7e57)
    for (let round = 0; round < 5000; round++) {
      const value = valueOf(draw, 0)
      const text = value === null || value === undefined ? "" : String(value)
      expect(textOf(value, 10_000), JSON.stringify(value)).toEqual({ text, cut: false })
      expect(Object.is(numberOf(value), Number(value)), JSON.stringify(value)).toBe(true)
      const short = textOf(value, 2)
      expect(short.cut).toBe(text.length > 2)
      expect(text.startsWith(short.text.slice(0, 2))).toBe(true)
    }
  })

  test("each standard directive resolves to what @json-render/directives gives", () => {
    const draw = seeded(0xd17)
    const state = { n: 3, s: "12.5", list: [4], date: 86_400_000 }
    const cases: Record<string, unknown>[] = [
      { $format: "date", value: { $state: "/date" }, locale: "en-US", options: { timeZone: "UTC" } },
      { $format: "date", value: 0, style: "relative", now: 90_000_000 },
      { $format: "currency", value: { $state: "/s" }, currency: "EUR", locale: "de-DE" },
      { $format: "number", value: 1234567.891, notation: "compact", locale: "en-US" },
      { $format: "percent", value: { $state: "/list" }, locale: "en-US" },
      { $format: "currency", value: 1, currency: "NOT-A-CODE" },
      { $truncate: "Hello world", length: 5 },
      { $truncate: "Hello", length: 5, suffix: "…" },
      { $truncate: { $state: "/list" } },
      { $pluralize: { $state: "/n" }, one: "item", other: "items", zero: "none" },
      { $pluralize: 0, one: "item", other: "items", zero: "none" },
      { $pluralize: "1", one: "item", other: "items" },
    ]
    for (let round = 0; round < 300; round++) {
      const op = ["add", "subtract", "multiply", "divide", "mod", "min", "max", "round", "floor", "ceil", "abs"][
        draw(11)
      ]
      cases.push({ $math: op, a: valueOf(draw, 0), b: valueOf(draw, 0) })
    }
    quiet()
    for (const value of cases) {
      const name = Object.keys(value)[0]!
      let expected: unknown
      try {
        expected = plain[name]!.resolve(value as never, ctx(state) as never)
      } catch {
        expected = undefined
      }
      expect(resolvePropValue(value, ctx(state)), JSON.stringify(value)).toEqual(expected)
    }
  })

  test("$format makes one formatter per directive of the spec, not one per call", () => {
    // A new Intl formatter on every call: 50 µs each, 13 s for a block of 6 KB with 50 of them in 2,000 rows.
    const Real = Intl.DateTimeFormat
    let made = 0
    const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      made++
      return new Real(...args)
    } as unknown as typeof Intl.DateTimeFormat
    Intl.DateTimeFormat = Counting
    try {
      const value = { $format: "date", value: 0, locale: "en-US", options: { timeZone: "UTC" } }
      const results = new Set<unknown>()
      for (let index = 0; index < 1000; index++) results.add(resolvePropValue(value, ctx({})))
      expect(made).toBe(1)
      expect([...results]).toEqual([new Real("en-US", { timeZone: "UTC" }).format(new Date(0))])
    } finally {
      Intl.DateTimeFormat = Real
    }
  })
})

describe("how much one evaluation visits, and for how long a task evaluates [R6S1-1]", () => {
  const terms = (count: number) => Array.from({ length: count }, () => ({ $state: "/q", eq: "never" }))

  test("one evaluation visits at most 100,000 expressions; past that it is left unresolved", async () => {
    quiet()
    await nextTask()
    const state = { q: "" }
    expect(resolvePropValue({ $cond: { $or: terms(40_000) }, $then: "yes", $else: "no" }, ctx(state))).toBe("no")
    await nextTask()
    expect(
      thrown(() => resolvePropValue({ $cond: { $or: terms(150_000) }, $then: "yes", $else: "no" }, ctx(state)))
        ?.expansionLimit,
    ).toBe(true)
    // A template counts its references.
    await nextTask()
    expect(thrown(() => resolvePropValue({ $template: "${/q}".repeat(150_000) }, ctx(state)))?.expansionLimit).toBe(
      true,
    )
  })

  test("an evaluation for rendering waits for the next task once this one evaluated for its slice", async () => {
    await nextTask()
    const real = performance.now
    let now = real.call(performance)
    performance.now = () => now
    try {
      const evaluate = () => resolvePropValue({ $template: "${/q}!" }, ctx({ q: "a" }))
      // The task's first evaluation runs past the slice, so each task makes progress (up to its own bound, below).
      expect(
        withEvaluation(true, () => {
          now += 150
          return evaluate()
        }),
      ).toBe("a!")
      // Past the slice, the next one for rendering waits; what is not for rendering (an action's param) runs.
      expect(thrown(() => withEvaluation(true, evaluate))?.evaluationDeferred).toBe(true)
      expect(withEvaluation(false, evaluate)).toBe("a!")
      // So does one whose nodes run past the slice.
      await nextTask()
      expect(withEvaluation(true, evaluate)).toBe("a!")
      expect(
        thrown(() =>
          withEvaluation(true, () => {
            now += 500
            return resolvePropValue({ $cond: { $or: terms(1000) }, $then: 1, $else: 2 }, ctx({ q: "" }))
          }),
        )?.evaluationDeferred,
      ).toBe(true)
      // The next task evaluates afresh.
      await nextTask()
      expect(withEvaluation(true, evaluate)).toBe("a!")

      // What one node costs is bounded too [review8#R6S2-3]: an evaluation, the task's first included, stops after
      // 200 ms (deferring it would only repeat it), and the evaluations of a task that are not for rendering stop once
      // the task has evaluated for 400 ms. The first evaluation of a task ran to 100,000 nodes before, whatever each
      // cost, and actions' params were never timed: 42 s per key press.
      const slow = (ms: number) => () =>
        resolvePropValue(
          {
            $cond: { $or: terms(1000).map((term, index) => (index === 500 ? ((now += ms), term) : term)) },
            $then: 1,
            $else: 2,
          },
          ctx({ q: "" }),
        )
      await nextTask()
      expect(thrown(() => withEvaluation(true, slow(250)))?.expansionLimit).toBe(true)
      await nextTask()
      expect(thrown(() => withEvaluation(false, slow(250)))?.expansionLimit).toBe(true)
      await nextTask()
      expect(withEvaluation(false, slow(190))).toBe(2)
      expect(withEvaluation(false, slow(190))).toBe(2)
      expect(thrown(() => withEvaluation(false, slow(30)))?.expansionLimit).toBe(true)
      expect(thrown(() => withEvaluation(false, evaluate))?.expansionLimit).toBe(true)
      // Rendering's first still runs, within its own 200 ms, and the ones after it wait for the next task.
      expect(withEvaluation(true, evaluate)).toBe("a!")
      expect(thrown(() => withEvaluation(true, evaluate))?.evaluationDeferred).toBe(true)
      await nextTask()
      expect(withEvaluation(false, evaluate)).toBe("a!")
    } finally {
      performance.now = real
    }
  })

  test("what the actions of one change build is bounded for the change, also in its later tasks [R6S1-3]", async () => {
    quiet()
    await nextTask()
    const state = { a: "x".repeat(900_000) }
    const change = {}
    const build = () =>
      thrown(() => withExpansionAccount(change, () => resolvePropValue({ $template: "${/a}" }, ctx(state))))
    const results = [build(), build(), build(), build(), build()]
    expect(results.map((error) => error?.expansionLimit === true)).toEqual([false, false, false, false, true])
    // A later task, where the change's lists go on: still spent. Another change has an allowance of its own.
    await nextTask()
    expect(build()?.expansionLimit).toBe(true)
    expect(withExpansionAccount({}, () => resolvePropValue({ $template: "${/a}" }, ctx(state)))).toBe(state.a)
  })
})
