import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "@opencode/ui/context/marked-parser"
import { Lexer, type Token } from "marked"
import {
  blockStructure,
  CHARS_PER_BLOCK,
  codeBlocks,
  JOINER,
  markdownShape,
  MAX_BLOCK_WORK,
  MAX_MARKDOWN_BLOCKS,
  MAX_NESTING,
  MAX_PARAGRAPH,
  markdownBudget,
  neutralizeMarkdown,
  prepareMarkdown,
  preparedCache,
  SHAPE_CACHE_CHARS,
  shownLength,
  splitMarkdown,
} from "../../src/gui/components/markdown.ts"
import { CELLS_PER_UNIT, domUnits, markdownUnits, MAX_TABLE_CELLS } from "../../src/gui/costs.ts"
import { markdownCut, tooLarge } from "../../src/gui/issues.ts"
import { TEXT_PER_UNIT } from "../../src/shared/constants.ts"
import { seeded } from "./random.ts"

// Regression tests for the eighth review's Markdown findings ([review8#R7S2-2], [review8#R7S1-5], [review8#R7F2-3],
// [review8#R7F2-2], [review8#R7F1-1], [review8#R7S2-4]): one model of marked's block structure counts code blocks,
// cuts long runs and costly or deep structure, and charges blocks. See test/e2e/review8-markdown.spec.ts for the same in
// the playground.

const parser = createMarkdownParser()

// ---------------------------------------------------------------------------------------------------------------------
// The app's marked, as genui hands it a text's blocks
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What marked makes of a text's blocks, as genui hands it the text: the definitions genui writes again stay (the
 * generated ones already are what marked reads), others are broken (a lookalike colon), and no tag or `<…>` line is
 * left (genui breaks tags, and ends a `<…>` line with a joiner). Every length is kept, since marked's blockquote can
 * build tokens from its raw by character offsets.
 */
function marked(text: string) {
  const definitions = new Set(blockStructure(text).definitions)
  const rows = text.split(/\r\n|\r|\n/)
  const source = rows
    .map((row, index) => {
      if (definitions.has(index)) return row
      if (/^[\s>\-*+.)0-9]*\[/.test(row)) row = row.replace(/\]:/g, "]：")
      return row.replaceAll("<", "‹")
    })
    .join("\n")
  return lex(source)
}

/** What the app's marked makes of a text's blocks, as it is (for the text genui hands it: see `handed`). */
function lex(source: string) {
  const lexer = new Lexer(parser.defaults as never)
  const tokens = lexer.blockTokens(source, lexer.tokens) as Token[]
  const blocks: Record<string, number> = {}
  let code = 0
  let math = 0
  const add = (type: string, count = 1) => (blocks[type] = (blocks[type] ?? 0) + count)
  const walk = (list: Token[]) => {
    for (const token of list) {
      if (token.type === "code") code++
      else if (token.type === "blockKatex") {
        math++
        add("math")
      } else if (token.type === "paragraph" || token.type === "heading" || token.type === "hr") add(token.type)
      else if (token.type === "blockquote") {
        add("blockquote")
        walk(token.tokens!)
      } else if (token.type === "table") add("cell", token.header.length * (1 + token.rows.length))
      else if (token.type === "list")
        for (const item of token.items) {
          add("item")
          walk(item.tokens)
        }
    }
  }
  walk(tokens)
  const runs = lexer.inlineQueue.map((entry: { src: string }) => entry.src.length)
  return { code, math, blocks, runs }
}

const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b)

/** The differences between the model and marked for a text (none: they agree). */
function differences(text: string): string[] {
  const model = blockStructure(text)
  const reference = marked(text)
  const out: string[] = []
  if (model.code !== reference.code) out.push(`code blocks: model ${model.code}, marked ${reference.code}`)
  if (model.math !== reference.math) out.push(`display math: model ${model.math}, marked ${reference.math}`)
  for (const type of new Set([...Object.keys(model.blocks), ...Object.keys(reference.blocks)]))
    if ((model.blocks[type] ?? 0) !== (reference.blocks[type] ?? 0))
      out.push(`${type}: model ${model.blocks[type] ?? 0}, marked ${reference.blocks[type] ?? 0}`)
  if (sorted(model.runs).join() !== sorted(reference.runs).join())
    out.push(`runs: model ${sorted(model.runs).join()}, marked ${sorted(reference.runs).join()}`)
  return out
}

/** A text's first `shown` characters as MarkdownText cuts it, in the parts genui splits it into (as written). */
const shownSource = (text: string, shown: number) =>
  (shown < text.length ? `${text.slice(0, shown)}\n\n…` : text).replace(/\r\n?/g, "\n")
const writtenParts = (text: string, shown: number) =>
  splitMarkdown(shownSource(text, shown)).flatMap((part) => (part.kind === "markdown" ? [part.text] : []))

/** The Markdown parts genui hands the renderer for a text, as MarkdownText does (cut where markdownShape says). */
function handed(text: string) {
  const shape = markdownShape(text)
  const parts = prepareMarkdown(text, "Image", shape.cut)
  return {
    shape,
    parts: parts.flatMap((part) => (part.kind === "markdown" ? [part.text] : [])),
    own: parts.filter((part) => part.kind === "code").length,
  }
}

