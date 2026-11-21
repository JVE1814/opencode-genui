import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "@opencode/ui/context/marked-parser"
import { Lexer, type Token } from "marked"
import {
  blockStructure,
  blockWork,
  CHARS_PER_BLOCK,
  codeBlocks,
  JOINER,
  LINK_PREFIX,
  linkTarget,
  type MarkdownPart,
  markdownShape,
  MAX_BLOCK_WORK,
  MAX_MARKDOWN_BLOCKS,
  MAX_NESTING,
  MAX_PARAGRAPH,
  markdownBudget,
  markdownWork,
  neutralizeMarkdown,
  prepareMarkdown,
  preparedCache,
  renderMarkdown,
  SHAPE_CACHE_CHARS,
  shownLength,
  splitMarkdown,
  stripJoiners,
} from "../../src/gui/components/markdown.ts"
import { CELLS_PER_UNIT, CODE_PART_UNITS, domUnits, markdownUnits, MAX_TABLE_CELLS } from "../../src/gui/costs.ts"
import { markdownCut, tooLarge } from "../../src/gui/issues.ts"
import { RENDER_UNITS, TEXT_PER_UNIT } from "../../src/shared/constants.ts"
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

/**
 * The Markdown parts genui hands the renderer for a text, as MarkdownText does (see renderMarkdown: cut where
 * markdownShape says, or earlier where its check cuts it), and what the render budget charged for the text (`charged`:
 * markdownShape, the model's reading of the text as written).
 */