/** The same parts neutralized but not checked (as genui handed them to marked before [review9#R8S-1]). */
function unchecked(text: string): string[] {
  const source = shownSource(text, text.length)
  const budget = markdownBudget(source.length)
  return splitMarkdown(source).flatMap((part) =>
    part.kind === "markdown" ? [neutralizeMarkdown(part.text, "Image", budget)] : [],
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Generated documents
// ---------------------------------------------------------------------------------------------------------------------

const CONTENTS = [
  "word",
  "two words",
  "a longer line of prose text",
  "# heading",
  "## heading ##",
  "#nospace",
  "###### six",
  "####### seven",
  "---",
  "***",
  "___",
  "* * *",
  "- - -",
  "*\t*\t*",
  "===",
  "=",
  "--",
  "-",
  "```",
  "```js",
  "````",
  "``` a`b",
  "~~~",
  "~~~~ info",
  "```math",
  "    code",
  "\tcode",
  "|a|b|",
  "| a | b |",
  "|-|-|",
  "|---|:-:|",
  "a | b",
  "--- | ---",
  ":-:",
  "-|-|-",
  "<div>",
  "<span>x</span>",
  "<http://example.com>",
  "< x >",
  "[a]: http://example.com",
  '[b]: http://example.com "title"',
  "[c]:  http://x",
  "[d]:\nhttp://x",
  "[not a def",
  "$$",
  "$",
  "x^2",
  "a\\",
  "",
  "",
  "",
  "   ",
  "\t",
  "[ ] task",
  "[x] done task",
  "> quoted",
  ">",
  "1. one",
  "2) two",
  "- item",
  "* star",
  "+ plus",
  "-\titem",
  "10. ten",
  "1.",
  "text sep",
  " ",
]

const PREFIXES = [
  "",
  "",
  "",
  "",
  " ",
  "  ",
  "   ",
  "    ",
  "     ",
  "      ",
  "        ",
  "         ",
  "\t",
  " \t",
  "> ",
  ">",
  "> > ",
  ">> ",
  ">\t",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "2) ",
  "-   ",
  "-     ",
  "  - ",
  "    - ",
  "> - ",
  "- > ",
  "1. > ",
]

/** Lines of every construct behind random, sometimes stacked, container prefixes. */
function lineDocument(draw: (n: number) => number): string {
  const out: string[] = []
  for (let index = 0, count = 1 + draw(30); index < count; index++) {
    const previous = out.at(-1)
    if (previous !== undefined && draw(10) === 0)
      out.push(previous.replace(/[^\s>\-*+.)0-9].*$/, "") + CONTENTS[draw(CONTENTS.length)]!)
    else {
      let prefix = ""
      for (let level = 0, stack = draw(4) === 0 ? 2 : 1; level < stack; level++)
        prefix += PREFIXES[draw(PREFIXES.length)]
      out.push(prefix + CONTENTS[draw(CONTENTS.length)]!)
    }
  }
  return out.join("\n") + (draw(3) === 0 ? "\n" : "")
}

const WORDS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "x",
  "a*b*",
  "`code`",
  "[link](http://x)",
  "<b>",
  "| pipe",
  "\\",
  "$x$",
]
const words = (draw: (n: number) => number, count: number) =>
  Array.from({ length: count }, () => WORDS[draw(WORDS.length)]).join(" ")

/** Nested lists (items at their content column, some lines lazy) and quotes holding every kind of block. */
function structured(draw: (n: number) => number, depth = 0, budget = { lines: 60 }): string[] {
  const out: string[] = []
  for (let block = 0, blocks = 1 + draw(depth === 0 ? 8 : 4); block < blocks && budget.lines > 0; block++) {
    const kind = draw(depth >= 4 ? 9 : 13)
    const space = draw(3) === 0 ? [""] : draw(4) === 0 ? ["   "] : []
    if (kind <= 1) {
      out.push(...Array.from({ length: 1 + draw(4) }, () => words(draw, 1 + draw(5))))
      if (draw(4) === 0) out.push(draw(2) ? "===" : "---")
    } else if (kind === 2) out.push(`${"#".repeat(1 + draw(7))} ${words(draw, 2)}${draw(3) === 0 ? " ##" : ""}`)
    else if (kind === 3) out.push(["***", "---", "___", "* * *", "- - -", "*\t*\t*"][draw(6)]!)
    else if (kind === 4) {
      const fence = ["```", "~~~", "````", "```js", "```math"][draw(5)]!
      out.push(fence, ...Array.from({ length: draw(4) }, () => (draw(3) ? words(draw, 2) : "")))
      if (draw(4)) out.push(fence.replace(/[a-z]+$/, ""))
    } else if (kind === 5) out.push(...Array.from({ length: 1 + draw(3) }, () => "    " + words(draw, 2)))
    else if (kind === 6) {
      const columns = 1 + draw(4)
      out.push(`| ${Array.from({ length: columns }, () => words(draw, 1)).join(" | ")} |`)
      out.push(
        `|${Array.from({ length: columns + (draw(6) === 0 ? 1 : 0) }, () => (draw(4) ? "---" : ":-:")).join("|")}|`,
      )
      for (let row = draw(5); row > 0; row--)
        out.push(`| ${Array.from({ length: 1 + draw(5) }, () => words(draw, 1)).join(" | ")}${draw(2) ? " |" : ""}`)
    } else if (kind === 7) out.push(draw(2) ? "$$" : "$", words(draw, 2), draw(3) ? (draw(2) ? "$$" : "$") : "x")
    else if (kind === 8) out.push(`[${words(draw, 1)}]: http://example.com/${draw(9)}${draw(2) ? ' "t"' : ""}`)
    else if (kind <= 10) {
      const marker = ["-", "*", "+", "1.", "2)", "10."][draw(6)]!
      for (let item = 0, items = 1 + draw(4); item < items && budget.lines > 0; item++) {
        const pad = " ".repeat(1 + draw(draw(4) === 0 ? 5 : 2))
        const lead = " ".repeat(draw(4) === 0 ? draw(4) : 0)
        const inner = structured(draw, depth + 1, budget)
        const column = lead.length + marker.length + pad.length
        inner.forEach((line, index) => {
          if (index === 0) out.push(lead + marker + pad + line)
          else if (line === "") out.push(draw(3) === 0 ? "  " : "")
          else if (draw(8) === 0) out.push(line)
          else out.push(" ".repeat(column + (draw(6) === 0 ? draw(3) - 1 : 0)) + line)
        })
        if (draw(3) === 0) out.push("")
      }
    } else {
      for (const line of structured(draw, depth + 1, budget))
        out.push(draw(7) === 0 && line !== "" ? line : (draw(4) === 0 ? ">" : "> ") + line)
    }
    out.push(...space)
    budget.lines -= out.length
  }
  return out
}

describe("one model of marked's block structure counts and cuts [review8#R7S2-2] [review8#R7F2-2]", () => {
  test("it agrees with the app's marked on thousands of generated documents: code blocks, blocks, every inline run", () => {
    // Each finding came from a different approximation of marked's block rules: indented code after a heading, a rule,
    // a setext heading or a fence, or in a quote, went uncounted (11,000 code blocks in 88 KB); list continuation
    // paragraphs counted as code; a nested list after an item's paragraph was one run.
    const failures: string[] = []
    for (let seed = 1; seed <= 4000 && failures.length < 5; seed++) {
      const draw = seeded(seed)
      const text = seed % 2 ? lineDocument(draw) : structured(draw).join("\n") + (draw(2) ? "\n" : "")
      const found = differences(text)
      if (found.length) failures.push(`${JSON.stringify(text)}\n  ${found.join("\n  ")}`)
    }
    expect(failures).toEqual([])
  }, 60_000)

  test("no text with no marked run past MAX_PARAGRAPH is cut for one, and no run past it shows", () => {
    // The same documents with some lines grown to 5,000 to 26,000 characters, lexed in the parts genui splits a text
    // into (each part is a renderer of its own). What shows is lexed too as genui hands it to marked, neutralized:
    // its runs are the ones the model cut by, longer only by what neutralizing wrote into them [review9#R8S-1].
    let cut = 0
    let whole = 0
    let lines = 0
    for (let seed = 1; seed <= 400; seed++) {
      const draw = seeded(seed * 7919)
      const base = (seed % 2 ? lineDocument(draw) : structured(draw).join("\n")).split("\n")
      for (let grown = 1 + draw(2); grown > 0; grown--) {
        const index = draw(base.length)
        base[index] = base[index] + " " + "word ".repeat(1000 + draw(4200))
      }
      const text = base.join("\n")
      const longest = (shown: string) =>
        Math.max(0, ...splitMarkdown(shown).flatMap((part) => (part.kind === "markdown" ? marked(part.text).runs : [])))
      const { reason, shown } = shownLength(text)
      const given = handed(text).parts
      const added = given.join("").length - writtenParts(text, shown).join("").length
      expect(Math.max(0, ...given.flatMap((part) => lex(part).runs))).toBeLessThanOrEqual(MAX_PARAGRAPH + added)
      if (longest(text) <= MAX_PARAGRAPH) {
        // Not cut for a paragraph. A few are cut where the model reads the neutralized lines otherwise than as written
        // ("lines"; this said "not cut" before genui checked what it hands marked [review9#R8S-1]): display math in a
        // list item's lazy lines, past the math budget written as a code block, ends the item early, and the 20,000
        // characters of its lines went to marked's inline lexer as a paragraph no budget had seen.
        expect({ text: text.slice(0, 80), reason: reason === "lines" ? undefined : reason }).toEqual({
          text: text.slice(0, 80),
          reason: undefined,
        })
        if (reason) lines++
        else whole++
      } else {
        expect(reason).toBeDefined()
        expect(longest(text.slice(0, shown))).toBeLessThanOrEqual(MAX_PARAGRAPH)
        cut++
      }
    }
    // Both kinds came up, and the check's cuts are rare.
    expect(cut).toBeGreaterThan(50)
    expect(whole).toBeGreaterThan(50)
    expect(lines).toBeLessThanOrEqual(2)
  }, 60_000)

  test("it is linear: adversarial texts of 500,000 characters take it about as long per character as 100,000", () => {
    const repeat = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
    const shapes: Record<string, (length: number) => string> = {
      "paragraphs between rules": (length) => repeat("a\n***\n", length),
      "a list item's short lines": (length) => "- a\n" + repeat("y\n", length),
      "quoted list items with lazy lines": (length) => repeat("> - a\nlazy\n", length),
      "quoted code with lazy lines": (length) => repeat(">     a\nlazy\n", length),
      "lists nested eight deep, lazy lines": (length) => "- ".repeat(8) + "a\n" + repeat("y\n", length),
      "quotes nested eight deep": (length) => repeat("> ".repeat(8) + "x\n", length),
      "task items": (length) => repeat("- [ ] a\n", length),
      "tables of the wrong width": (length) => repeat("a|b\n-|-|-\n", length),
    }
    for (const [name, shape] of Object.entries(shapes)) {
      const time = (length: number) => {
        const text = shape(length)
        const started = performance.now()
        blockStructure(text)
        return performance.now() - started
      }
      time(20_000)
      const small = Math.min(time(100_000), time(100_000))
      const large = Math.min(time(500_000), time(500_000))
      expect({ name, ratio: large / Math.max(small, 5) < 12 }).toEqual({ name, ratio: true })
      expect({ name, fast: large < 1500 }).toEqual({ name, fast: true })
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// The findings' shapes
// ---------------------------------------------------------------------------------------------------------------------

describe("every code block marked renders is counted, and nothing else [review8#R7S2-2] [review8#R7S1-5] [review8#R7F2-3]", () => {
  const thousand = (unit: string) => Array.from({ length: 1000 }, () => unit).join("\n")

  test("indented code after a heading, a rule, a setext heading or a closed fence, and in a quote, counts", () => {
    // Each was 0 (1,032 for the fences): an 88 KB block of `#\n\tc` rendered 11,000 uncharged code blocks.
    const forms: Record<string, [string, number]> = {
      "after a heading": [thousand("#\n\tc"), 1000],
      "after an ATX heading with text": [thousand("# h\n    c"), 1000],
      "after a rule": [thousand("***\n    c"), 1000],
      "after a setext heading": [thousand("t\n===\n    c"), 1000],
      "after a closed fence": [thousand("```\nx\n```\n    c"), 2000],
      "in a quote": [thousand(">     c\n"), 1000],
      "in a quote, after a heading": [thousand("> # h\n>     c\n"), 1000],
    }
    for (const [name, [text, count]] of Object.entries(forms)) {
      expect({ name, code: blockStructure(text).code }).toEqual({ name, code: count })
      expect({ name, marked: marked(text).code }).toEqual({ name, marked: count })
    }
    // The 88 KB repro: more code blocks than a surface renders, so the element is refused (and the surface says so).
    const repro = Array.from({ length: 11_000 }, () => "#\n\tc").join("\n")
    expect(codeBlocks(repro).total).toBe(11_000)
    expect(domUnits("Markdown", { content: repro })).toBeGreaterThan(2000)
  })

  test("a list item's continuation paragraphs, indented 4, are paragraphs: the 101 KB glossary costs no code", () => {
    // They were charged as code: 1,700 phantom units refused the whole glossary.
    const glossary = Array.from(
      { length: 1700 },
      (_, index) => `- **term-${index}**\n\n    Meaning of term ${index} in this codebase.\n\n`,
    ).join("")
    expect(glossary.length).toBeGreaterThan(100_000)
    expect(codeBlocks(glossary)).toEqual({ total: 0, own: 0 })
    expect(markdownShape(glossary).cut).toEqual({ shown: glossary.length })
    // Its 5,100 blocks (an item and two paragraphs each, 20 characters apiece) cost about a hundred units on top of its
    // 406: it renders, far within the budget.
    expect(domUnits("Markdown", { content: glossary })).toBeLessThan(150)
    const runbook = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `${index + 1}. Step ${index}\n\n    Run the check for item ${index} and note the result.\n\n    Then move on to the next item.\n\n`,
      ).join("")
    expect(codeBlocks(runbook(99))).toEqual({ total: 0, own: 0 })
    expect(marked(runbook(99)).code).toBe(0)
    // From item 100 on, "100. " takes five columns, and lines indented four are code after the blank line, to marked
    // too: counted as marked renders them.
    expect(codeBlocks(runbook(400)).total).toBe(marked(runbook(400)).code)
    expect(marked(runbook(400)).code).toBe(301)
    // Code in an item needs its content column and four more.
    expect(codeBlocks("- item\n\n      code\n")).toEqual({ total: 1, own: 0 })
    expect(codeBlocks("- item\n\n    paragraph\n")).toEqual({ total: 0, own: 0 })
  })

  test("a cheat sheet of fenced commands in items counts each code block, as the skill says", () => {
    const sheet = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `- Command ${index}\n\n  \`\`\`sh\n  tool --flag ${index}\n  \`\`\`\n\n`,
      ).join("")
    // 32 show on their own (4 units each), the rest render in the Markdown (1 each).
    expect(codeBlocks(sheet(1200))).toEqual({ total: 1200, own: 32 })
    expect(tooLarge("canvas").message).toContain("each code block of a Markdown text as an element")
  })

  test("display math counts as a code block too (past the math budget genui shows it as one)", () => {
    const blocks = Array.from({ length: 300 }, (_, index) => `$$\nx_${index} + y\n$$`).join("\n\n")
    expect(codeBlocks(blocks).total).toBe(300)
    const parts = prepareMarkdown(Array.from({ length: 900 }, () => `$$\n${"x+".repeat(30)}\n$$`).join("\n\n"), "Image")
    const text = parts.map((part) => (part.kind === "markdown" ? part.text : "")).join("\n")
    // Within the budget, math; past it, fences longer than any backtick run inside, so no line reads as Markdown.
    expect(text).toContain("$$\nx+")
    expect(text).toContain("```text\nx+")
    const html = parser.parse(text, { async: false }) as string
    expect(html).toContain('class="katex"')
    expect(html).toContain("<pre")
  })
})

describe("the paragraph cut counts runs as marked lexes them [review8#R7F2-2] [review8#R7F1-1]", () => {
  const item = (index: number) =>
    `Fixed issue #${1000 + index}: the scheduler no longer drops jobs whose retry window overlaps a deploy`
  const lines = (prefix: string) => Array.from({ length: 300 }, (_, index) => `${prefix}${item(index)}`).join("\n")

  test("a nested list after an item's continuation paragraph shows whole (and numbered, and quoted)", () => {
    // Each was cut at about 20,050 characters, though marked's longest run there is 90.
    const shapes: Record<string, string> = {
      "after a continuation paragraph": `- **Backend**\n\n  Changes in this release:\n${lines("    - ")}`,
      numbered: `1. **Backend**\n\n   Changes in this release:\n${lines("    - ")}`,
      quoted: `> - **Backend**\n>\n>   Changes in this release:\n${lines(">     - ")}`,
      "sections under setext headings": Array.from(
        { length: 30 },
        (_, index) => `Section ${index}\n=====\n${Array.from({ length: 10 }, () => item(index)).join("\n")}`,
      ).join("\n"),
    }
    for (const [name, text] of Object.entries(shapes)) {
      expect(text.length).toBeGreaterThan(MAX_PARAGRAPH)
      expect(Math.max(...marked(text).runs)).toBeLessThan(2000)
      expect({ name, cut: shownLength(text) }).toEqual({ name, cut: { shown: text.length } })
    }
  })

  test("lines between rules are a run of their own each, and the rules' cost is bounded instead", () => {
    // Sections of ten lines between `***` lines: marked's longest run is 889 characters, and they show whole.
    const sections = Array.from({ length: 30 }, (_, index) =>
      Array.from({ length: 10 }, () => item(index)).join("\n"),
    ).join("\n***\n")
    expect(shownLength(sections)).toEqual({ shown: sections.length })
    // One-line paragraphs between rules, though, make marked's setext rule scan to the end from each: 100 KB took
    // 3.4 s. The text is cut where that work passes MAX_BLOCK_WORK.
    const rules = "a\n***\n".repeat(17_000)
    const cut = shownLength(rules)
    expect(cut.reason).toBe("work")
    expect(cut.shown).toBeLessThan(40_000)
    expect(cut.shown).toBeGreaterThan(10_000)
  })

  test("one paragraph past MAX_PARAGRAPH is cut at it, in a list item and a quote too", () => {
    const words = Array.from({ length: 4000 }, (_, index) => `word${index}`).join(" ")
    for (const prefix of ["", "- ", "> ", "1. > - "]) {
      const cut = shownLength(prefix + words)
      expect(cut.reason).toBe("paragraph")
      expect(cut.shown).toBeLessThanOrEqual(prefix.length + MAX_PARAGRAPH)
      expect(cut.shown).toBeGreaterThan(MAX_PARAGRAPH - 10)
    }
  })
})

describe("a text's blocks are charged as Table cells, and cut past MAX_MARKDOWN_BLOCKS [review8#R7S2-4]", () => {
  test("the bound matches the Table's: a block costs a tenth of an element, as 25 characters do", () => {
    expect(MAX_MARKDOWN_BLOCKS).toBe(MAX_TABLE_CELLS)
    expect(CHARS_PER_BLOCK).toBe(TEXT_PER_UNIT / CELLS_PER_UNIT)
  })

  test("a 97 KB table of 2-character cells, or 24,000 one-letter items, is cut and charged", () => {
    // It showed whole: 47,000 cells in one task (743 ms), charged by its length only.
    const header = `|${Array.from({ length: 1000 }, (_, index) => `c${index % 10}`).join("|")}|`
    const delimiter = `|${"-|".repeat(1000)}`
    const row = `|${"ab|".repeat(1000)}`
    const table = [header, delimiter, ...Array.from({ length: 46 }, () => row)].join("\n")
    expect(marked(table).blocks.cell).toBe(47_000)
    const cut = shownLength(table)
    expect(cut.reason).toBe("blocks")
    expect(markdownShape(table).blocks).toBeLessThanOrEqual(MAX_MARKDOWN_BLOCKS)
    expect(markdownUnits(table)).toBeGreaterThan(900)
    const list = "- a\n".repeat(24_000)
    expect(shownLength(list).reason).toBe("blocks")
    expect(markdownUnits(list)).toBe(MAX_MARKDOWN_BLOCKS / CELLS_PER_UNIT)
    expect(markdownCut(10, 20, "blocks").message).toContain("too many and too short")
  })

  test("a wide header over short rows is counted by its padded cells, without building them", () => {
    // marked pads each row to the header's width: 1,000 columns over 30,000 one-cell rows are 30 million cells, and
    // the model built every one (673 ms at 3,000 rows, seconds at 30,000).
    const table = (rows: number) => `|${"c|".repeat(1000)}\n|${"-|".repeat(1000)}\n${"|a\n".repeat(rows)}`
    expect(differences(table(5))).toEqual([])
    expect(marked(table(5)).blocks.cell).toBe(6000)
    const text = table(30_000)
    const started = performance.now()
    const shape = markdownShape(text)
    const elapsed = performance.now() - started
    expect(shape.cut.reason).toBe("blocks")
    expect(shape.cut.shown).toBeLessThan(5000)
    expect(elapsed).toBeLessThan(500)
  })

  test("ordinary documents' blocks are paid for by their length: no charge, no cut", () => {
    const doc = (length: number, table: string) => {
      let text = ""
      for (let index = 1; text.length < length; index++)
        text += `## Section ${index}\n\nThis section explains **step ${index}** of the rollout, with \`config_${index}.yaml\` and _notes_.\n\n- item one for ${index}\n- item two for ${index}\n\n${table}`
      return text
    }
    for (const length of [20_000, 100_000, 400_000]) {
      const text = doc(length, "")
      expect(markdownShape(text)).toEqual({ cut: { shown: text.length }, code: 0, own: 0, blocks: 0 })
      expect(markdownUnits(text)).toBe(0)
      // With a table of one-character cells in each section, its blocks cost a little: it still shows whole, and its
      // length's units (1,600 at 400 KB) and these stay within the budget.
      const tables = doc(length, "| a | b |\n|---|---|\n| 1 | x |\n\n")
      expect(markdownShape(tables).cut).toEqual({ shown: tables.length })
      expect(markdownUnits(tables) + tables.length / TEXT_PER_UNIT).toBeLessThan(2000)
    }
    expect(markdownUnits("plain")).toBe(0)
  })
})

describe("text built to make marked's block lexer slow is cut [review8#R7F2-2]", () => {
  test("lists and quotes nested past MAX_NESTING are cut where they go deeper", () => {
    const fine = `${"> ".repeat(MAX_NESTING)}x\n\nafter`
    expect(shownLength(fine)).toEqual({ shown: fine.length })
    const deep = `before\n\n${"> ".repeat(MAX_NESTING + 1)}x\n\nafter`
    expect(shownLength(deep)).toEqual({ shown: "before\n\n".length, reason: "nesting" })
    const list = `before\n\n${Array.from({ length: MAX_NESTING + 2 }, (_, depth) => `${"  ".repeat(depth)}- item`).join("\n")}`
    expect(shownLength(list).reason).toBe("nesting")
    expect(markdownCut(10, 20, "nesting").message).toContain(`nest more than ${MAX_NESTING} deep`)
  })

  test("shapes that make marked rescan are cut where its work passes MAX_BLOCK_WORK", () => {
    const shapes: Record<string, string> = {
      "a list item's short lines": "- a\n" + "y\n".repeat(40_000),
      "quoted list items with lazy lines": "> - a\nlazy\n".repeat(9000),
      "quoted code with lazy lines": ">     a\nlazy\n".repeat(9000),
      "a table between rules": "h|h\n-|-\n" + "r|r\n***\nx\n***\n".repeat(7000),
      "task items": "- [ ] a\n".repeat(12_000),
      "tables of the wrong width": "a|b\n-|-|-\n".repeat(11_000),
      "display math that never closes, in an item": "- x\n" + "  $$\n  a\\\n".repeat(9000),
    }
    for (const [name, text] of Object.entries(shapes)) {
      const { reason, shown } = shownLength(text)
      expect({ name, cut: reason !== undefined && shown < text.length }).toEqual({ name, cut: true })
      // What shows is within the bound: measured again, it is not cut for its work. (In Chromium, a unit of
      // MAX_BLOCK_WORK takes marked 2 to 5 ns: test/e2e/review8-markdown.spec.ts measures the task.)
      expect({ name, again: shownLength(text.slice(0, shown)).reason }).not.toEqual({ name, again: "work" })
    }
    // 40 million since [review9#R8F-2]: the units were recalibrated in Chromium (a blockquote's lazy segments cost
    // marked per line, not per character), about 2.5 to 3 ns each, so the bound is still about 0.1 s of marked's work.
    expect(MAX_BLOCK_WORK).toBe(40_000_000)
    expect(markdownCut(10, 20, "work").message).toContain("blank lines")
  })

  test("quoted lists with a lazy line per item show whole at 100 KB, as marked lexes them in 40 to 60 ms [review9#R8F-2]", () => {
    // They were cut at 42 to 55 KB for their work: the model counted the rest of the quote three times a character for
    // each item, where marked copies an array of its lines, and joins and splits them again (about a nanosecond a
    // character, and more a line). The documents of the finding: sentences of ordinary words, each item wrapped onto a
    // line without its `>`.
    const vocabulary =
      "the scheduler retries jobs whose window overlaps a deploy cache invalidation config service request handler token user session queue worker index migration rollback build release pipeline cluster node metric alert latency budget storage backup restore schema field value default option flag endpoint client server proxy route header payload response error timeout".split(
        " ",
      )
    const draw = seeded(7)
    const sentence = (words: number) =>
      `${Array.from({ length: words }, () => vocabulary[draw(vocabulary.length)]).join(" ")}.`
    const fill = (target: number, make: (index: number) => string) => {
      let text = ""
      for (let index = 0; text.length < target; index++) text += make(index)
      return text
    }
    const shapes: Record<string, string> = {
      "a sentence, then a lazy sentence": fill(100_000, () => `> - ${sentence(8)}\n${sentence(6)}\n`),
      "a wrapped paragraph": fill(
        100_000,
        () => `> - ${sentence(12)} ${sentence(10)}\n${sentence(11)} ${sentence(9)}\n`,
      ),
      numbered: fill(100_000, (index) => `> ${index + 1}. ${sentence(12)}\n${sentence(12)}\n`),
    }
    for (const [name, text] of Object.entries(shapes))
      expect({ name, cut: shownLength(text) }).toEqual({ name, cut: { shown: text.length } })
    // With lines of a few characters, marked takes seconds (3.6 s at 100 KB): cut, where its work passes the bound.
    const short = "> - a\nlazy\n".repeat(9000)
    expect(shownLength(short).reason).toBe("work")
    expect(shownLength(short).shown).toBeLessThan(25_000)
  })
})

describe("what genui hands marked keeps the structure the model read [review8#R7F2-2]", () => {
  test("a link never joins lines: one that goes on to another line stays text", () => {
    // Written on one line, a link whose title ran over the next lines removed them, and with them the blocks marked
    // read there (a heading, a list): the model's runs and counts would not be marked's.
    for (const text of [
      '[a](http://x "t\n# h")',
      "[a](\nhttp://x)",
      '[a](http://x\n"t")',
      "![i][r\n]\n\n[r]: http://x",
    ]) {
      const out = neutralizeMarkdown(text, "Image")
      expect(out.split("\n").length, text).toBe(text.split("\n").length)
    }
    const html = parser.parse(neutralizeMarkdown('see [a](http://example.com "t\n# h")', "Image"), {
      async: false,
    }) as string
    expect(html).toContain("<h1")
  })

  test("a definition marked reads in a quote or a list item is written again there, and refers", () => {
    const text = "> [d]: https://example.com/docs\n>\n> See [the docs][d].\n\n- [e]: https://example.com/e\n\n  [e] too"
    const html = parser.parse(neutralizeMarkdown(text, "Image"), { async: false }) as string
    // (They stayed text: the references showed as written, and the definitions' addresses as bare links.)
    expect(html).toContain(">the docs</a>")
    expect(html).not.toContain("[d]")
    expect(html).not.toContain("[e]")
    expect(html.match(/href="#genui-link:/g)?.length).toBe(2)
    // A definition title with a quote stays a definition (marked reads its double-quoted title without escapes).
    const titled = parser.parse(neutralizeMarkdown('[x][d]\n\n[d]: https://example.com "it\'s"', "Image"), {
      async: false,
    }) as string
    expect(titled).toContain('href="#genui-link:')
    expect(titled).not.toContain("[d]")
  })

  test("a line ending in `<…>` ends with a joiner, so marked's setext rule does not stop at it", () => {
    const out = neutralizeMarkdown("- a\n  <div>\n  ===", "Image")
    expect(out.split("\n")[1]!.endsWith(JOINER)).toBe(true)
    expect(neutralizeMarkdown("    <div>", "Image").endsWith(JOINER)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// What genui hands marked is what the model read [review9#R8S-1] [review9#R8S-2]
// ---------------------------------------------------------------------------------------------------------------------

/** The raw emphasis delimiters in what marked lexes inline (each one it may search the rest of its paragraph for). */
function rawDelimiters(source: string): number {
  const lexer = new Lexer(parser.defaults as never)
  lexer.blockTokens(source, lexer.tokens)
  let count = 0
  for (const entry of lexer.inlineQueue as { src: string }[]) count += entry.src.match(/[*_~]/g)?.length ?? 0
  return count
}

/**
 * List items whose lazy lines start with what neutralizing lengthens (a tag, an image, a link, an address), before a
 * line that marked reads one way or the other by the characters at the item's content column of the line before.
 */
function lazyDocument(draw: (n: number) => number): string {
  const pick = <T>(values: readonly T[]) => values[draw(values.length)]!
  const out: string[] = []
  for (let item = 0, items = 1 + draw(6); item < items; item++) {
    const marker = pick(["-", "*", "+", "1.", "10.", "999999999.", "> -", "- >"])
    out.push(" ".repeat(draw(4)) + marker + " ".repeat(1 + draw(4)) + pick(["*", "x", "a b", "", "<i>", "# h"]))
    for (let line = 0, lines = 1 + draw(3); line < lines; line++) {
      const lead = pick(["<i>", "<b>x</b>", "![](u)", "![a](u)", "[a](u)", "www.x", "http://x", "a<b", "x", "ab", ""])
      const tail = pick(["#", " #", "---", "```", "    ", "*", "x", "$$", " |a|", "==="])
      out.push(" ".repeat(draw(3)) + lead + pick(["", " ", "x", "xx", "xxx"]) + tail)
    }
    out.push(pick(["\t-", "\tx", "    *a", "  -", "\t*a *b", "x", "", "\t$$", "    |-|"]))
    if (draw(3) === 0) out.push("")
  }
  return out.join("\n")
}

describe("what genui hands marked is what the model read [review9#R8S-1] [review9#R8S-2]", () => {
  test("a lazy line neutralizing lengthens no longer hides a paragraph from the cut and the budgets", () => {
    // The model read the third line as code (the raw `<i>xx#` cut at the item's column is `#`, a heading, which ends
    // the item), but marked got `<⁠i>xx#` and lexed the rest as one paragraph, neutralized as code: 40 KB of `*a ` with
    // every `*` raw took marked 25 s in V8 (b943538 cut it at 20,000).
    for (const tail of ["*a ".repeat(13_333), "word ".repeat(5000), "*a ".repeat(150_000)]) {
      const text = "1.   *\n<i>xx#\n\t" + tail
      const { shape, parts } = handed(text)
      expect(shape.cut).toEqual({ shown: "1.   *\n<i>xx#\n".length, reason: "lines" })
      expect(Math.max(...parts.flatMap((part) => lex(part).runs))).toBeLessThan(100)
      expect(parts.reduce((total, part) => total + rawDelimiters(part), 0)).toBeLessThan(5)
      // Unchecked, marked got all of it in one run, every delimiter raw.
      const before = unchecked(text)
      expect(Math.max(...before.flatMap((part) => lex(part).runs))).toBeGreaterThan(MAX_PARAGRAPH)
    }
    expect(markdownCut(14, 40_014, "lines").message).toContain("indent such lines")
  })

  test("indented code after such a line is counted where it shows: 4,310 uncounted code blocks in 98 KB before", () => {
    const text = Array.from({ length: 5800 }, () => "1.   *\n<i> #\n\t-").join("\n\n")
    const { shape, parts } = handed(text)
    expect(shape.cut).toEqual({ shown: "1.   *\n<i> #\n".length, reason: "lines" })
    expect(shape.code).toBe(parts.reduce((total, part) => total + lex(part).code, 0))
    // Unchecked, marked rendered a code block for most of them, and the model counted none.
    expect(unchecked(text).reduce((total, part) => total + lex(part).code, 0)).toBeGreaterThan(4000)
    expect(markdownShape(text.slice(0, 73_270)).code).toBe(0)
    // A line neutralizing leaves alone is read as written: each code block that shows counts (the text is cut for its
    // many small blocks), and the text is too large to render.
    const plain = Array.from({ length: 5800 }, () => "1.   *\nabcd #\n\t-").join("\n\n")
    const given = handed(plain)
    expect(given.shape.cut.reason).toBe("blocks")
    expect(given.shape.code).toBe(given.parts.reduce((total, part) => total + lex(part).code, 0))
    expect(given.shape.code).toBeGreaterThan(4000)
    expect(domUnits("Markdown", { content: plain })).toBeGreaterThan(2000)
  })

  test("through the real neutralizer, the model's counts and runs are marked's for what it gets", () => {
    // Generated documents through genui's own pipeline (cut, split, neutralized), lexed by the app's marked as they are:
    // the code blocks charged are the ones marked renders, and each part's blocks, code and runs (in number; longer
    // only by what neutralizing wrote) are what the model read in the part as written. (The test above the fold
    // compares the model with marked on texts as written, through a stand-in that keeps every length.)
    const failures: string[] = []
    let checked = 0
    for (let seed = 1; seed <= 3000 && failures.length < 5; seed++) {
      const draw = seeded(seed * 104_729)
      const text =
        seed % 3 === 0 ? lazyDocument(draw) : seed % 3 === 1 ? lineDocument(draw) : structured(draw).join("\n")
      const { shape, parts, own } = handed(text)
      if (shape.cut.reason === "lines") checked++
      const written = writtenParts(text, shape.cut.shown)
      const out: string[] = []
      const rendered = parts.reduce((total, part) => total + lex(part).code + lex(part).math, own)
      if (rendered !== shape.code) out.push(`code blocks: charged ${shape.code}, marked ${rendered}`)
      if (written.length !== parts.length) out.push(`parts: ${written.length} written, ${parts.length} handed`)
      written.forEach((source, index) => {
        const model = blockStructure(source)
        const reference = lex(parts[index] ?? "")
        const added = (parts[index] ?? "").length - source.length
        if (model.code + model.math !== reference.code + reference.math)
          out.push(`part ${index} code: model ${model.code + model.math}, marked ${reference.code + reference.math}`)
        const types = new Set([...Object.keys(model.blocks), ...Object.keys(reference.blocks)])
        for (const type of types)
          if (type !== "math" && (model.blocks[type] ?? 0) !== (reference.blocks[type] ?? 0))
            out.push(`part ${index} ${type}: model ${model.blocks[type] ?? 0}, marked ${reference.blocks[type] ?? 0}`)
        if (model.runs.length !== reference.runs.length)
          out.push(`part ${index} runs: model ${model.runs.length}, marked ${reference.runs.length}`)
        if (Math.max(0, ...reference.runs) > Math.max(0, ...model.runs) + added)
          out.push(
            `part ${index} longest run: model ${Math.max(0, ...model.runs)}, marked ${Math.max(...reference.runs)}`,
          )
      })
      if (out.length) failures.push(`${JSON.stringify(text)}\n  ${out.join("\n  ")}`)
    }
    expect(failures).toEqual([])
    // Some documents of each generator diverged neutralized, and were cut where they did.
    expect(checked).toBeGreaterThan(10)
  }, 120_000)

  test("what it hands the renderer is checked whatever cut it is given, and kept for a bounded number of texts", () => {
    // MarkdownText passes the cut markdownShape found; given another (here none), the parts are checked all the same.
    const text = "1.   *\n<i>xx#\n\t" + "*a ".repeat(13_333)
    const parts = prepareMarkdown(text, "Image", { shown: text.length })
    expect(Math.max(...parts.flatMap((part) => (part.kind === "markdown" ? lex(part.text).runs : [])))).toBeLessThan(
      100,
    )
    // The parts markdownShape prepared to check a text are kept for MarkdownText: at most 64 texts, and 2,000,000
    // characters of texts and parts (and the newest).
    for (let index = 0; index < 300; index++) markdownShape(`text ${index}`)
    expect(preparedCache().texts).toBeLessThanOrEqual(64)
    const long = (index: number) => `${index} ${"word ".repeat(80_000)}`
    for (let index = 0; index < 12; index++) markdownShape(long(index))
    expect(preparedCache().chars).toBeLessThanOrEqual(SHAPE_CACHE_CHARS + long(0).length + 2 * MAX_PARAGRAPH)
    expect(preparedCache().texts).toBeLessThan(12)
  })
})