function handed(text: string) {
  const charged = markdownShape(text)
  const { cut, parts } = renderMarkdown(text, "Image")
  return {
    charged,
    cut,
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
      // What shows as MarkdownText renders it (the check's cut included).
      const { reason, shown } = renderMarkdown(text, "Image").cut
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
    // 406, and since [review10#R8D-2] its 1,700 bold terms count too, two inline elements each (two `**` runs can make
    // two, so the count never falls short): about 440 in all. It renders, within the budget (2,000 for a UI).
    expect(domUnits("Markdown", { content: glossary })).toBeLessThan(450)
    expect(domUnits("Markdown", { content: glossary }) + glossary.length / TEXT_PER_UNIT).toBeLessThan(1000)
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
    expect(markdownCut(10, 20, "blocks").message).toContain("too many and too close")
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
    // Prose with a link, some emphasis and code in each paragraph: its blocks and inline elements are further apart
    // than one per CHARS_PER_BLOCK characters, so its length pays for them.
    const prose = (length: number) => {
      let text = ""
      for (let index = 1; text.length < length; index++)
        text += `## Part ${index}\n\nThis part of the guide explains how the scheduler retries a job whose window overlaps a deploy, and what **step ${index}** changes in \`config_${index}.yaml\`; see [the runbook](https://example.com/runbook/${index}) for the details and the _notes_ on rollback.\n\n`
      return text
    }
    for (const length of [20_000, 100_000, 400_000]) {
      const text = prose(length)
      expect(markdownShape(text)).toEqual({ cut: { shown: text.length }, code: 0, own: 0, blocks: 0 })
      expect(markdownUnits(text)).toBe(0)
    }
    expect(markdownUnits("plain")).toBe(0)
  })

  test("dense ones pay for their blocks and inline elements beyond that, and show whole up to 100 KB", () => {
    // A heading, a paragraph with three formatted spans and two items every 130 characters (one node per 16) paid
    // nothing before [review10#R8D-2], when only blocks counted: its emphasis and code spans count now (bold as two,
    // as two `**` runs can be), so it pays the rest, as a text of tiny links or emphases must.
    const doc = (length: number, table: string) => {
      let text = ""
      for (let index = 1; text.length < length; index++)
        text += `## Section ${index}\n\nThis section explains **step ${index}** of the rollout, with \`config_${index}.yaml\` and _notes_.\n\n- item one for ${index}\n- item two for ${index}\n\n${table}`
      return text
    }
    for (const length of [20_000, 100_000]) {
      const text = doc(length, "")
      expect(markdownShape(text).cut).toEqual({ shown: text.length })
      expect(markdownUnits(text)).toBeGreaterThan(0)
      expect(markdownUnits(text)).toBeLessThan((0.45 * text.length) / TEXT_PER_UNIT)
      // With a table of one-character cells in each section, its blocks cost a little more: it still shows whole, and
      // its length's units and these stay within the budget.
      const tables = doc(length, "| a | b |\n|---|---|\n| 1 | x |\n\n")
      expect(markdownShape(tables).cut).toEqual({ shown: tables.length })
      expect(markdownUnits(tables) + tables.length / TEXT_PER_UNIT).toBeLessThan(2000)
    }
    // At 400 KB it builds about 20,000 nodes (22,000 with the tables), what a whole UI shows (RENDER_UNITS): the table
    // variant is cut where they pass the bound, and the other costs more than a UI holds, as the budget then says.
    const big = doc(400_000, "")
    expect(markdownShape(big).cut).toEqual({ shown: big.length })
    expect(markdownUnits(big) + big.length / TEXT_PER_UNIT).toBeGreaterThan(2000)
    const tables = doc(400_000, "| a | b |\n|---|---|\n| 1 | x |\n\n")
    expect(markdownShape(tables).cut.reason).toBe("blocks")
    expect(markdownShape(tables).cut.shown).toBeGreaterThan(350_000)
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
      // 80 KB since [review10#R8D-1]: marked copies and splits the rest of the quote by the character twice as slowly
      // on text with a character outside Latin-1 (175 ms at 100 KB, against 60), as most text genui hands it is (a
      // joiner, a "…", a dash or a quote mark of the model's), and the bound now weighs that.
      "a sentence, then a lazy sentence": fill(80_000, () => `> - ${sentence(8)}\n${sentence(6)}\n`),
      "a wrapped paragraph": fill(
        100_000,
        () => `> - ${sentence(12)} ${sentence(10)}\n${sentence(11)} ${sentence(9)}\n`,
      ),
      numbered: fill(100_000, (index) => `> ${index + 1}. ${sentence(12)}\n${sentence(12)}\n`),
    }
    for (const [name, text] of Object.entries(shapes))
      expect({ name, cut: shownLength(text) }).toEqual({ name, cut: { shown: text.length } })
    const longer = fill(100_000, () => `> - ${sentence(8)}\n${sentence(6)}\n`)
    expect(shownLength(longer).reason).toBe("work")
    expect(shownLength(longer).shown).toBeGreaterThan(78_000)
    // With lines of a few characters, marked takes seconds (3.6 s at 100 KB): cut, where its work passes the bound.
    const short = "> - a\nlazy\n".repeat(9000)
    expect(shownLength(short).reason).toBe("work")
    expect(shownLength(short).shown).toBeLessThan(25_000)
  })

  test("the lines marked's setext and table rules read past are weighed as marked spends on them [review9#R8C-2]", () => {
    // marked's time on texts of these units against a reference unit, measured in Chromium (blockTokens on the text
    // as genui hands it, with a character outside Latin-1, where marked's regexes run slowest), and the model's work
    // on the same texts: they must agree within a quarter. The setext rule reads on past every line that is not a
    // blank line, an underline or another block's start, from every paragraph's start: at each line it tries eight
    // other rules' starts, each of which backs up over the line's leading spaces, and the table rule's over a run of
    // `|`, `:`, `-` and spaces. A header whose delimiter row has another number of columns is tried with all the rows
    // after it. Weighed by their characters alone, the first two took marked twice the time a unit of the other shapes
    // did, and the third half (6 to 14 ns a unit against 2 to 3).
    const measured: [string, string, string, number][] = [
      ["lines of three spaces and a letter, between rules", "   a\n***\n", "a\n***\n", 3.5],
      ["runs of `|-`, between rules", "|-|-|-|-|-|-|-|-|-|-|-|-|-|-|x\n***\n", "a\n***\n", 12.2],
      ["lines of 30 letters, between rules", "a".repeat(30) + "\n***\n", "a\n***\n", 3.1],
      ["one-column table rows, between rules", "|r|\n***\nx\n***\n", "r|r\n***\nx\n***\n", 1.23],
      ["six-column headers over two-column delimiter rows", "a|b|c|d|e|f\n-|-\n", "a\n-|-\n", 1.39],
      // [review10#R8D-1] The table rule backs up over a run of `|` and spaces again for each number of leading spaces
      // it may take: weighed by the run alone, these took 5 to 6 ns a unit. And marked copies and splits the rest of a
      // quote by the character, on text outside Latin-1, more slowly than the model weighed (4.3 to 5.4 ns a unit).
      ["three spaces, then a run of `| `, between rules", "   | | | | | | | |x\n***\n", "a\n***\n", 19.5],
      ["one space, then a run of `| `, between rules", " | | | | | | | |x\n***\n", "a\n***\n", 10.25],
      [
        "quoted items of eight words, lazy lines of six",
        "> - the scheduler retries jobs whose window overlaps a\ndeploy cache config the scheduler retries\n",
        "> - a\nlazy\n",
        3.42,
      ],
      ["quoted items of two words, lazy lines of one", "> - the scheduler\nretries\n", "> - a\nlazy\n", 1.61],
    ]
    for (const [name, unit, reference, time] of measured) {
      const ratio = blockWork(unit.repeat(1500)) / blockWork(reference.repeat(1500))
      expect({ name, agrees: ratio > time * 0.75 && ratio < time * 1.25 }).toEqual({ name, agrees: true })
    }
    // So 100 KB of each is cut where marked would take about 0.1 s.
    for (const [name, unit] of measured) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length))
      const { reason, shown } = shownLength(text)
      expect({ name, reason }).toEqual({ name, reason: "work" })
      expect(blockWork(text, shown)).toBeLessThanOrEqual(MAX_BLOCK_WORK)
    }
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
      const { charged, cut, parts } = handed(text)
      // Cut where it renders. The render budget charged for the text as the model reads it as written (one code block,
      // whole): never less than what shows [review9#R8C-1].
      expect(cut).toEqual({ shown: "1.   *\n<i>xx#\n".length, reason: "lines" })
      expect(charged).toEqual({ cut: { shown: text.length }, code: 1, own: 0, blocks: 0 })
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
    const { charged, cut, parts } = handed(text)
    expect(cut).toEqual({ shown: "1.   *\n<i> #\n".length, reason: "lines" })
    // What shows renders no code block, as the model read it, and the charge (the text as written, read whole up to
    // its cut for blocks) counted none either.
    expect(parts.reduce((total, part) => total + lex(part).code, 0)).toBe(0)
    expect(charged.code).toBe(0)
    // Unchecked, marked rendered a code block for most of them, and the model counted none.
    expect(unchecked(text).reduce((total, part) => total + lex(part).code, 0)).toBeGreaterThan(4000)
    expect(renderMarkdown(text.slice(0, 73_270), "Image").cut).toEqual(cut)
    // A line neutralizing leaves alone is read as written: each code block that shows counts (the text is cut for its
    // many small blocks), and the text is too large to render.
    const plain = Array.from({ length: 5800 }, () => "1.   *\nabcd #\n\t-").join("\n\n")
    const given = handed(plain)
    expect(given.cut.reason).toBe("blocks")
    expect(given.charged.cut).toEqual(given.cut)
    expect(given.charged.code).toBe(given.parts.reduce((total, part) => total + lex(part).code, 0))
    expect(given.charged.code).toBeGreaterThan(4000)
    expect(domUnits("Markdown", { content: plain })).toBeGreaterThan(2000)
  })

  test("through the real neutralizer, the model's counts and runs are marked's for what it gets", () => {
    // Generated documents through genui's own pipeline (cut, split, neutralized), lexed by the app's marked as they are:
    // the code blocks charged are the ones marked renders (fewer when the check cut the text earlier than the charge
    // did [review9#R8C-1]), and each part's blocks, code and runs (in number; longer only by what neutralizing wrote)
    // are what the model read in the part as written. (The test above the fold compares the model with marked on texts
    // as written, through a stand-in that keeps every length.)
    const failures: string[] = []
    let checked = 0
    for (let seed = 1; seed <= 3000 && failures.length < 5; seed++) {
      const draw = seeded(seed * 104_729)
      const text =
        seed % 3 === 0 ? lazyDocument(draw) : seed % 3 === 1 ? lineDocument(draw) : structured(draw).join("\n")
      const { charged, cut, parts, own } = handed(text)
      if (cut.reason === "lines") checked++
      const written = writtenParts(text, cut.shown)
      const out: string[] = []
      const rendered = parts.reduce((total, part) => total + lex(part).code + lex(part).math, own)
      if (cut.reason === "lines" ? rendered > charged.code : rendered !== charged.code)
        out.push(`code blocks: charged ${charged.code}, marked ${rendered}`)
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
    // The parts MarkdownText rendered are kept for it (a remount, a repeat's rows): at most 64 texts, and 2,000,000
    // characters of texts and parts (and the newest). (markdownShape prepared and kept them before: it now prepares
    // nothing [review9#R8C-1].)
    for (let index = 0; index < 300; index++) renderMarkdown(`text ${index}`, "Image")
    expect(preparedCache().texts).toBeLessThanOrEqual(64)
    const long = (index: number) => `${index} ${"word ".repeat(80_000)}`
    for (let index = 0; index < 12; index++) renderMarkdown(long(index), "Image")
    expect(preparedCache().chars).toBeLessThanOrEqual(SHAPE_CACHE_CHARS + long(0).length + 2 * MAX_PARAGRAPH)
    expect(preparedCache().texts).toBeLessThan(12)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The charge is the model's reading; the check runs where a text renders [review9#R8C-1]
// ---------------------------------------------------------------------------------------------------------------------

/** Lines of `size` characters in all, line `i` being `line(i)`. */
function linesOf(size: number, line: (i: number) => string): string {
  const out: string[] = []
  for (let i = 0, length = 0; length < size; i++) {
    out.push(line(i))
    length += out.at(-1)!.length + 1
  }
  return out.join("\n")
}

/**
 * Paragraphs of links, which neutralizing writes again, ending in a list item whose lazy line it lengthens. (With words
 * between them since [review10#R8D-2]: four links in 40 characters are more inline elements than their length pays
 * for, and such a text is cut for them long before its end.)
 */
const linkText = (size: number, end: string) =>
  linesOf(size, (i) =>
    i % 3 === 2
      ? ""
      : "[a](b) [c](http://d.e) <i>x</i> www.f.g, then a sentence of ordinary words that goes on for a while before it ends.",
  ) + `\n\n1.   *\n<i> #\n\t-\n${end}`

const rowCount = (text: string) => text.split(/\r\n|\r|\n/).length

describe("the render budget charges the model's reading alone; the check runs where a text renders [review9#R8C-1]", () => {
  test("charging texts never neutralizes them: four 495 KB Accordion items cost one reading each", () => {
    // markdownShape neutralized and checked every text it measured, so the render charge of a closed Accordion of four
    // such items, in a 103 KB spec the budget then refused, blocked the window 2 s (0.11 s before), whether or not any
    // of it showed.
    const items = [0, 1, 2, 3].map((k) => ({ title: `Item ${k}`, content: linkText(495_000, `end ${k}`) }))
    const before = markdownWork()
    expect(domUnits("Accordion", { items, type: "multiple", defaultOpen: [] })).toBeGreaterThan(0)
    for (const { content } of items) markdownUnits(content)
    const after = markdownWork()
    expect(after.neutralized - before.neutralized).toBe(0)
    expect(after.modeled - before.modeled).toBe(items.reduce((total, item) => total + rowCount(item.content), 0))
    // Each still diverges where it renders, and is cut there (within its charge: see below).
    const { cut } = renderMarkdown(items[0]!.content, "Image")
    expect(cut.reason).toBe("lines")
    expect(cut.shown).toBeLessThan(markdownShape(items[0]!.content).cut.shown)
  })

  test("a text cut where it renders is neutralized once, and read once more only up to the cut", () => {
    // It was neutralized twice and read five times (the cut text checked again from scratch): 1.25 to 1.74 s for one
    // 495 KB text of links that diverges at its end, against 0.5 to 0.7 s before the check.
    const text = linkText(400_000, "end")
    const rows = rowCount(text)
    markdownShape(text)
    const before = markdownWork()
    const { cut, parts } = renderMarkdown(text, "Image")
    const after = markdownWork()
    expect(cut).toEqual({ shown: text.indexOf("<i> #\n\t-") + "<i> #\n".length, reason: "lines" })
    // Once over the text and the lines a cut text ends with; the model reads it as written, neutralized, and the
    // neutralized rows up to the cut once more.
    expect(after.neutralized - before.neutralized).toBeLessThanOrEqual(rows + 3)
    expect(after.modeled - before.modeled).toBeLessThanOrEqual(3 * rows + 6)
    // What it hands the renderer: the rows before the cut, as neutralized in the first pass.
    expect(parts.length).toBe(1)
    expect(parts[0]!.kind === "markdown" && parts[0]!.text.endsWith("\n\n\n…")).toBe(true)
    // Rendered again (a remount, a repeat's rows), it is not prepared again.
    const again = markdownWork()
    expect(renderMarkdown(text, "Image")).toEqual({ cut, parts })
    expect(markdownWork()).toEqual(again)
  })

  test("what renders never costs more than its charge, on generated documents and the check's cuts", () => {
    // The render budget charges a text by the model's reading of it as written (markdownShape, markdownUnits); what
    // MarkdownText hands the renderer is that text neutralized, cut earlier where the check finds the model reads it
    // otherwise (renderMarkdown). Lexed by the app's marked, what renders is within the charge: its code blocks, those
    // shown on their own, and its blocks beyond what the text's length pays for (counted as the charge counts them: the
    // element's props pay for the text's length, so its blocks are allowed one per CHARS_PER_BLOCK of the text as
    // written up to the charged cut).
    const texts: string[] = []
    for (let seed = 1; seed <= 1500; seed++) {
      const draw = seeded(seed * 15_485_863)
      const kind = seed % 4
      let text = kind === 0 ? lazyDocument(draw) : kind === 1 ? lineDocument(draw) : structured(draw).join("\n")
      // Some lines grown past a paragraph's length, and some ending in a lazy line neutralizing lengthens.
      if (kind === 3) {
        const lines = text.split("\n")
        const index = draw(lines.length)
        lines[index] = lines[index] + " " + "word ".repeat(1000 + draw(4200))
        text = lines.join("\n")
      }
      if (draw(4) === 0) text += "\n" + lazyDocument(draw)
      texts.push(text)
    }
    // [review9#R8S-1] and [review9#R8S-2], and a long text that diverges at its end.
    texts.push("1.   *\n<i>xx#\n\t" + "*a ".repeat(13_333))
    texts.push(Array.from({ length: 5800 }, () => "1.   *\n<i> #\n\t-").join("\n\n"))
    texts.push(Array.from({ length: 5800 }, () => "1.   *\nabcd #\n\t-").join("\n\n"))
    texts.push(linkText(60_000, "end"))
    // Tiny blocks, more than their length pays for, before a paragraph cut, or before a line the check cuts at where
    // the rows it takes away held no block: what renders ends with a paragraph "…" of its own, which the charge counts
    // (one of these ten crosses a unit with it).
    for (let items = 3000; items < 3010; items++) texts.push("- a\n".repeat(items) + "\n" + "word ".repeat(5000))
    texts.push(
      "- a\n".repeat(400) + "\n   1. x\n  ![a](u) ---\nx",
      "- a\n".repeat(400) + "\n  10. x\n a<b*\n  ![a](u)x\n\tx",
    )
    const failures: string[] = []
    let lines = 0
    for (const text of texts) {
      const charged = markdownShape(text)
      const { cut, parts } = renderMarkdown(text, "Image")
      if (cut.reason === "lines") lines++
      let code = 0
      let own = 0
      let blocks = 0
      for (const part of parts) {
        if (part.kind === "code") {
          own++
          code++
          continue
        }
        const read = lex(part.text)
        code += read.code + read.math
        for (const count of Object.values(read.blocks)) blocks += count
      }
      const allowed = Math.floor(charged.cut.shown / CHARS_PER_BLOCK)
      const units =
        own * CODE_PART_UNITS +
        (code - own) +
        Math.floor(Math.min(MAX_MARKDOWN_BLOCKS, Math.max(0, blocks - allowed)) / CELLS_PER_UNIT)
      const out: string[] = []
      // (The charge counts the blocks beyond `allowed`, up to MAX_MARKDOWN_BLOCKS.)
      if (charged.blocks < MAX_MARKDOWN_BLOCKS && blocks > charged.blocks + allowed)
        out.push(`blocks: ${blocks}, charged ${charged.blocks} beyond ${allowed}`)
      if (cut.shown > charged.cut.shown) out.push(`shows ${cut.shown}, charged ${charged.cut.shown}`)
      if (code > charged.code) out.push(`code blocks: ${code}, charged ${charged.code}`)
      if (own > charged.own) out.push(`code blocks on their own: ${own}, charged ${charged.own}`)
      if (units > markdownUnits(text)) out.push(`units: ${units}, charged ${markdownUnits(text)}`)
      if (out.length && failures.length < 5)
        failures.push(`${JSON.stringify(text.slice(0, 300))}\n  ${out.join("\n  ")}`)
    }
    expect(failures).toEqual([])
    // The check cut some of them where they render.
    expect(lines).toBeGreaterThan(50)
  }, 120_000)
})

/** marked's block work on what renderMarkdown hands it, each part lexed on its own (see MAX_BLOCK_WORK). */
const handedWork = (parts: readonly { kind: string; text?: string }[]) =>
  parts.reduce((total, part) => total + (part.kind === "markdown" ? blockStructure(part.text!).work : 0), 0)

describe("marked's block work is bounded on the text it gets, not on the text as written [review10#R8D-1]", () => {
  test("lines neutralizing lengthens (tenfold, a bare `www.` address) are cut where marked's work on them passes", () => {
    // The bound was tallied on the text as written, but marked reads the neutralized text, whose lines are up to 10.7
    // times longer, by the character (its setext and lazy-line scans): these took it 0.2 to 0.93 s each, at 5 to 24 ns
    // a unit as written, against about 0.1 s.
    const repeat = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
    const shapes: Record<string, string> = {
      "a list item's lines of `www.a`": "- a\n" + "www.a\n".repeat(20_000),
      "a quoted item's lines of `www.a`": "> - a\n" + "www.a\n".repeat(20_000),
      "addresses between rules": repeat("www.a.b www.c.d\n***\n", 100_000),
      "table cells of addresses between rules": "h|h\n-|-\n" + repeat("www.a.b|www.c.d\n***\nx\n***\n", 100_000),
      "links between rules": repeat("[a](http://b.c)[a](http://b.c)\n***\n", 100_000),
      // Here what follows the cut is lost by marked's blockquote, which lexes the list again after each lazy line:
      // MarkdownText's note still says the text is cut.
      "quoted items with lazy addresses": repeat("> - a\nwww.b.c\n", 100_000),
    }
    for (const [name, text] of Object.entries(shapes)) {
      const charged = markdownShape(text).cut
      const { cut, parts } = renderMarkdown(text, "Image")
      // Within the bound as written, the text the model cut at is far past it as marked gets it.
      expect(blockWork(text, charged.shown)).toBeLessThanOrEqual(MAX_BLOCK_WORK)
      const unbounded = blockStructure(neutralizeMarkdown(text.slice(0, charged.shown), "Image")).work
      expect({ name, past: unbounded > 1.5 * MAX_BLOCK_WORK }).toEqual({ name, past: true })
      // Cut where it renders, for marked's work, which is within the bound on what it gets.
      expect({ name, reason: cut.reason, shows: cut.shown > 1000 }).toEqual({ name, reason: "work", shows: true })
      expect(cut.shown).toBeLessThan(charged.shown)
      expect({ name, within: handedWork(parts) <= MAX_BLOCK_WORK }).toEqual({ name, within: true })
      expect(markdownCut(cut.shown, text.length, "work").message).toContain("blank lines")
    }
  })

  test("the bound is shared by a text's parts, in their order, as marked gets them", () => {
    // Fenced code blocks split a text into parts marked lexes one by one: their work adds up to the one bound.
    const piece = "- a\n" + "www.a\n".repeat(550)
    const text = Array.from({ length: 6 }, () => piece).join("\n```\ncode\n```\n")
    expect(markdownShape(text).cut).toEqual({ shown: text.length })
    const { cut, parts } = renderMarkdown(text, "Image")
    expect(cut.reason).toBe("work")
    expect(parts.filter((part) => part.kind === "code").length).toBeGreaterThan(0)
    expect(handedWork(parts)).toBeLessThanOrEqual(MAX_BLOCK_WORK)
    // Each part alone is within it: only their sum is not.
    expect(blockStructure(neutralizeMarkdown(piece, "Image")).work).toBeLessThan(MAX_BLOCK_WORK)
  })

  test("ordinary documents with links show whole", () => {
    // Paragraphs, lists and quotes of links and addresses, separated as people write them, lengthen as much and cost
    // marked nothing to speak of.
    const words = "deploy the service behind the proxy and check the dashboard".split(" ")
    const draw = seeded(11)
    const sentence = () => Array.from({ length: 10 }, () => words[draw(words.length)]).join(" ")
    let text = ""
    for (let index = 0; text.length < 100_000; index++)
      text +=
        index % 3 === 0
          ? `## Section ${index}\n\n${sentence()} [docs](https://example.com/${index}) and www.example.com/${index}.\n\n`
          : index % 3 === 1
            ? `- ${sentence()} <https://example.com/a/${index}>\n- ${sentence()} [link](https://b.example/${index})\n\n`
            : `> ${sentence()} http://example.org/${index}\n> ${sentence()}\n\n`
    const { cut, parts } = renderMarkdown(text, "Image")
    expect(cut).toEqual({ shown: text.length })
    expect(handedWork(parts)).toBeLessThan(MAX_BLOCK_WORK / 10)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Inline elements count with blocks [review10#R8D-2]
// ---------------------------------------------------------------------------------------------------------------------

const INLINE_TOKENS = new Set(["link", "image", "em", "strong", "del", "codespan", "br", "inlineKatex", "html"])

/** The blocks and inline elements the app's marked builds for a text (all its tokens, inline ones included). */
function nodesOf(source: string): { blocks: number; inline: number } {
  let blocks = 0
  let inline = 0
  const walk = (list: readonly Token[] | undefined) => {
    for (const token of list ?? []) {
      if (INLINE_TOKENS.has(token.type)) inline++
      if (["paragraph", "heading", "hr", "blockquote"].includes(token.type)) blocks++
      if (token.type === "list")
        for (const item of token.items) {
          blocks++
          walk(item.tokens)
        }
      else if (token.type === "table") {
        blocks += token.header.length * (1 + token.rows.length)
        for (const cell of token.header) walk(cell.tokens)
        for (const row of token.rows) for (const cell of row) walk(cell.tokens)
      } else if ("tokens" in token) walk(token.tokens as Token[])
    }
  }
  walk(parser.lexer(source) as Token[])
  return { blocks, inline }
}

/** The blocks and inline elements marked builds for what renderMarkdown hands it, against what the charge allows. */
function renderedNodes(text: string) {
  const charged = markdownShape(text)
  const { cut, parts } = renderMarkdown(text, "Image")
  let nodes = 0
  for (const part of parts)
    if (part.kind === "markdown") {
      const counted = nodesOf(part.text)
      nodes += counted.blocks + counted.inline
    }
  // The charge counts the nodes beyond one per CHARS_PER_BLOCK of the text as written, up to its cut.
  return { charged, cut, nodes, allowed: charged.blocks + Math.floor(charged.cut.shown / CHARS_PER_BLOCK) }
}

describe("a text's links, emphases and code spans count with its blocks, charged and cut past the bound [review10#R8D-2]", () => {
  test("texts of tiny links, addresses, emphases or code spans are cut where they pass it, and charged for them", () => {
    // Only blocks counted: 480 KB of bare addresses (53,000 links), emphases or code spans (80,000 to 96,000) in a
    // 99 KB spec blocked the playground 1.5 to 2.1 s in one task (genui's own part up to 0.66 s), each a node the
    // renderer builds.
    const lines = (line: string, size = 150_000) => linesOf(size, (i) => (i % 3 === 2 ? "" : line))
    const shapes: Record<string, string> = {
      "bare addresses": lines("www.a www.b www.c www.d"),
      links: lines("[a](http://b.c) [c](http://d.e) [f](http://g.h) [i](j)"),
      "references to a definition": `[x]: http://a.b\n\n${lines("[a][x] [b][x] [x] [x][]")}`,
      "e-mail addresses": lines("a@b.cd e@f.gh i@j.kl"),
      autolinks: lines("<ab:c> <de:f> <gh:i>"),
      emphases: lines("*a* *b* *c* *d* *e*"),
      "strong emphases": lines("**a** **b** **c** **d**"),
      strikethrough: lines("~a~ ~~b~~ ~c~ ~~d~~"),
      "code spans": lines("`a` `b` `c` `d` `e`"),
      math: lines("$a$ $b$ $c$ $d$"),
      "hard line breaks": linesOf(150_000, (i) => (i % 50 === 49 ? "" : "abc  ")),
    }
    for (const [name, text] of Object.entries(shapes)) {
      const { charged, cut, nodes, allowed } = renderedNodes(text)
      expect({ name, reason: charged.cut.reason }).toEqual({ name, reason: "blocks" })
      expect(cut.shown).toBeLessThanOrEqual(charged.cut.shown)
      expect({ name, charged: charged.blocks > 0.99 * MAX_MARKDOWN_BLOCKS }).toEqual({ name, charged: true })
      // What marked builds of what shows is within what the charge counted.
      expect({ name, within: nodes <= allowed }).toEqual({ name, within: true })
      // A 480 KB text of them costs more than a UI holds: the budget refuses it, as the playground showed.
      const big = text.repeat(5)
      expect(markdownUnits(big) + big.length / TEXT_PER_UNIT).toBeGreaterThan(RENDER_UNITS)
    }
    expect(markdownCut(10, 20, "blocks").message).toContain("links, emphases or code spans")
  })

  test("the count never falls short of what marked builds, on generated documents of inline syntax", () => {
    // Links (inline, reference, images, autolinks, addresses, e-mail), emphasis of every kind, code spans, math and
    // line breaks, in paragraphs, list items, quotes, headings and table rows, with stray delimiters and nesting.
    const atoms = [
      "*a*",
      "**b**",
      "***c***",
      "_d_",
      "__e__",
      "~f~",
      "~~g~~",
      "`h`",
      "``i``",
      "[j](k)",
      "[l](http://m.n)",
      "![o](p)",
      "![](http://q.r)",
      "[s][x]",
      "[x]",
      "[x][]",
      "![t][x]",
      "www.u.v",
      "http://w.x",
      "https://www.y.z",
      "<foo:bar>",
      "<http://a.b>",
      "<c@d.ef>",
      "g@h.ij",
      "$k$",
      "$$l$$",
      "\\(m\\)",
      "n_o_p",
      "*",
      "**",
      "_",
      "~",
      "`",
      "[",
      "]",
      "!",
      "<",
      "\\*",
      "word",
      "words here",
      "q*r*s",
      "t**u**v",
      "*w**x*",
      "**y*z**",
      "[*a*](b)",
      "[`c`](d)",
      "[www.e.f](g)",
      "*[h](i)*",
      "`[j](k)`",
      "<i>x</i>",
    ]
    const prefixes = ["", "", "", "- ", "* ", "1. ", "> ", "> - ", "## ", "  ", "    ", "| ", "\t"]
    const failures: string[] = []
    let total = 0
    for (let seed = 1; seed <= 1500; seed++) {
      const draw = seeded(seed * 2_654_435_761)
      const out: string[] = []
      if (draw(3) === 0) out.push("[x]: http://def.example 'T'", "")
      for (let line = 0, count = 1 + draw(40); line < count; line++) {
        const parts = Array.from({ length: draw(12) }, () => atoms[draw(atoms.length)]!)
        let row = prefixes[draw(prefixes.length)]! + parts.join(draw(4) === 0 ? "" : " ")
        if (draw(10) === 0) row += "  "
        if (draw(15) === 0) row += "\\"
        if (draw(8) === 0) row += ` | ${atoms[draw(atoms.length)]} |`
        out.push(row)
        if (draw(4) === 0) out.push("")
        if (draw(20) === 0) out.push(draw(2) ? "---" : "|-|-|")
      }
      let text = out.join("\n")
      if (seed % 5 === 0) text = text.repeat(1 + draw(30))
      const { charged, nodes, allowed } = renderedNodes(text)
      total += nodes
      if (charged.blocks < MAX_MARKDOWN_BLOCKS && nodes > allowed && failures.length < 5)
        failures.push(`${nodes} nodes, ${allowed} allowed: ${JSON.stringify(text.slice(0, 300))}`)
    }
    expect(failures).toEqual([])
    expect(total).toBeGreaterThan(100_000)
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// A cut that would not read alike steps back [review11#R8G-1]
// ---------------------------------------------------------------------------------------------------------------------

/** A quoted reference list of `size` characters: each item a few words and a link, going on to a lazy line. */
function quotedReferences(size: number): string {
  const words = "alpha beta gamma delta service cache token queue".split(" ")
  let state = 3
  const word = () => words[(state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % words.length]!
  let text = ""
  while (text.length < size)
    text += `> - ${word()} ${word()} [${word()}](https://${word()}.io)\n${word()} https://${word()}.dev/x\n`
  return text
}

/**
 * Quoted and lazy lists as people write them: items of a few words and a link (or none), going on to lazy lines of
 * links or sentences (some indented short of the item's content), with a blank line now and then.
 */
function lazyList(draw: (n: number) => number, size: number): string {
  const pick = <T>(values: readonly T[]) => values[draw(values.length)]!
  const words = "the scheduler retries jobs whose window overlaps a deploy cache config service token queue 1".split(
    " ",
  )
  const word = () => pick(words)
  const link = () =>
    pick([
      `www.${word()}.com`,
      `https://${word()}.dev/${word()}`,
      `[${word()}](https://${word()}.io)`,
      `<https://${word()}.org>`,
      `[${word()}][r${draw(4)}]`,
    ])
  const sentence = (count: number, links: number) => {
    const out = Array.from({ length: count }, word)
    for (let index = 0; index < links; index++) out.splice(draw(out.length + 1), 0, link())
    return out.join(" ") || word()
  }
  const marker = pick(["> - ", "> 1. ", "> * ", "> - ", "> 1. ", "> - > ", "> > - ", "- ", "> ", "1. ", "> 10. "])
  const most = 2 + draw(6)
  const lazy = 1 + draw(3)
  const indent = draw(5) === 0 ? " ".repeat(1 + draw(4)) : ""
  const blankEvery = draw(5) === 0 ? 3 + draw(6) : 0
  let text = "[r0]: https://a.example\n[r1]: https://b.example\n[r2]: https://c.example\n[r3]: https://d.example\n\n"
  for (let item = 0; text.length < size; item++) {
    text += `${marker}${sentence(draw(most), draw(5) ? 1 : 0)}\n`
    for (let line = 0, lines = draw(5) ? 1 + draw(lazy) : 0; line < lines; line++)
      text += `${indent}${draw(2) ? link() : sentence(draw(most), 1)}\n`
    if (blankEvery && item % blankEvery === blankEvery - 1) text += "\n"
  }
  return text
}

/**
 * What renders of a text against its charge: the code blocks, blocks and inline nodes the app's marked builds of what
 * renderMarkdown hands it, as render units counted as the charge counts them (see the test of generated documents
 * above), and the lines the model read for it.
 */
function renderedAgainstCharge(text: string) {
  const charged = markdownShape(text)
  const before = markdownWork()
  const { cut, parts } = renderMarkdown(text, "Image")
  const modeled = markdownWork().modeled - before.modeled
  let code = 0
  let own = 0
  let blocks = 0
  for (const part of parts) {
    if (part.kind === "code") {
      own++
      code++
      continue
    }
    const read = lex(part.text)
    code += read.code + read.math
    for (const count of Object.values(read.blocks)) blocks += count
  }
  const allowed = Math.floor(charged.cut.shown / CHARS_PER_BLOCK)
  const units =
    own * CODE_PART_UNITS +
    (code - own) +
    Math.floor(Math.min(MAX_MARKDOWN_BLOCKS, Math.max(0, blocks - allowed)) / CELLS_PER_UNIT)
  return { charged, cut, parts, units, modeled, nodes: renderedNodes(text) }
}

describe("a cut that would not read alike steps back, rather than showing nothing [review11#R8G-1]", () => {
  test("quoted lists whose items go on to lazy lines show most of what their charge allows, cut for marked's work", () => {
    // The work cut landed on a quoted item's lazy line: cut there, the item's first row lost the lines it went on to,
    // which marked's blockquote lexes once where it lexed it twice, so the rows before the cut did not read as they
    // did, and the text was cut at its start: "Showing the first 0 of 20,000 characters" (and of 44,000), where the
    // charge allowed all of it. The cut now steps back before that item.
    for (const text of ["> - www.a\nwww.b\n".repeat(1250), quotedReferences(44_000)]) {
      const charged = markdownShape(text).cut
      expect(charged).toEqual({ shown: text.length })
      const { cut, parts } = renderMarkdown(text, "Image")
      expect(cut.reason).toBe("work")
      expect({ length: text.length, more: cut.shown > charged.shown / 2 }).toEqual({ length: text.length, more: true })
      expect(handedWork(parts)).toBeLessThanOrEqual(MAX_BLOCK_WORK)
      // Before an item: after the line its previous item went on to.
      expect(text.slice(cut.shown).startsWith("> - ")).toBe(true)
      const last = parts.at(-1)!
      expect(last.kind === "markdown" && last.text.endsWith("\n\n\n…")).toBe(true)
    }
  })

  test("generated quoted and lazy lists never show nothing where their charge allows text", () => {
    // Quoted and lazy lists of 15 to 100 KB, and a growing one at every 4 KB from 36 KB: before, 8 of the 36 showed
    // nothing, and the growing one did from 40 KB on. Whatever the check cuts, what renders is within the charge (in
    // render units, blocks and inline nodes), what marked gets is within the bound on its block work, and a cut part
    // is read a few times more at most.
    const texts: string[] = []
    for (let seed = 1; seed <= 36; seed++) {
      const draw = seeded(seed * 7_919)
      texts.push(lazyList(draw, 15_000 + draw(85_000)))
    }
    const growing = lazyList(seeded(2), 100_000)
    for (let size = 36_000; size <= 100_000; size += 4000)
      texts.push(growing.slice(0, growing.lastIndexOf("\n", size) + 1))
    const failures: string[] = []
    let cut = 0
    for (const text of texts) {
      const got = renderedAgainstCharge(text)
      const out: string[] = []
      if (got.cut.shown < got.charged.cut.shown) cut++
      if (got.charged.cut.shown > 0 && got.cut.shown === 0) out.push(`shows nothing of ${got.charged.cut.shown}`)
      if (got.cut.shown > got.charged.cut.shown) out.push(`shows ${got.cut.shown}, charged ${got.charged.cut.shown}`)
      if (handedWork(got.parts) > MAX_BLOCK_WORK) out.push(`work ${handedWork(got.parts)}`)
      if (got.units > markdownUnits(text)) out.push(`units: ${got.units}, charged ${markdownUnits(text)}`)
      if (got.charged.blocks < MAX_MARKDOWN_BLOCKS && got.nodes.nodes > got.nodes.allowed)
        out.push(`nodes: ${got.nodes.nodes}, allowed ${got.nodes.allowed}`)
      // Read as written and neutralized, and the cut at most four times (renderedNodes renders it again from the cache).
      if (got.modeled > 6 * rowCount(text) + 30) out.push(`read ${got.modeled} lines of ${rowCount(text)}`)
      if (out.length && failures.length < 5)
        failures.push(`${JSON.stringify(text.slice(0, 120))}\n  ${out.join("\n  ")}`)
    }
    expect(failures).toEqual([])
    // The check cut many of them where they render.
    expect(cut).toBeGreaterThan(10)
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// A loose list cut before the blank line that made it loose [review12#R8H-1]
// ---------------------------------------------------------------------------------------------------------------------

/** The blocks the model reads in the Markdown parts genui hands marked, by type, summed over the parts. */
function handedBlocks(parts: readonly MarkdownPart[]): Record<string, number> {
  const blocks: Record<string, number> = {}
  for (const part of parts)
    if (part.kind === "markdown")
      for (const [type, count] of Object.entries(blockStructure(part.text).blocks))
        blocks[type] = (blocks[type] ?? 0) + count
  return blocks
}

/**
 * Loose lists as people write them: a few items (in a quote, sometimes), one of them (the first, half the time) a long
 * run of short links, indented or not, and a blank line after each item.
 */
function looseList(draw: (n: number) => number): string {
  const pick = <T>(values: readonly T[]) => values[draw(values.length)]!
  const words = "api ui db io cdn docs blog status build release".split(" ")
  const word = () => pick(words)
  const link = () =>
    pick([
      `www.${word()}.com`,
      `[${word()}](https://${word()}.io)`,
      `https://${word()}.dev`,
      `<https://${word()}.org>`,
      `[${draw(9)}](https://${word()}.io)`,
    ])
  const marker = pick(["- ", "* ", "1. ", "10. ", "  - ", "> - ", "> 1. "])
  const quote = marker.startsWith(">") ? "> " : ""
  const indent = draw(3) ? " ".repeat(marker.length - quote.length) : ""
  let text = draw(2) ? `## ${word()} links\n\n` : draw(2) ? "Intro.\n\n" : ""
  const items = 2 + draw(5)
  const long = draw(2) ? 0 : draw(items)
  for (let item = 0; item < items; item++) {
    text += `${marker}${word()} ${word()}\n`
    for (let line = 0, lines = item === long ? 300 + draw(1200) : draw(4); line < lines; line++)
      text += `${quote}${indent}${link()}${draw(3) ? "" : ` ${word()}`}\n`
    text += quote ? ">\n" : "\n"
  }
  return text
}

describe("a loose list cut before the blank line that made it loose reads as a tight one, not as nothing [review12#R8H-1]", () => {
  test("loose lists cut for marked's work show most of what their charge allows, their items' text in no paragraph", () => {
    // Cut inside the list, before the blank line that made it loose, the list was tight: marked shows its items' text
    // in no paragraph, so the rows before the cut did not read as they did, and the cut stepped back before the list:
    // "Showing the first 8 of 20,026 characters" (10 of 12,037; 0 of 9,009; 0 of 8,014), no link, where the charge
    // allowed all of it. Read alike now: the same blocks, runs and code blocks, less those paragraphs.
    const texts: Record<string, string> = {
      "an item of links": "Intro.\n\n- Sources\n" + "  [a](https://a.io)\n".repeat(1000) + "\n- More\n",
      "an item of addresses": "## Links\n\n- References:\n" + "  www.a.com\n".repeat(1000) + "\n- Next item\n",
      "an item of lazy addresses": "- a\n" + "www.a\n".repeat(1500) + "\n- b\n",
      "a quoted item of addresses": "> - a\n" + "> www.a\n".repeat(1000) + ">\n> - b\n",
    }
    for (const [name, text] of Object.entries(texts)) {
      const charged = markdownShape(text).cut
      expect({ name, charged }).toEqual({ name, charged: { shown: text.length } })
      const { cut, parts } = renderMarkdown(text, "Image")
      expect({ name, reason: cut.reason, more: cut.shown > charged.shown / 2 }).toEqual({
        name,
        reason: "work",
        more: true,
      })
      expect(handedWork(parts)).toBeLessThanOrEqual(MAX_BLOCK_WORK)
      // As written, the list is loose: each item's text is a paragraph. What marked gets shows the first item, cut, as a
      // tight list's (its text in no paragraph), and the "…" in a paragraph of its own.
      const written = blockStructure(text).blocks
      const handed = handedBlocks(parts)
      expect({ name, items: handed.item, paragraphs: handed.paragraph }).toEqual({
        name,
        items: 1,
        paragraphs: written.paragraph! - written.item! + 1,
      })
    }
  })

  test("generated loose lists show at least half of what their charge allows", () => {
    // Before, 7 of these 40 showed less than a quarter of what their charge allowed (only the heading or the line
    // before the list, or nothing): 2 with a long first item cut before the blank line after it [R8H-1], the others a
    // link at the column where marked cuts a lazy line [R8H-2].
    const failures: string[] = []
    let cut = 0
    for (let seed = 1; seed <= 40; seed++) {
      const text = looseList(seeded(seed * 104_729))
      const charged = markdownShape(text).cut
      const { cut: shown, parts } = renderMarkdown(text, "Image")
      if (shown.shown < charged.shown) cut++
      const out: string[] = []
      if (shown.shown < charged.shown / 2) out.push(`shows ${shown.shown} of ${charged.shown}`)
      if (handedWork(parts) > MAX_BLOCK_WORK) out.push(`work ${handedWork(parts)}`)
      if (out.length) failures.push(`${seed}: ${JSON.stringify(text.slice(0, 60))}\n  ${out.join("\n  ")}`)
    }
    expect(failures).toEqual([])
    expect(cut).toBeGreaterThan(10)
  })

  test("a quote nested in a quote that ends on a line without `>` still shows nothing past the cut, as documented", () => {
    // marked's blockquote lexes the nested quote again with that line and loses its items: it builds one item of the
    // text's thousand. Cut anywhere in the quote, the line is gone and marked builds all of them, blocks the charge
    // never counted, so the text is cut before the quote (README, Limitations).
    const text = "> > - www.a\n> www.b\n".repeat(1000) + "the end\n"
    expect(markdownShape(text).cut).toEqual({ shown: text.length })
    expect(blockStructure(text).blocks.item).toBe(1)
    expect(blockStructure("> > - www.a\n> www.b\n".repeat(1000)).blocks.item).toBe(1000)
    expect(renderMarkdown(text, "Image").cut).toEqual({ shown: 0, reason: "work" })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// A link at the column where marked cuts a list item's lazy line [review12#R8H-2]
// ---------------------------------------------------------------------------------------------------------------------

/** Lists whose items go on to lines without their indentation that start with a short link (a footnote, `[1](…)`). */
function footnoteList(draw: (n: number) => number, size: number): string {
  const pick = <T>(values: readonly T[]) => values[draw(values.length)]!
  const words = "the scheduler retries jobs whose window overlaps a deploy cache config".split(" ")
  const sentence = (count: number) => Array.from({ length: count }, () => pick(words)).join(" ")
  const marker = pick([
    ...["10. ", "  - ", "-   ", "> 10. ", ">   - ", "  1. ", "- ", "1. "],
    ...["- 10. ", "1. - ", "> - 10. ", "10. 10. ", "- > 10. ", "  -   - "],
  ])
  const quote = marker.startsWith(">") ? pick(["> ", ""]) : ""
  let text = draw(2) ? "Notes:\n\n" : ""
  while (text.length < size) {
    text += `${marker}${sentence(2 + draw(6))}\n`
    for (let line = 0, lines = draw(3); line < lines; line++) {
      const label = draw(3) ? String(draw(10)) : pick(["ab", "abc", "x", "12"])
      text += `${quote}[${label}](https://example.com/${draw(100)}) ${sentence(1 + draw(5))}\n`
    }
    if (draw(9) === 0) text += quote ? ">\n" : "\n"
  }
  return text
}

describe("a link at the column where marked cuts a list item's lazy line keeps the item whole [review12#R8H-2]", () => {
  test("the link's address is written in angle brackets there: the text shows whole, the same links", () => {
    // marked cuts each lazy line at the item's content column and ends the item where a heading starts there. genui
    // wrote `[x](https://b.io)` as `[x](#genui-link:…)`, whose `#` is at that column when the link text is three
    // characters shorter than it (`[1](` after `10. `): marked ended the item there, the model read the text otherwise
    // than as written and cut it, at 1 to 10% of its charge, and at nothing of a loose list ("Showing the first 8 of
    // 33,593 characters", no list item).
    const item = (i: number) => `  - item ${i} [ref](https://a.io/${i})\nmore text about ${i}\n`
    const items = (from: number) => Array.from({ length: 300 }, (_, i) => item(from + i)).join("")
    const loose = `Intro.\n\n${items(0)}  - nested\n[x](https://b.io)\nafter\n${items(300)}\n  - last\n`
    const texts: Record<string, string> = {
      "a loose list": loose,
      "the same, tight": loose.replace("\n\n  - last", "\n  - last"),
      "the same, without the line before it": loose.slice("Intro.\n\n".length),
      "items of ten": "10. a step\n[1](https://example.com/1) and more\nafter\n".repeat(400),
      "quoted items of ten": "> 10. a step\n> [1](https://example.com/1) and more\n> after\n".repeat(400),
      "quoted items at column four": ">   - a step\n[1](https://example.com/1) more\nafter\n".repeat(400),
    }
    for (const [name, text] of Object.entries(texts)) {
      expect({ name, charged: markdownShape(text).cut }).toEqual({ name, charged: { shown: text.length } })
      const { cut, parts } = renderMarkdown(text, "Image")
      expect({ name, cut }).toEqual({ name, cut: { shown: text.length } })
      const handed = parts.map((part) => (part.kind === "markdown" ? part.text : "")).join("\n")
      expect({ name, bracketed: handed.includes(`](<${LINK_PREFIX}`) }).toEqual({ name, bracketed: true })
    }
    // The app's marked reads the address in angle brackets as the same link: its href is genui's, with the title, and
    // the lazy line after it stays in the item.
    const html = parser.parse(
      prepareMarkdown("10. a step\n[1](https://example.com/1) and more\nafter\n", "Image")
        .map((part) => (part.kind === "markdown" ? part.text : ""))
        .join(""),
      { async: false },
    ) as string
    expect(/<li>[^]*after[^]*<\/li>/.test(html)).toBe(true)
    const href = /<a href="([^"]*)"/.exec(html)![1]!
    expect(linkTarget(href)).toBe("https://example.com/1")
    expect(stripJoiners(/title="([^"]*)"/.exec(html)![1]!)).toBe("https://example.com/1")
  })

  test("generated lists of footnote links on lazy lines are never cut for reading otherwise", () => {
    // Before, 32 of these 40 were cut with reason `lines`, 31 of them at less than a quarter of their charge.
    const failures: string[] = []
    for (let seed = 1; seed <= 40; seed++) {
      const draw = seeded(seed * 7_727)
      const text = footnoteList(draw, 10_000 + draw(40_000))
      const charged = markdownShape(text).cut
      const { cut } = renderMarkdown(text, "Image")
      if (cut.reason === "lines" || cut.shown < charged.shown / 2)
        failures.push(`${seed}: ${JSON.stringify(cut)} of ${charged.shown}: ${JSON.stringify(text.slice(0, 60))}`)
    }
    expect(failures).toEqual([])
  })

  test("only genui's own link is written so: a model's `](#genui-link:` stays broken, other links stay as they were", () => {
    const text = [
      "10. a step\na](#genui-link:x) more\nafter",
      "See [1](https://example.com/1).",
      "10. b\n[1](https://example.com/1)\nmore",
    ].join("\n\n")
    const handed = neutralizeMarkdown(text, "Image")
    expect(handed).toContain(`a]${JOINER}(#genui-link:x) more`)
    expect(handed).toContain(`See [1](${LINK_PREFIX}`)
    expect(handed.split(`](<${LINK_PREFIX}`).length - 1).toBe(1)
    expect(handed).toContain(`10. b\n[1](<${LINK_PREFIX}`)
  })

  test("where the item ends at that column as written, genui's link there is left so, and the text reads alike", () => {
    // `![](u)xx` is as long as the item's content column (`  10.   `): as written, marked finds the fence after it there
    // and ends the item before `next`; genui's `[Image](#genui-link:)` puts its `#` there, which ends it too. Written in
    // angle brackets there, it went on to `next`, and the text was cut there for reading otherwise.
    const text = "  10.   a\n![](u)xx```\nnext\n"
    const { cut, parts } = renderMarkdown(text, "Image")
    expect(cut).toEqual({ shown: text.length })
    const handed = parts.map((part) => (part.kind === "markdown" ? part.text : "")).join("")
    expect(handed).toContain(`[Image](${LINK_PREFIX})xx\`\`\``)
  })
})
