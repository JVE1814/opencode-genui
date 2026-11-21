// Model-written Markdown made safe for the app's renderer (`ui.Markdown`), used by MarkdownText in content.tsx. Kept
// free of JSX so unit tests can run it against the app's own marked configuration (test/unit/markdown.test.ts).
//
// The app renders Markdown with marked and then decorates it. Left alone, model-written Markdown would load remote
// content as soon as it renders, with no click, and with a `$template` over state it would send what the user types
// (a password field included) to a server of the spec's choosing on every keystroke:
//
// - `![alt](url)` becomes an <img>, and raw HTML passes through;
// - every link the app renders with an http(s) address gets a favicon image from a remote service, which looks the
//   link's host up (and so sends it on): inline and reference links, autolinks, bare URLs and `www.` addresses, and
//   inline code that holds a URL;
// - the app's link renderer writes a link's href and title into the HTML without escaping them.
//
// So the renderer never gets a link, image or tag whose address the model wrote. Two steps:
//
// 1. Every construct marked (or the app after it) could turn into a link, an image or HTML is broken with an
//    invisible U+2060 WORD JOINER (`defuse`): `](`, `]:` (a reference definition), `![`, `<` before a tag name, `/`,
//    `!` or `?`, `://` and `www.`. This does not depend on parsing Markdown the way marked does: it applies to all of
//    the model's text, inside code too (where the joiner is invisible), so a construct this file misreads still
//    renders as text.
// 2. Links, images, autolinks, reference definitions and bare URLs this file does recognize are written again as
//    links to a fragment that carries the address (`#genui-link:<encoded URL>`, see `linkTarget`) with the address as
//    their title. The app renders a fragment link plainly (no favicon, no new window), and MarkdownText opens the
//    address through the surface's link policy when it is clicked. Images become such links too, with their alt text.
//    Everything genui writes this way is inert even as plain text: the encoded address holds only letters, digits,
//    `%`, `-` and `_`, and the title is defused.
//
// Top-level fenced code blocks, at any indentation, are split out and shown with `ui.Code`, so they read and copy
// exactly as written; copying a selection of the rest strips the joiners (see MarkdownText).
//
// What the renderer does with the text is bounded too (see MarkdownBudget): marked looks for the closing delimiter of
// every `*`, `_` or `~` run that could open emphasis through the rest of its paragraph, so runs that never close cost
// the square of their number (8,000 of them in 32 KB took 13 s), and KaTeX costs about 5 µs per character of math. Past
// a text's budget, emphasis delimiters are written as character references (`&#42;`), which marked shows as the
// character and never reads as a delimiter, and math is written as text. The rest of marked's work grows faster than
// the paragraph (each inline token rescans the rest of its paragraph for the app's math delimiters): past a paragraph's
// first MAX_ESCAPES backslashes, escapes are written as character references, and a text is cut where a paragraph
// runs past MAX_PARAGRAPH characters. marked's block lexer has costs of its own (setext headings, blockquotes, task
// items and tables it scans again and again, containers it lexes again at each level), and the app builds a code block
// with a toolbar for each code block and a node for each paragraph, item or cell, and for each link, emphasis or code
// span: one model of marked's blocks (see "Block structure" below) counts what the render budget charges and finds
// where a text is cut (see `markdownShape`), and neutralizing writes each line as that model reads it. Neutralizing
// lengthens lines, and marked decides some blocks by a line's length or by the characters at a column, so when a text
// renders the model reads what neutralizing wrote too, and the text is cut where it reads that otherwise, or where
// marked's block work on it passes the bound (see `renderMarkdown`): marked only ever gets text the model counted, and
// never more than the budget charged for.

import { safeUrl } from "../../protocol/url.ts"

/** U+2060 WORD JOINER: invisible, and breaks link, image and tag syntax apart for the parser. */
export const JOINER = "\u2060"

/** The href of every link genui hands the renderer starts with this, then the encoded address (see `linkTarget`). */
export const LINK_PREFIX = "#genui-link:"

/**
 * What the renderer may spend on one Markdown text, shared by its parts (see `prepareMarkdown`): `emphasis` in runs
 * scanned (an opening delimiter run costs its paragraph's openers and a 300th of its paragraph's length: see
 * emphasisCost), `math` in characters of math (and MATH_SPAN_COST per span or block).
 */
export interface MarkdownBudget {
  emphasis: number
  math: number
}

/** The emphasis budget per character of the text, and at most for one text. */
export const EMPHASIS_PER_CHAR = 8
export const MAX_EMPHASIS = 1_000_000
/** The math budget of one text (about 0.1 to 0.2 s of KaTeX), and what each span or block costs on top of its length. */
export const MAX_MATH = 20_000
export const MATH_SPAN_COST = 40

/**
 * How much of one Markdown text is shown at most: the render budget's whole text (see RENDER_UNITS), so a text the
 * budget lets render is cut only by MAX_PARAGRAPH. The rest is cut, with "…", and MarkdownText says so.
 */
export const MAX_MARKDOWN_TEXT = 500_000

/**
 * How long one paragraph (what marked lexes as one inline run: see `markdownShape`) may be; the text is cut where one
 * runs past it. marked's inline work grows faster than a paragraph: in Chromium, 500,000 characters of bare URLs in
 * one paragraph took 12 s and of `a<b ` 1.9 s, while in paragraphs of 20,000 characters they cost about 1.2 and
 * 0.4 µs a character.
 */
export const MAX_PARAGRAPH = 20_000

/**
 * The backslashes of a paragraph that stay as written; the rest are written as character references (see `inline`).
 * marked makes a token of every escape, and for each token it searches the rest of the paragraph for the app's math
 * delimiters, slowly where the paragraph is full of backslashes: 40,000 characters of `a\*` took 0.7 s in Chromium.
 */
export const MAX_ESCAPES = 100

/** A fresh budget for a text of `length` characters. */
export const markdownBudget = (length: number): MarkdownBudget => ({
  emphasis: Math.min(MAX_EMPHASIS, EMPHASIS_PER_CHAR * length),
  math: MAX_MATH,
})

/** One part of a Markdown text: prose for `ui.Markdown`, or a fenced code block for `ui.Code`. */
export type MarkdownPart =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "code"; readonly code: string; readonly language?: string }

// ---------------------------------------------------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------------------------------------------------

/** A fence that can be split out: only whitespace before it (at the top level, or indented in a list item). */
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/
/** A fence after a quote or list marker on its own line: it stays in the prose with its container. */
const NESTED_FENCE = /^[ \t]*(?:(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]*)+(`{3,}|~{3,})(.*)$/
const NESTED_CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/
/** Fences the app renders as display math (KaTeX); they stay in the Markdown. */
const MATH_FENCES = new Set(["math", "latex"])

interface Fence {
  readonly char: string
  readonly length: number
}

/** A fence's opening line as a Fence, unless its info string makes it invalid (a backtick in a backtick fence's). */
function opening(fence: string | undefined, info: string): Fence | undefined {
  if (!fence || (fence[0] === "`" && info.includes("`"))) return undefined
  return { char: fence[0]!, length: fence.length }
}

const closes = (open: Fence, match: RegExpExecArray | null) =>
  !!match && match[1]![0] === open.char && match[1]!.length >= open.length

const languageOf = (info: string) => info.trim().split(/\s+/)[0] ?? ""

/** A line without the fence's indentation (as CommonMark removes it from a fenced block's lines). */
function dedent(line: string, indent: string): string {
  let index = 0
  while (index < indent.length && index < line.length && line[index] === indent[index]) index++
  return line.slice(index)
}

/**
 * How many of a text's fenced code blocks show as code blocks of their own (`ui.Code`); later fences stay in the prose
 * around them, which the app's Markdown shows as code too. Each `ui.Code` is a component of the app's (with a Markdown
 * renderer and a highlighting round trip of its own), and a text of tiny fences built 3,900 of them in 40,000
 * characters. Each code block costs the render budget, as much as an element in the prose and more on its own (see
 * codeUnits in src/gui/costs.ts).
 */
export const MAX_CODE_PARTS = 32

/** A run of a text's lines: prose, or a fenced code block shown on its own (`code`), closing fence included. */
interface Segment {
  readonly from: number
  readonly to: number
  readonly code?: { readonly indent: string; readonly language?: string; readonly closed: boolean }
}

/**
 * Where Markdown splits into prose and fenced code blocks: a fence with only whitespace before it, at the top level or
 * indented in a list item, up to `maxCode` of them (see MAX_CODE_PARTS). Math fences, fences past `maxCode` and fences
 * that open after a quote or list marker stay in the prose, up to and including their closing fence. An unclosed block
 * runs to the end.
 */
function fenceSegments(lines: readonly string[], maxCode = MAX_CODE_PARTS): Segment[] {
  const segments: Segment[] = []
  let codeParts = 0
  let proseFrom = 0
  let open: (Fence & { from: number; indent: string; language?: string }) | undefined
  /** A fence kept in the prose (math, quoted, after a list marker), up to and including its closing fence. */
  let kept: Fence | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (open) {
      if (closes(open, FENCE_CLOSE.exec(line))) {
        const { indent, language } = open
        segments.push({
          from: open.from,
          to: index + 1,
          code: { indent, ...(language ? { language } : {}), closed: true },
        })
        open = undefined
        proseFrom = index + 1
      }
      continue
    }
    if (kept) {
      if (closes(kept, NESTED_CLOSE.exec(line))) kept = undefined
      continue
    }
    const nested = NESTED_FENCE.exec(line)
    const start = nested ? null : FENCE.exec(line)
    const fence = nested ? opening(nested[1], nested[2]!) : opening(start?.[2], start?.[3] ?? "")
    if (fence && start && codeParts < maxCode && !MATH_FENCES.has(languageOf(start[3]!).toLowerCase())) {
      codeParts++
      if (index > proseFrom) segments.push({ from: proseFrom, to: index })
      const language = languageOf(start[3]!)
      open = { ...fence, from: index, indent: start[1]!, ...(language ? { language } : {}) }
      continue
    }
    if (fence) kept = fence
  }
  if (open) {
    const { indent, language } = open
    segments.push({
      from: open.from,
      to: lines.length,
      code: { indent, ...(language ? { language } : {}), closed: false },
    })
  } else if (lines.length > proseFrom) segments.push({ from: proseFrom, to: lines.length })
  return segments
}

/**
 * Splits Markdown into prose and fenced code blocks (see `fenceSegments`); a code block's lines lose its fence's
 * indentation.
 */
export function splitMarkdown(text: string, maxCode = MAX_CODE_PARTS): MarkdownPart[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  const parts: MarkdownPart[] = []
  for (const segment of fenceSegments(lines, maxCode)) {
    if (segment.code) parts.push(codePart(lines, segment.from, segment.to, segment.code))
    else {
      const joined = lines.slice(segment.from, segment.to).join("\n")
      if (joined.trim() !== "") parts.push({ kind: "markdown", text: joined })
    }
  }
  return parts
}

/** A fenced code block's part: its lines between the fences, without the fence's indentation. */
function codePart(
  lines: readonly string[],
  from: number,
  to: number,
  code: NonNullable<Segment["code"]>,
): MarkdownPart {
  const { indent, language, closed } = code
  const body = lines.slice(from + 1, closed ? to - 1 : to).map((line) => dedent(line, indent))
  return { kind: "code", code: body.join("\n"), ...(language ? { language } : {}) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Block structure: what marked makes of a text
// ---------------------------------------------------------------------------------------------------------------------
//
// One model of marked's block lexer (marked 18.0.11, gfm, with the app's display-math extension) that counting,
// cutting and neutralizing all use. It follows marked's own algorithm line by line, quirks included: a blockquote's
// segments and its lazy lines, list items by their content column (with tabs as marked expands them) and lazy
// continuation, items lexed with `text` tokens (a setext attempt per line) until a nested list resets that, setext
// headings that run over thematic breaks, indented code only where it cannot continue a paragraph or text, fences and
// display math in any container, tables, definitions (where genui writes them again), and HTML as genui leaves it
// (every tag broken; see the `<…>` lines in neutralizeLines). test/unit/review8-markdown.test.ts checks it against the
// app's marked on generated documents.
//
// It is linear in the text: where marked scans ahead (the setext rule, display math, a table's rows, a blockquote
// that a code block ends early, a definition's label), the model looks the answer up in arrays computed once per
// level, and tallies what marked scans instead (see MAX_BLOCK_WORK); containers nest at most MAX_NESTING deep.

/** How deep lists and blockquotes nest at most (marked lexes each level's text again); deeper, the text is cut. */
export const MAX_NESTING = 8

/**
 * How many blocks (paragraphs, headings, rules, blockquotes, list items and table cells) and inline elements (links,
 * emphasis, code spans, line breaks: see `inlineSpans`) one Markdown text shows at most beyond one per CHARS_PER_BLOCK
 * characters, as many as a Table shows cells (MAX_TABLE_CELLS in src/gui/costs.ts): each costs about what a cell does,
 * and a text of tiny ones built 47,000 table cells, 24,000 list items, or 80,000 links or emphases (1.5 to 2 s in the
 * playground), in one task. The rest is cut.
 */
export const MAX_MARKDOWN_BLOCKS = 10_000

/**
 * The characters of text that pay for one block or inline element: one costs a tenth of an element in the render
 * budget, as a Table cell does, and so do this many characters (TEXT_PER_UNIT / CELLS_PER_UNIT). An ordinary text's
 * blocks and links are further apart, so only texts of tiny ones pay for them (see markdownUnits in src/gui/costs.ts).
 */
export const CHARS_PER_BLOCK = 25

/**
 * What marked's block lexer may scan beyond what it consumes, in characters scanned or their worth (1 to 3.9 ns each in
 * Chromium, on text with a character outside Latin-1, where marked's regexes run slowest: so at most about 0.1 to
 * 0.15 s of marked's work; test/e2e/review8-markdown.spec.ts measures it, and test/unit/review8-markdown.test.ts holds
 * the weights to marked's measured costs), on the text as marked gets it, neutralized (see `checkedParts`). Its
 * setext rule scans from every paragraph start (from every line of a list item) to the next line that stops it, so
 * paragraphs between thematic breaks, or a list item's short lines, cost the square of their run: 100 KB of `a\n***\n`
 * took 3.4 s. So do a blockquote's lazy lines and one that a code block ends early, a table header with the wrong
 * number of columns, task items, unclosed display math and definition labels. Past it, the text is cut.
 */
export const MAX_BLOCK_WORK = 40_000_000

// What marked's blockquote does again for each segment (its quoted lines up to a lazy line) with the rest of the
// quote, in units of MAX_BLOCK_WORK (measured in Chromium): it copies the array of the rest's lines, and after a list
// it joins the rest to the list's raw, lexes the list again and splits the rest into lines again (a copy and a scan of
// each character, and an array entry per line). A quoted list with a lazy line per item costs marked 175 ms at 100 KB
// with sentences for lines, on text with a character outside Latin-1 (60 ms without), and 3.6 s with lines of a few
// characters. (Weighed at half a unit a character, as marked spends on Latin-1 text alone, such lists took it 4.3 to
// 5.4 ns a unit [review10#R8D-1].)
const QUOTE_COPY_LINE = 0.5
const QUOTE_RELIST_CHAR = 1
const QUOTE_RELIST_LINE = 15
/**
 * A table header marked tries for each line of a paragraph, when the delimiter row has another number of columns: it
 * matches the rows after it (a few lookaheads per line), and splits them into an array of lines, per character and per
 * line.
 */
const TABLE_RETRY = 2
const TABLE_RETRY_LINE = 16

// What marked's setext rule does on each line it reads past (see `setextLineCost`): its lazy match tries the underline,
// and eight other rules' starts, at every line. Each of those backs up over up to three leading spaces, and the table
// rule's over a run of `|`, `:`, `-` and spaces at the line's start, character by character, and again from each of
// the `|` in it, for each number of the leading spaces it may take. Measured in Chromium on text with a character
// outside Latin-1 (any text genui neutralizes), where its regexes run slowest: 100 KB of `a\n***\n` took 6 ns a unit
// counted by characters alone, of `   a\n***\n` 14 and of `|-|-…|x\n***\n` 12; weighed by the run alone, the run's
// `|` after three spaces took 5 to 6 ns a unit (`   | | | | | | | |x` [review10#R8D-1]).
const SETEXT_LINE = 4
const SETEXT_SPACE = 10
const SETEXT_RUN = 3
const SETEXT_PIPE = 3
const SETEXT_PIPE_SPACE = 4.5

/**
 * What marked's setext rule costs on a line it reads past, beyond its characters: a line's own cost, and its leading
 * spaces and its run of table-rule characters (and the `|` in the run, for each leading space) as some level of marked
 * sees them (after the quote markers, list markers and indentation the row may start with, any of which a level may
 * take away).
 */
function setextLineCost(row: string): number {
  let index = 0
  let spaces = 0
  for (;;) {
    const c = row.charCodeAt(index)
    if (c === 32 || c === 9) spaces++
    else if (c === 62) spaces = 0
    else break
    index++
  }
  let run = 0
  let pipes = 0
  for (let at = index; at < row.length; at++) {
    const c = row.charCodeAt(at)
    if (c === 124) pipes++
    else if (c !== 58 && c !== 45 && c !== 32) break
    run++
  }
  const leading = Math.min(3, spaces)
  return SETEXT_LINE + SETEXT_SPACE * leading + SETEXT_RUN * run + pipes * (SETEXT_PIPE + SETEXT_PIPE_SPACE * leading)
}

interface Line {
  /** The line as this level of marked sees it. */
  readonly t: string
  /** The row of the text it comes from. */
  readonly r: number
}

/** An inline run: what marked hands its inline lexer (a paragraph, a list item's text, a heading, a table cell). */
interface Run {
  len: number
  /** The row it starts at. */
  readonly row: number
  /** Its first line, for the task-list pass. */
  head: string
  off: number
  /**
   * Where it passes MAX_PARAGRAPH: the row, how many characters of that row's line (as marked sees it) fit, and
   * whether that line is the row as written (else tabs may have widened, and a prefix gone).
   */
  over: { row: number; allowance: number; exact: boolean } | undefined
}

const PROSE = 0
const CODE = 1
const MATH = 2
const DEF = 3

/** What a run of the model finds, by row of the text. */
class Sink {
  readonly runs: Run[] = []
  /** The rows of the lines added to a run after its first, in order. */
  readonly appended: number[] = []
  /** marked's inline runs so far, the table cells it pads a row with (empty, so not in `runs`) included. */
  runCount = 0
  readonly codeRows: number[] = []
  readonly mathRows: number[] = []
  /** Blocks, by row: how many at that row (a table row's cells), and of what type. */
  readonly blockRows: number[] = []
  readonly blockCounts: number[] = []
  readonly blockTypes: string[] = []
  /**
   * marked's work (see MAX_BLOCK_WORK) by row: at the row (`work`), and of scans, the weight per character that starts
   * reading at a row (`opens`) and stops before it (`closes`), the same per line (`lineOpens`, `lineCloses`), and how
   * many setext scans do (`setextOpens`, `setextCloses`: each line costs those `setextLineCost`).
   */
  readonly work: Float64Array
  readonly opens: Float64Array
  readonly closes: Float64Array
  readonly lineOpens: Float64Array
  readonly lineCloses: Float64Array
  readonly setextOpens: Float64Array
  readonly setextCloses: Float64Array
  readonly nestRows: number[] = []
  /** The rows of setext headings after their first: inline text too, though not `appended` to the heading's run. */
  readonly headingRows: number[] = []
  /** Rows of setext headings and display math, as [first, last] pairs: a cut inside one moves to its first row. */
  readonly spans: number[] = []
  /** The labels of the definitions lexed so far: marked keeps the first and drops (but consumes) the rest. */
  readonly links = new Set<string>()
  /**
   * The runs whose text starts with a task marker, in order, as pairs (place among marked's runs, index in `runs`):
   * marked's task pass takes the last one.
   */
  readonly tasks: number[] = []
  /** The definitions genui writes again: each one's text as marked reads it, by row. */
  readonly definitions = new Map<number, string>()
  /** What the model did, to stop it on text built to make it slow (see `modelLimit`). */
  model = 0

  readonly rows: readonly string[]
  /** What each row is, for neutralizeLines, and the rows that start a code or math block. */
  readonly kinds: Uint8Array | undefined
  readonly starts: Uint8Array | undefined

  constructor(rows: readonly string[], kinds?: Uint8Array, starts?: Uint8Array) {
    this.rows = rows
    this.kinds = kinds
    this.starts = starts
    this.work = new Float64Array(rows.length + 1)
    this.opens = new Float64Array(rows.length + 1)
    this.closes = new Float64Array(rows.length + 1)
    this.lineOpens = new Float64Array(rows.length + 1)
    this.lineCloses = new Float64Array(rows.length + 1)
    this.setextOpens = new Float64Array(rows.length + 1)
    this.setextCloses = new Float64Array(rows.length + 1)
  }

  /** A new part of the text: marked lexes each part (see `splitMarkdown`) on its own. */
  beginSegment() {
    this.links.clear()
    this.tasks.length = 0
  }
  /** Work of marked's at a row. */
  worked(row: number, amount: number) {
    this.work[row] = this.work[row]! + amount
  }
  /**
   * A scan of marked's from row `from` up to (not including) row `to`, of `weight` per character and `perLine` per
   * line, and for the setext rule's (`setext`), each line's `setextLineCost`.
   */
  scan(from: number, to: number, weight: number, perLine = 0, setext = false) {
    if (to <= from) return
    const end = Math.min(to, this.rows.length)
    this.opens[from] = this.opens[from]! + weight
    this.closes[end] = this.closes[end]! + weight
    this.lineOpens[from] = this.lineOpens[from]! + perLine
    this.lineCloses[end] = this.lineCloses[end]! + perLine
    if (!setext) return
    this.setextOpens[from] = this.setextOpens[from]! + 1
    this.setextCloses[end] = this.setextCloses[end]! + 1
  }
  block(row: number, type: string, count = 1) {
    this.blockRows.push(row)
    this.blockCounts.push(count)
    this.blockTypes.push(type)
  }
  kind(row: number, kind: number, start = false) {
    // A row lexed as a definition once is written again as one (marked may lex it again, as part of other text).
    if (!this.kinds || row < 0 || row >= this.kinds.length) return
    if (this.kinds[row] !== DEF) this.kinds[row] = kind
    if (start) this.starts![row] = 1
  }
  /** Whether genui can write the definition on a row again: its text, as marked reads it, ends the row. */
  writable(row: number, text: string): boolean {
    return this.rows[row]?.endsWith(text) ?? false
  }
  definition(row: number, text: string) {
    if (!this.definitions.has(row)) this.definitions.set(row, text)
    this.kind(row, DEF)
  }
  mark() {
    return { code: this.codeRows.length, math: this.mathRows.length, blocks: this.blockRows.length }
  }
  /** Drops what a token marked replaces found (its runs stay: marked lexes them inline all the same). */
  rollback(mark: { code: number; math: number; blocks: number }) {
    this.codeRows.length = mark.code
    this.mathRows.length = mark.math
    this.blockRows.length = mark.blocks
    this.blockCounts.length = mark.blocks
    this.blockTypes.length = mark.blocks
  }
  run(text: string, row: number): Run {
    const run: Run = { len: text.length, row, head: text, off: 0, over: undefined }
    if (text.charCodeAt(0) === 91 && TASK.test(text)) this.tasks.push(this.runCount, this.runs.length)
    this.runs.push(run)
    this.runCount++
    if (run.len > MAX_PARAGRAPH) run.over = { row, allowance: MAX_PARAGRAPH, exact: this.rows[row] === text }
    return run
  }
  append(run: Run, text: string, row: number) {
    this.appended.push(row)
    if (!run.over && run.len + 1 + text.length > MAX_PARAGRAPH)
      run.over = { row, allowance: Math.max(0, MAX_PARAGRAPH - run.len - 1), exact: this.rows[row] === text }
    run.len += 1 + text.length
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-line patterns (each on one line, without its newline). `$` is the end of the line: marked's `\n` or end.
// ---------------------------------------------------------------------------------------------------------------------

const BLANK = /^[ \t]*$/
const WS = /^\s*$/
const CODE_LINE = /^(?: {4}| {0,3}\t)[\s\S]/
const CODE_START = /^(?: {4}| {0,3}\t)/
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})([\s\S]*)$/
const FENCE_INT = /^ {0,3}(?:`{3,}(?=[^`]*$)|~~~)/
const FENCE_ANY = /^ {0,3}(?:`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/
const HEADING_INT = /^ {0,3}#{1,6}(?:\s|$)/
const HR = /^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/
const BQ = /^ {0,3}>/
// marked strips quote markers and code indentation with multiline patterns, whose `^` also matches after U+2028/9.
const BQ_STRIP = /(^|[\u2028\u2029]) {0,3}>[ \t]?/g
const BQ_CONTENT = /^ {0,3}> ?/
const LIST_START = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))(?:[ \t][\s\S]*)?$/
const BQ_LIST = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/
const PARA_LIST = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/
const ROWS_LIST = /^ {0,3}(?:[*+-]|1[.)])[ \t]/
const BULL_SP = /^ {0,3}(?:[*+-]|\d{1,9}[.)]) /
const UNDERLINE = /^ {0,3}(?:=+|-+) *$/
const SETEXT = /^ {0,3}((?:=+|-+) *)$/
const TABLE_STOP = /^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/
const HEADER = /^ *([^ ].*)$/
const DELIM = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/
const SEP = /[\u2028\u2029]/
const TASK = /^\[[ xX]\] +\S/
const TASK_MARK = /^\[[ xX]\] +/
const KATEX = /^\${1,2}$/
const CODE_INDENT = /(^|[\u2028\u2029])(?: {1,4}| {0,3}\t)/g

// Fast checks before the patterns: most begin with up to three spaces and one of a few characters.
function leadSpaces(text: string): number {
  let index = 0
  while (text.charCodeAt(index) === 32) index++
  return index
}
/** The character after up to three leading spaces (-1 past them). */
function head(text: string): number {
  const spaces = leadSpaces(text)
  return spaces <= 3 ? text.charCodeAt(spaces) : -1
}
const isBullet = (c: number) => c === 42 || c === 43 || c === 45 || (c >= 48 && c <= 57)
const isHr = (text: string, c = head(text)) => (c === 45 || c === 95 || c === 42) && HR.test(text)
const isHeadingStart = (text: string, c = head(text)) => c === 35 && HEADING_INT.test(text)
const isQuote = (text: string, c = head(text)) => c === 62
const isFenceStart = (text: string, c = head(text)) => (c === 96 || c === 126) && FENCE_INT.test(text)
const isFenceAny = (text: string, c = head(text)) => (c === 96 || c === 126) && FENCE_ANY.test(text)
const isCodeStart = (text: string) => {
  const spaces = leadSpaces(text)
  return spaces >= 4 || (spaces <= 3 && text.charCodeAt(spaces) === 9)
}
const isCodeLine = (text: string) => isCodeStart(text) && CODE_LINE.test(text)
const isBlank = (text: string) => {
  for (let index = 0; index < text.length; index++) {
    const c = text.charCodeAt(index)
    if (c !== 32 && c !== 9) return false
  }
  return true
}
const isWhitespace = (text: string) => {
  const c = text.charCodeAt(leadSpaces(text))
  if (c > 32 && c < 127) return false
  return WS.test(text)
}
const isTableStop = (text: string, c = head(text)) => (c === 124 || c === 58 || c === 45) && TABLE_STOP.test(text)
const isDelimiter = (text: string, c = head(text)) => (c === 124 || c === 58 || c === 45) && DELIM.test(text)
const isUnderline = (text: string, c = head(text)) => (c === 61 || c === 45) && UNDERLINE.test(text)

function expandTabs(line: string, indent: number): string {
  let col = indent
  let out = ""
  for (const char of line) {
    if (char === "\t") {
      const added = 4 - (col % 4)
      out += " ".repeat(added)
      col += added
    } else {
      out += char
      col++
    }
  }
  return out
}

/** marked's `search(/[^ ]/)`: where the first character other than a space is, or -1. */
const firstNonSpace = (text: string) => {
  const spaces = leadSpaces(text)
  return spaces < text.length ? spaces : -1
}

/** marked's splitCells, as far as the cells' number and texts go. */
function splitCells(row: string, count?: number): string[] {
  let out = ""
  for (let index = 0; index < row.length; index++) {
    const char = row[index]!
    if (char === "|") {
      let escaped = false
      for (let at = index - 1; at >= 0 && row[at] === "\\"; at--) escaped = !escaped
      out += escaped ? "|" : " |"
    } else out += char
  }
  const cells = out.split(/ \|/)
  if (!cells[0]!.trim()) cells.shift()
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop()
  if (count) {
    if (cells.length > count) cells.splice(count)
    else while (cells.length < count) cells.push("")
  }
  return cells.map((cell) => cell.trim().replace(/\\\|/g, "|"))
}

function trailingBackslashesOdd(text: string): boolean {
  let count = 0
  for (let index = text.length - 1; index >= 0 && text[index] === "\\"; index--) count++
  return (count & 1) === 1
}

// ---------------------------------------------------------------------------------------------------------------------
// A level: the lines one call of marked's blockTokens lexes.
// ---------------------------------------------------------------------------------------------------------------------

class Level {
  private ovIndex = -1
  private ovLine: Line | undefined
  private lh: Int32Array | undefined
  private lhOk: Uint8Array | undefined
  private qPara: Int32Array | undefined
  private qNoPara: Int32Array | undefined
  private kat1: Int32Array | undefined
  private kat2: Int32Array | undefined
  private rows: Int32Array | undefined
  private sums: Float64Array | undefined
  private readonly at: (index: number) => Line
  readonly n: number
  readonly last: number

  constructor(at: (index: number) => Line, n: number) {
    this.at = at
    this.n = n
    this.last = n - 1
  }

  static of(lines: readonly Line[]): Level {
    return new Level((index) => lines[index]!, lines.length)
  }

  get(index: number): Line {
    return index === this.ovIndex ? this.ovLine! : this.at(index)
  }
  text(index: number): string {
    return this.get(index).t
  }
  override(index: number, line: Line) {
    this.ovIndex = index
    this.ovLine = line
  }
  /** Whether the source from line `p` (after an unconsumed line break when `nl`) is not empty. */
  has(p: number, nl: boolean): boolean {
    if (nl) return p <= this.last
    return p < this.last || (p === this.last && this.text(p) !== "")
  }
  followed(index: number) {
    return index < this.last
  }
  /** The row after line `index`'s (where a scan through that line ends). */
  rowAfter(index: number): number {
    return index < 0 ? 0 : this.get(Math.min(index, this.last)).r + 1
  }

  /** The setext rule from line p: the underline's index, or -1 (and where the scan stopped, in `scan`). */
  setext(p: number, scan: { to: number }): number {
    const text = this.text(p)
    scan.to = p
    if (p >= this.last || SEP.test(text)) return -1
    if (!this.lh) this.computeSetext()
    const c = head(text)
    if (
      (isBullet(c) && BULL_SP.test(text)) ||
      isCodeStart(text) ||
      isFenceAny(text, c) ||
      isQuote(text, c) ||
      isHeadingStart(text, c) ||
      (this.followed(p) && isTableStop(text, c))
    )
      return -1
    if (p >= this.last) return -1
    const event = this.lh![p + 1]!
    scan.to = event
    if (event > this.last) return -1
    return this.lhOk![event] ? event : -1
  }

  private computeSetext() {
    const lh = new Int32Array(this.n + 1)
    const ok = new Uint8Array(this.n + 1)
    lh[this.n] = this.n
    for (let j = this.n - 1; j >= 0; j--) {
      const text = this.at(j).t
      const followed = j < this.last
      const c = head(text)
      if (isUnderline(text, c)) {
        lh[j] = j
        ok[j] = 1
      } else if (
        !followed ||
        isWhitespace(text) ||
        (isBullet(c) && BULL_SP.test(text)) ||
        isCodeStart(text) ||
        isFenceAny(text, c) ||
        isQuote(text, c) ||
        isHeadingStart(text, c) ||
        isTableStop(text, c) ||
        SEP.test(text)
      )
        lh[j] = j
      else lh[j] = lh[j + 1]!
    }
    this.lh = lh
    this.lhOk = ok
  }

  /** Where the blockquote regex's match from quote line p ends (exclusive). */
  quoteEnd(p: number): number {
    if (!this.qPara) this.computeQuote()
    const content = this.text(p).replace(BQ_CONTENT, "")
    return content !== "" ? this.qPara![p + 1]! : this.qNoPara![p + 1]!
  }

  private lazyOk(index: number): boolean {
    const text = this.at(index).t
    if (text === "") return false
    const c = head(text)
    if (
      isHr(text, c) ||
      isHeadingStart(text, c) ||
      isQuote(text, c) ||
      isFenceStart(text, c) ||
      (isBullet(c) && BQ_LIST.test(text))
    )
      return false
    return !(index < this.last && isBlank(text))
  }

  private computeQuote() {
    const para = new Int32Array(this.n + 2)
    const noPara = new Int32Array(this.n + 2)
    const quoteEndAt = new Int32Array(this.n + 2)
    para[this.n] = noPara[this.n] = this.n
    para[this.n + 1] = noPara[this.n + 1] = this.n
    for (let j = this.n - 1; j >= 0; j--) {
      const text = this.at(j).t
      if (isQuote(text)) {
        const content = text.replace(BQ_CONTENT, "")
        quoteEndAt[j] = content !== "" ? para[j + 1]! : noPara[j + 1]!
        para[j] = noPara[j] = quoteEndAt[j]!
      } else {
        noPara[j] = j
        para[j] = this.lazyOk(j) ? para[j + 1]! : j
      }
    }
    this.qPara = para
    this.qNoPara = noPara
  }

  /** The closing line of a blockKatex block opened at p, or -1. */
  katex(p: number): number {
    const text = this.text(p)
    if (!KATEX.test(text) || !this.followed(p)) return -1
    if (!this.kat1) this.computeKatex()
    const next = text.length === 1 ? this.kat1! : this.kat2!
    let close = next[Math.min(p + 2, this.n)]!
    if (close === p + 2 && this.text(p + 1) === "") close = next[Math.min(p + 3, this.n)]!
    return close < this.n ? close : -1
  }

  private computeKatex() {
    const one = new Int32Array(this.n + 1)
    const two = new Int32Array(this.n + 1)
    one[this.n] = two[this.n] = this.n
    for (let j = this.n - 1; j >= 0; j--) {
      const text = this.at(j).t
      const valid = j > 0 && !trailingBackslashesOdd(this.at(j - 1).t)
      one[j] = valid && text === "$" ? j : one[j + 1]!
      two[j] = valid && text === "$$" ? j : two[j + 1]!
    }
    this.kat1 = one
    this.kat2 = two
  }

  /** Where a table's rows from line p end (exclusive). */
  rowsEnd(p: number): number {
    if (!this.rows) {
      const rows = new Int32Array(this.n + 1)
      rows[this.n] = this.n
      for (let j = this.n - 1; j >= 0; j--) {
        const text = this.at(j).t
        const c = head(text)
        const stop =
          (j < this.last && leadSpaces(text) === text.length) ||
          (j === this.last && text === "") ||
          isHr(text, c) ||
          isHeadingStart(text, c) ||
          isQuote(text, c) ||
          isCodeLine(text) ||
          isFenceStart(text, c) ||
          (isBullet(c) && ROWS_LIST.test(text)) ||
          SEP.test(text)
        rows[j] = stop ? j : rows[j + 1]!
      }
      this.rows = rows
    }
    return p >= this.n ? this.n : this.rows[p]!
  }

  /** Whether marked's paragraph (gfm, at the top) continues with line q. */
  paragraphContinues(q: number): boolean {
    const text = this.text(q)
    if (text === "") return false
    const c = head(text)
    if (
      isHr(text, c) ||
      isHeadingStart(text, c) ||
      isQuote(text, c) ||
      isFenceStart(text, c) ||
      ((c === 42 || c === 43 || c === 45 || c === 49) && PARA_LIST.test(text))
    )
      return false
    if (q < this.last && isBlank(text)) return false
    return !this.tableAt(q)
  }

  tableAt(q: number): boolean {
    return q < this.last && isDelimiter(this.text(q + 1)) && HEADER.test(this.text(q))
  }

  /** The characters of lines [from, to), each with its line break. */
  chars(from: number, to: number): number {
    const end = Math.min(to, this.n)
    if (end <= from) return 0
    if (!this.sums) {
      const sums = new Float64Array(this.n + 1)
      for (let index = 0; index < this.n; index++) sums[index + 1] = sums[index]! + this.at(index).t.length + 1
      this.sums = sums
    }
    let total = this.sums[end]! - this.sums[from]!
    if (this.ovIndex >= from && this.ovIndex < end) total += this.ovLine!.t.length - this.at(this.ovIndex).t.length
    return total
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------------------------------

interface Tok {
  type: string
  run?: Run
  row?: number
  newlines?: number
  /** A blockquote's raw, as marked builds it (in pieces), and the row of each of its lines (as far as they are known). */
  raw?: Rope
  rawRows?: number[]
  /** A list's raw lines, and the line breaks the lexer added to its raw (a 1-character space after it). */
  rawLines?: Line[]
  rawNl?: number
  mark?: { code: number; math: number; blocks: number }
}

interface ListResult {
  tok: Tok
  /** The list's raw length, which the lexer skips. */
  rawLength: number
}

/** Thrown when the model has done more than `modelLimit` allows. */
class Abort extends Error {}

const itemRegexes = new Map<string, RegExp>()
interface ItemPatterns {
  readonly fences: RegExp
  readonly heading: RegExp
  readonly quote: RegExp
  readonly bullet: RegExp
  readonly hr: RegExp
}
/** marked's regexes for the lines after a list item's first, by the item's indentation (clamped to 0-3, as marked). */
const itemPatterns: ItemPatterns[] = [0, 1, 2, 3].map((k) => ({
  fences: new RegExp(`^ {0,${k}}(?:\`\`\`|~~~)`),
  heading: new RegExp(`^ {0,${k}}#`),
  quote: new RegExp(`^ {0,${k}}>`),
  bullet: new RegExp(`^ {0,${k}}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)`),
  hr: new RegExp(`^ {0,${k}}(?:(?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})$`),
}))

class BlockLexer {
  top = true
  /** The row of the top-level token being lexed (where the text is cut if the model stops). */
  topRow = 0
  readonly sink: Sink
  readonly modelLimit: number

  constructor(sink: Sink, modelLimit = Infinity) {
    this.sink = sink
    this.modelLimit = modelLimit
  }

  private count(amount: number) {
    this.sink.model += amount
    if (this.sink.model > this.modelLimit) throw new Abort()
  }

  lex(lines: readonly Line[]): Tok[] {
    this.top = true
    return this.blockTokens(Level.of(lines), [], false, 0)
  }

  blockTokens(level: Level, tokens: Tok[], clippedStart: boolean, depth: number): Tok[] {
    const sink = this.sink
    let clipped = clippedStart
    let p = 0
    let nl = false
    this.count(level.n)
    while (level.has(p, nl)) {
      // A line break the last token left: the space rule takes it with the blank lines after it.
      if (nl) {
        let q = p
        let rawLength = 1
        let newlines = 1
        while (q <= level.last && isBlank(level.text(q)) && !(q === level.last && level.text(q) === "")) {
          rawLength += level.text(q).length + (q < level.last ? 1 : 0)
          if (q < level.last) newlines++
          q++
        }
        this.space(tokens, rawLength, newlines)
        p = q
        nl = false
        continue
      }
      const line = level.get(p)
      const text = line.t
      const c = head(text)
      if (depth === 0) this.topRow = line.r

      // blockKatex
      const katex = text.charCodeAt(0) === 36 ? level.katex(p) : -1
      if (katex >= 0) {
        sink.block(line.r, "math")
        sink.mathRows.push(line.r)
        for (let index = p; index <= katex; index++) sink.kind(level.get(index).r, MATH, index === p)
        sink.spans.push(line.r, level.get(katex).r)
        tokens.push({ type: "math" })
        p = katex + 1
        nl = false
        continue
      }
      if (text.charCodeAt(0) === 36 && KATEX.test(text) && level.followed(p))
        sink.scan(line.r, level.rowAfter(level.last), 1)

      // space
      if (isBlank(text)) {
        let q = p
        let rawLength = 0
        let newlines = 0
        while (q <= level.last && isBlank(level.text(q)) && !(q === level.last && level.text(q) === "" && q > p)) {
          rawLength += level.text(q).length + (q < level.last ? 1 : 0)
          if (q < level.last) newlines++
          q++
        }
        this.space(tokens, rawLength, newlines)
        p = q
        nl = false
        continue
      }

      // code
      if (isCodeLine(text)) {
        let q = p + 1
        let lastCode = p
        while (q <= level.last) {
          const next = level.text(q)
          // A line of spaces and tabs is a blank line between or after code lines (the regex tries that first).
          if (!isBlank(next)) {
            if (!isCodeLine(next)) break
            lastCode = q
          }
          q++
        }
        // The regex takes the blank lines after the last code line; trimTrailingBlankLines gives them back (and the
        // line break after the code) unless at most one line's worth follows it.
        let m = lastCode + 1
        while (m <= level.last && isBlank(level.text(m))) m++
        const after = m - lastCode - 1 + (m <= level.last ? 1 : 0)
        const keep = after <= 1
        const last = tokens.at(-1)
        if (last?.type === "paragraph" || last?.type === "text") {
          for (let index = p; index <= lastCode; index++) {
            const l = level.get(index)
            sink.append(last.run!, l.t.replace(CODE_INDENT, "$1"), l.r)
          }
          if (keep && after === 1) {
            const tail = m <= level.last ? "" : level.text(m - 1).replace(CODE_INDENT, "$1")
            sink.append(last.run!, tail, level.get(lastCode).r)
          }
        } else {
          sink.codeRows.push(line.r)
          for (let index = p; index <= lastCode; index++) sink.kind(level.get(index).r, CODE, index === p)
          tokens.push({ type: "code" })
        }
        if (keep) {
          if (m <= level.last) {
            p = lastCode + 1
            nl = false
          } else {
            p = level.n
            nl = false
          }
        } else {
          p = lastCode + 1
          nl = true
        }
        continue
      }

      // fences
      const fence = c === 96 || c === 126 ? FENCE_OPEN.exec(text) : null
      if (fence) {
        const marker = fence[1]!
        let close = -1
        for (let q = p + 1; q <= level.last; q++) {
          const candidate = level.text(q)
          const lead = /^ {0,3}/.exec(candidate)![0].length
          if (candidate.startsWith(marker, lead) && /^[~`]* *$/.test(candidate.slice(lead + marker.length))) {
            close = q
            break
          }
        }
        const end = close >= 0 ? close : level.last
        const info = fence[2]!.trim()
        const math = /^(?:math|latex)$/i.test(info.split(/\s+/)[0] ?? "")
        sink.codeRows.push(line.r)
        for (let index = p; index <= end; index++) sink.kind(level.get(index).r, math ? MATH : CODE, index === p)
        tokens.push({ type: "code" })
        p = end + 1
        nl = p <= level.last
        if (close < 0) {
          p = level.n
          nl = false
        }
        continue
      }

      // heading
      const heading = c === 35 ? HEADING.exec(text) : null
      if (heading) {
        let content = heading[2]!.trim()
        if (/#$/.test(content)) {
          const trimmed = content.replace(/#+$/, "")
          if (!trimmed || / $/.test(trimmed)) content = trimmed.trim()
        }
        sink.block(line.r, "heading")
        tokens.push({ type: "heading", run: sink.run(content, line.r) })
        p++
        nl = p <= level.last
        continue
      }

      // hr
      if (isHr(text, c)) {
        sink.block(line.r, "hr")
        tokens.push({ type: "hr" })
        p++
        nl = p <= level.last
        continue
      }

      // blockquote
      if (c === 62) {
        const result = this.blockquote(level, p, depth)
        tokens.push(result.tok)
        ;[p, nl] = this.advance(level, p, result.rawLength)
        continue
      }

      // list
      if (isBullet(c) && LIST_START.test(text)) {
        const result = this.list(level, p, depth)
        if (result) {
          tokens.push(result.tok)
          ;[p, nl] = this.advance(level, p, result.rawLength)
          continue
        }
      }

      // def (only where genui writes a definition again: the line is one, and it starts a block)
      const last = tokens.at(-1)
      if (c === 91) {
        const definition = DEFINITION.exec(text)
        if (
          definition &&
          /\S/.test(definition[2]!) &&
          last?.type !== "paragraph" &&
          last?.type !== "text" &&
          sink.writable(line.r, text)
        ) {
          sink.definition(line.r, text)
          const tag = definition[2]!.toLowerCase().replace(/\s+/g, " ")
          if (!sink.links.has(tag)) {
            sink.links.add(tag)
            tokens.push({ type: "def" })
          }
          p++
          nl = p <= level.last
          continue
        }
        sink.worked(line.r, this.labelScan(level, p))
      }

      // table
      if (level.tableAt(p)) {
        const header = HEADER.exec(text)![1]!
        const delimiter = DELIM.exec(level.text(p + 1))![1]!
        const end = level.rowsEnd(p + 2)
        const headers = splitCells(header)
        const aligns = delimiter.replace(/^\||\| *$/g, "").split("|")
        if (/[:|]/.test(delimiter) && headers.length === aligns.length) {
          for (const cell of headers) sink.run(cell, line.r)
          sink.block(line.r, "cell", headers.length)
          // Rows: marked drops a last row of only spaces and tabs at the end of the source.
          let rowEnd = end
          if (rowEnd > p + 2 && rowEnd - 1 === level.last && /^[ \t]*$/.test(level.text(rowEnd - 1))) rowEnd--
          let any = false
          for (let index = p + 2; index < rowEnd; index++) if (level.text(index).trim()) any = true
          if (any) {
            for (let index = p + 2; index < rowEnd; index++) {
              // marked pads a row to the header's width with empty cells: counted, not built (a header of 1,000
              // columns over 30,000 short rows would be 30 million of them).
              const rowLine = level.get(index)
              const cells = splitCells(rowLine.t)
              const real = Math.min(cells.length, headers.length)
              for (let cell = 0; cell < real; cell++) sink.run(cells[cell]!, rowLine.r)
              sink.runCount += headers.length - real
              sink.block(rowLine.r, "cell", headers.length)
            }
          }
          tokens.push({ type: "table" })
          const lastRow = Math.max(p + 1, end - 1)
          p = lastRow + 1
          nl = p <= level.last
          continue
        }
        sink.scan(line.r, level.rowAfter(end - 1), TABLE_RETRY, TABLE_RETRY_LINE)
      }

      // lheading
      const scan = { to: p }
      const underline = level.setext(p, scan)
      sink.scan(line.r, level.rowAfter(Math.min(scan.to, level.last)), 1, 0, true)
      if (underline >= 0) {
        let joined = level.text(p)
        for (let index = p + 1; index < underline; index++) joined += "\n" + level.text(index)
        const trimmed = joined.trim()
        sink.block(line.r, "heading")
        const run = sink.run(trimmed, line.r)
        if (trimmed.length > MAX_PARAGRAPH) run.over = this.overflowIn(level, p, underline, joined, trimmed)
        sink.spans.push(line.r, level.get(underline).r)
        for (let index = p + 1; index < underline; index++) sink.headingRows.push(level.get(index).r)
        tokens.push({ type: "heading", run })
        p = underline + 1
        nl = p <= level.last
        continue
      }

      // paragraph (at the top)
      if (this.top) {
        let q = p + 1
        while (q <= level.last && level.paragraphContinues(q)) q++
        const last = tokens.at(-1)
        let run: Run
        if (clipped && last?.type === "paragraph") {
          run = last.run!
          sink.append(run, text, line.r)
        } else {
          run = sink.run(text, line.r)
          sink.block(line.r, "paragraph")
          tokens.push({ type: "paragraph", run })
        }
        for (let index = p + 1; index < q; index++) sink.append(run, level.text(index), level.get(index).r)
        clipped = false
        p = q
        nl = p <= level.last
        continue
      }

      // text
      {
        const last = tokens.at(-1)
        if (last?.type === "text") sink.append(last.run!, text, line.r)
        else tokens.push({ type: "text", run: sink.run(text, line.r), row: line.r })
        p++
        nl = p <= level.last
      }
    }
    this.top = true
    return tokens
  }

  private space(tokens: Tok[], rawLength: number, newlines: number) {
    const last = tokens.at(-1)
    if (rawLength === 1 && last !== undefined) {
      if (last.raw !== undefined) last.raw.append("\n")
      if (last.rawLines !== undefined) last.rawNl = (last.rawNl ?? 0) + 1
      if (last.type === "space") last.newlines!++
    } else tokens.push({ type: "space", newlines })
  }

  private overflowIn(level: Level, p: number, end: number, joined: string, trimmed: string) {
    const lead = joined.length - joined.trimStart().length
    let length = -lead
    for (let index = p; index < end; index++) {
      const line = level.get(index)
      const added = (index > p ? 1 : 0) + line.t.length
      if (length + added > MAX_PARAGRAPH)
        return { row: line.r, allowance: Math.max(0, MAX_PARAGRAPH - length), exact: false }
      length += added
    }
    return { row: level.get(p).r, allowance: Math.min(MAX_PARAGRAPH, trimmed.length), exact: false }
  }

  private labelScan(level: Level, p: number): number {
    let scanned = 0
    let first = true
    for (let index = p; index <= level.last; index++) {
      const text = level.text(index)
      let at = first ? text.indexOf("[") + 1 : 0
      first = false
      for (; at < text.length; at++) {
        const char = text[at]
        if (char === "\\") at++
        else if (char === "[" || char === "]") return scanned + at
      }
      scanned += text.length + 1
    }
    return scanned
  }

  /** Where the lexer is once it skips `length` characters from the start of line p. */
  private advance(level: Level, p: number, length: number): [number, boolean] {
    let left = length
    let index = p
    while (index <= level.last) {
      const text = level.text(index)
      if (left < text.length) {
        level.override(index, { t: text.slice(left), r: level.get(index).r })
        return [index, false]
      }
      if (left === text.length) return index < level.last ? [index + 1, true] : [level.n, false]
      left -= text.length + 1
      index++
      if (left === 0) return [index, false]
    }
    return [level.n, false]
  }

  // -------------------------------------------------------------------------------------------------------------------
  // blockquote
  // -------------------------------------------------------------------------------------------------------------------

  blockquote(level: Level, p: number, depth: number): ListResult {
    const sink = this.sink
    const end = level.quoteEnd(p)
    const first = level.get(p)
    // marked's regex reads the whole run (and its tokenizer splits it into lines), every time it is tried.
    const quoteEnd = level.rowAfter(end - 1)
    sink.scan(first.r, quoteEnd, 2)
    const mark = sink.mark()
    sink.block(first.r, "blockquote")
    const tok: Tok = { type: "blockquote", mark }
    if (depth + 1 > MAX_NESTING) {
      sink.nestRows.push(first.r)
      tok.raw = new Rope()
      tok.rawRows = []
      return { tok, rawLength: level.chars(p, end) - 1 }
    }
    // The regex's lines (a code block can end the token early; the rest is lexed again after it): a few lines marked
    // made up (`pre`), then the source's from `baseStart`.
    const base = new Level((at) => level.get(p + at), end - p)
    let pre: Line[] = []
    let baseStart = 0
    const count = () => pre.length + base.n - baseStart
    const get = (at: number) => (at < pre.length ? pre[at]! : base.get(baseStart + at - pre.length))
    const tokens: Tok[] = []
    const raw = new Rope()
    const rawRows: number[] = []
    let k = 0
    while (k < count()) {
      let inQuote = false
      const current: Line[] = []
      let index = k
      for (; index < count(); index++) {
        const line = get(index)
        if (BQ.test(line.t)) {
          current.push(line)
          inQuote = true
        } else if (!inQuote) current.push(line)
        else break
      }
      // marked copies the rest of the run's lines (an array of them) for each segment.
      sink.scan(current[0]?.r ?? first.r, quoteEnd, 0, QUOTE_COPY_LINE)
      k = index
      const currentRaw = current.map((line) => line.t).join("\n")
      this.count(current.length + currentRaw.length / 16)
      const currentText = current.map((line, at) => {
        let text = line.t
        const setext = at > 0 ? SETEXT.exec(text) : null
        if (setext) text = `    ${setext[1]}`
        return { t: text.replace(BQ_STRIP, "$1"), r: line.r }
      })
      if (raw.length > 0) raw.append("\n")
      raw.append(currentRaw)
      for (const line of current) rawRows.push(line.r)
      const top = this.top
      this.top = true
      this.blockTokens(Level.of(currentText), tokens, true, depth + 1)
      this.top = top
      if (k >= count()) break
      const last = tokens.at(-1)
      if (last?.type === "code") break
      if (last?.type === "blockquote") {
        const rest: Line[] = []
        for (let at = k; at < count(); at++) rest.push(get(at))
        const continuation = rest.map((line) => ({ t: line.t.replace(BQ_STRIP, "$1"), r: line.r }))
        const oldLines = this.rawLinesOf(last)
        sink.rollback(last.mark!)
        this.count(rest.length + oldLines.length)
        const nested = this.blockquote(Level.of(oldLines.concat(continuation)), 0, depth + 1)
        tokens[tokens.length - 1] = nested.tok
        raw.append("\n")
        raw.append(rest.map((line) => line.t).join("\n"))
        for (const line of rest) rawRows.push(line.r)
        sink.scan(rest[0]?.r ?? first.r, quoteEnd, 2)
        break
      }
      if (last?.type === "list") {
        const oldLines = this.rawLinesOf(last)
        const from = k
        const view = new Level(
          (at) => (at < oldLines.length ? oldLines[at]! : get(from + at - oldLines.length)),
          oldLines.length + count() - from,
        )
        sink.rollback(last.mark!)
        const relisted = this.list(view, 0, depth + 1)!
        tokens[tokens.length - 1] = relisted.tok
        // marked's raw: the segment's raw less the old list's (stripped) raw, and the new list's.
        // Rows follow the raw's lines: the cut takes its lines' rows, the new list's lines after its first add theirs.
        rawRows.length = Math.max(1, rawRows.length - raw.truncate(rawLength(last)))
        raw.append(rawText(relisted.tok))
        for (const line of this.rawLinesOf(relisted.tok).slice(1)) rawRows.push(line.r)
        // marked joins the rest of the lines to the list's raw and splits what is left again.
        sink.scan(view.get(oldLines.length).r, quoteEnd, QUOTE_RELIST_CHAR, QUOTE_RELIST_LINE)
        // What follows the list's raw in its source, split into lines (one empty line when nothing does).
        const [next, nlAfter] = this.advance(view, 0, relisted.rawLength)
        const nextPre: Line[] = nlAfter ? [{ t: "", r: view.get(next - 1).r }] : []
        // View lines before `firstBase` are not the source's; the line at `next` may be a part of one.
        const firstBase = oldLines.length + Math.max(0, pre.length - from)
        const baseAt = (v: number) => baseStart + from + v - oldLines.length - pre.length
        let at = next
        for (; at < Math.min(firstBase, view.n); at++) nextPre.push(view.get(at))
        if (at === next && at < view.n) nextPre.push(view.get(at++))
        const nextBase = at < view.n ? baseAt(Math.max(at, firstBase)) : base.n
        if (nextPre.length === 0 && nextBase >= base.n) nextPre.push({ t: "", r: view.get(view.n - 1).r })
        // (`view` reads `pre` and `baseStart`: both change only now.)
        baseStart = nextBase
        pre = nextPre
        this.count(pre.length + relisted.tok.rawLines!.length)
        k = 0
        continue
      }
    }
    tok.raw = raw
    tok.rawRows = rawRows
    return { tok, rawLength: raw.length }
  }

  /** A list's or blockquote's raw as lines (marked joins it with what follows and lexes that again). */
  private rawLinesOf(tok: Tok): Line[] {
    if (tok.rawLines) {
      const out = tok.rawLines.slice()
      const row = out.at(-1)?.r ?? 0
      for (let added = 0; added < (tok.rawNl ?? 0); added++) out.push({ t: "", r: row })
      return out
    }
    const rows = tok.rawRows!
    this.count(tok.raw!.length / 16)
    return tok
      .raw!.text()
      .split("\n")
      .map((t, index) => ({ t, r: rows[Math.min(index, rows.length - 1)] ?? 0 }))
  }

  // -------------------------------------------------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------------------------------------------------

  list(level: Level, p: number, depth: number): ListResult | undefined {
    const sink = this.sink
    const start = LIST_START.exec(level.text(p))
    if (!start) return undefined
    let bull = start[1]!.trim()
    const ordered = bull.length > 1
    const bullPattern = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`
    let itemRegex = itemRegexes.get(bullPattern)
    if (!itemRegex) {
      itemRegex = new RegExp(`^( {0,3}${bullPattern})((?:[\\t ][\\s\\S]*)?)$`)
      itemRegexes.set(bullPattern, itemRegex)
    }
    interface Item {
      lines: Line[]
      row: number
    }
    const items: Item[] = []
    const rawLines: Line[] = []
    let q = p
    const mark = sink.mark()
    let loose = false
    let endsWithBlankLine = false
    while (level.has(q, false)) {
      const bulletLine = level.get(q)
      const cap = itemRegex.exec(bulletLine.t)
      if (!cap) break
      if (HR.test(bulletLine.t)) break
      const itemRaw: Line[] = [bulletLine]
      let line = expandTabs(cap[2]!, cap[1]!.length)
      q++
      let nextLine = q <= level.last ? level.text(q) : ""
      let blankLine = !line.trim()
      let indent: number
      let contents = ""
      if (blankLine) indent = cap[1]!.length + 1
      else {
        indent = firstNonSpace(line)
        if (indent > 4) indent = 1
        contents = line.slice(indent)
        indent += cap[1]!.length
      }
      const itemLines: Line[] = [{ t: contents, r: bulletLine.r }]
      let endEarly = false
      if (blankLine && /^[ \t]*$/.test(nextLine)) {
        if (level.has(q, false)) {
          itemRaw.push(level.get(q))
          q++
        }
        endEarly = true
      }
      if (!endEarly) {
        const patterns = itemPatterns[Math.max(0, Math.min(3, indent - 1))]!
        const fencesBegin = patterns.fences
        const headingBegin = patterns.heading
        const blockquoteBegin = patterns.quote
        const nextBullet = patterns.bullet
        const hrBegin = patterns.hr
        const k = Math.max(0, Math.min(3, indent - 1))
        // Whether a line can begin one of the patterns that end the item (each starts with at most k spaces).
        const mayEnd = (text: string) => {
          const spaces = leadSpaces(text)
          if (spaces > k) return false
          const c = text.charCodeAt(spaces)
          return c === 96 || c === 126 || c === 35 || c === 62 || c === 95 || isBullet(c)
        }
        while (level.has(q, false)) {
          const rawLine = level.get(q)
          nextLine = rawLine.t
          const withoutTabs = nextLine.includes("\t") ? nextLine.replace(/\t/g, "    ") : nextLine
          if (mayEnd(nextLine)) {
            if (fencesBegin.test(nextLine)) break
            if (headingBegin.test(nextLine)) break
            if (blockquoteBegin.test(nextLine)) break
            if (nextBullet.test(nextLine)) break
            if (hrBegin.test(nextLine)) break
          }
          const blank = !nextLine.trim()
          if (blank || leadSpaces(withoutTabs) >= indent) {
            itemLines.push({ t: withoutTabs.slice(indent), r: rawLine.r })
          } else {
            if (blankLine) break
            // (marked's `search(/[^ ]/)`: -1 when the line is only spaces.)
            const previous = line.includes("\t") ? line.replace(/\t/g, "    ") : line
            const previousIndent = leadSpaces(previous)
            if (previousIndent < previous.length && previousIndent >= 4) break
            if (mayEnd(line) && (fencesBegin.test(line) || headingBegin.test(line) || hrBegin.test(line))) break
            itemLines.push(rawLine)
          }
          blankLine = blank
          itemRaw.push(rawLine)
          q++
          line = withoutTabs.slice(indent)
        }
      }
      if (!loose) {
        // marked's item raw: the bullet line (with its line break, if any) and each line after it with "\n".
        let itemRawText = bulletLine.t + (itemRaw.length > 1 || level.followed(q - itemRaw.length) ? "\n" : "")
        for (let at = 1; at < itemRaw.length; at++) itemRawText += itemRaw[at]!.t + "\n"
        if (endsWithBlankLine) loose = true
        else if (/\n[ \t]*\n[ \t]*$/.test(itemRawText)) endsWithBlankLine = true
      }
      items.push({ lines: itemLines, row: bulletLine.r })
      for (const l of itemRaw) rawLines.push(l)
    }
    if (items.length === 0) return undefined
    this.count(rawLines.length)
    // trimEnd: the last item's text and the list's raw.
    const lastItem = items.at(-1)!
    trimEndLines(lastItem.lines)
    const trimmedRaw = rawLines
    trimEndLines(trimmedRaw)
    const tok: Tok = { type: "list", rawLines: trimmedRaw, rawNl: 0, mark }
    // Items' contents.
    const firstRuns: number[] = []
    const itemTokens: Tok[][] = []
    for (const item of items) {
      sink.block(item.row, "item")
      this.top = false
      if (depth + 1 > MAX_NESTING) {
        sink.nestRows.push(item.row)
        this.top = true
        firstRuns.push(-1)
        continue
      }
      const tokens = this.blockTokens(Level.of(item.lines), [], false, depth + 1)
      itemTokens.push(tokens)
      if (!loose) loose = tokens.some((token) => token.type === "space" && token.newlines! >= 2)
      const firstToken = tokens[0]
      firstRuns.push(firstToken && (firstToken.type === "text" || firstToken.type === "paragraph") ? 1 : -1)
    }
    // Task items: marked looks for the last queued run that starts with a task marker, from the end of the queue, and
    // takes the marker off it (which may not be the item's own run).
    items.forEach((item, index) => {
      if (!TASK.test(item.lines[0]?.t ?? "") || firstRuns[index]! < 0) return
      const at = sink.tasks.pop()
      const place = sink.tasks.pop()
      // Each scan is the item's (cut before it, there is no scan).
      sink.worked(item.row, 8 * (sink.runCount - (place ?? 0)))
      if (at === undefined || place === undefined) return
      const run = sink.runs[at]!
      const marker = TASK_MARK.exec(run.head.slice(run.off))![0]
      run.off += marker.length
      run.len -= marker.length
      if (TASK.test(run.head.slice(run.off))) sink.tasks.push(place, at)
    })
    // A loose list's items show their text as paragraphs.
    if (loose)
      for (const tokens of itemTokens)
        for (const token of tokens) if (token.type === "text") sink.block(token.row!, "paragraph")
    return { tok, rawLength: rawLength(tok) }
  }
}

/** A string built by appending and cutting from the end, as marked builds a blockquote's raw. */
class Rope {
  private readonly pieces: string[] = []
  length = 0
  append(text: string) {
    if (text === "") return
    this.pieces.push(text)
    this.length += text.length
  }
  /** Cuts `count` characters from the end; returns how many line breaks went with them. */
  truncate(count: number): number {
    let left = Math.min(count, this.length)
    this.length -= left
    let breaks = 0
    const countBreaks = (text: string) => {
      for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) breaks++
    }
    while (left > 0) {
      const last = this.pieces.pop()!
      if (last.length > left) {
        countBreaks(last.slice(last.length - left))
        this.pieces.push(last.slice(0, last.length - left))
        left = 0
      } else {
        countBreaks(last)
        left -= last.length
      }
    }
    return breaks
  }
  text(): string {
    const joined = this.pieces.join("")
    this.pieces.length = 0
    this.pieces.push(joined)
    return joined
  }
}

/** A list's or blockquote's raw, as marked keeps it. */
function rawText(tok: Tok): string {
  if (tok.rawLines) return tok.rawLines.map((line) => line.t).join("\n") + "\n".repeat(tok.rawNl ?? 0)
  return tok.raw!.text()
}

function rawLength(tok: Tok): number {
  if (!tok.rawLines) return tok.raw!.length
  let length = Math.max(0, tok.rawLines.length - 1) + (tok.rawNl ?? 0)
  for (const line of tok.rawLines) length += line.t.length
  return length
}

/** String.prototype.trimEnd over lines joined with "\n". */
function trimEndLines(lines: Line[]) {
  while (lines.length > 0 && /^\s*$/.test(lines.at(-1)!.t)) {
    if (lines.length === 1) {
      lines[0] = { t: "", r: lines[0]!.r }
      return
    }
    lines.pop()
  }
  const last = lines.at(-1)
  if (last) lines[lines.length - 1] = { t: last.t.trimEnd(), r: last.r }
}

// ---------------------------------------------------------------------------------------------------------------------
// What a text shows and builds
// ---------------------------------------------------------------------------------------------------------------------

/** Why a Markdown text is cut (see `markdownShape`). */
export type MarkdownCutReason = "text" | "paragraph" | "blocks" | "nesting" | "work" | "lines"

/** Where a Markdown text is cut, and why. */
export interface MarkdownCut {
  /** How many of the text's characters show (its length when nothing is cut). */
  readonly shown: number
  readonly reason?: MarkdownCutReason
}

/**
 * What a Markdown text shows and what the app builds for that: where it is cut, the code blocks (fenced, indented,
 * display math; `own` of them shown on their own, see MAX_CODE_PARTS) in what shows, and the blocks and inline
 * elements there beyond what its length pays for (`blocks`: see MAX_MARKDOWN_BLOCKS and CHARS_PER_BLOCK). The render
 * budget charges these (src/gui/costs.ts).
 */
export interface MarkdownShape {
  readonly cut: MarkdownCut
  readonly code: number
  readonly own: number
  readonly blocks: number
}

/** A text's lines as marked splits them (it reads "\r\n" and "\r" as "\n"), and where each starts in the text. */
function textRows(text: string): { readonly rows: string[]; readonly starts: number[] } {
  const rows: string[] = []
  const starts: number[] = []
  const breaks = /\r\n|\r|\n/g
  let at = 0
  for (;;) {
    const found = breaks.exec(text)
    rows.push(text.slice(at, found ? found.index : text.length))
    starts.push(at)
    if (!found) break
    at = found.index + found[0].length
  }
  return { rows, starts }
}

/**
 * What the model may do for a text of these many characters and lines before it stops (a few dozen times its lines:
 * an ordinary text needs a few). Only text built for it gets there, by making marked rebuild a blockquote's raw for
 * every one of its lines; the text is then cut where the model stopped.
 */
const modelLimit = (chars: number, lines: number) => 32 * (lines + chars / 16) + 100_000

/**
 * How many characters of a row to show so that at most `allowance` of them reach marked: as many when marked reads the
 * row as written (`exact`); else four fewer, with a tab counted four (marked may widen a tab in a list item, and add
 * up to four spaces before a quote's underline-like line).
 */
function within(text: string, allowance: number, exact: boolean): number {
  if (exact) return Math.min(text.length, allowance)
  let width = 4
  let index = 0
  for (; index < text.length; index++) {
    width += text.charCodeAt(index) === 9 ? 4 : 1
    if (width > allowance) break
  }
  return index
}

/** A row that may be a table's delimiter row in some container (its markers and indentation before it). */
const DELIMITER_ROW =
  /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** The row a position of the text is in. */
function rowAt(starts: readonly number[], position: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= position) low = middle
    else high = middle - 1
  }
  return low
}

// An autolink's start (`<scheme:`), which genui writes as a link (see AUTOLINK).
const AUTOLINK_START = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:/y
const isWordChar = (c: number) =>
  (c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122) || (c > 127 && ALPHANUMERIC.test(String.fromCharCode(c)))

/**
 * At most how many inline elements the renderer builds from a row of an inline run (see Sink.runs): each a node of
 * the app's, as a block is (in the playground, 20 to 40 µs each with its layout), and a text of tiny ones built 80,000
 * links, emphases or code spans in 480,000 characters (1.5 to 2.1 s in one task). It counts what each needs: a link or
 * an image a `[` (genui writes images, autolinks and addresses as links too, and marked resolves references to the
 * definitions genui writes), an autolink `<scheme:`, an address `://` or `www.`, an e-mail address (which marked links
 * itself) an `@`; emphasis, strong emphasis and strikethrough two of the `*`, `~` and `_` that may delimit them (not a
 * `_` inside a word), a code span two runs of backticks, math two `$` or a `\(`, and a hard line break the row's end.
 * Each of these makes at most one, so the count is an upper bound of what renders: neutralizing only ever writes fewer
 * (a delimiter past the emphasis budget as a character reference, math past the math budget as text, a link of its own
 * for each construct it counts).
 */
function inlineSpans(row: string): number {
  let spans = 0
  let delimiters = 0
  let ticks = 0
  for (let index = 0; index < row.length; index++) {
    const c = row.charCodeAt(index)
    if (c === 91 || c === 64) spans++
    else if (c === 42 || c === 126 || c === 36) delimiters++
    else if (c === 92) {
      if (row.charCodeAt(index + 1) === 40) spans++
    } else if (c === 95) {
      if (!(isWordChar(row.charCodeAt(index - 1)) && isWordChar(row.charCodeAt(index + 1)))) delimiters++
    } else if (c === 96) {
      if (row.charCodeAt(index - 1) !== 96) ticks++
    } else if (c === 58) {
      if (row.charCodeAt(index + 1) === 47 && row.charCodeAt(index + 2) === 47) spans++
    } else if (c === 119) {
      // (`www.` right after `://` is in the address that counted.)
      if (row.startsWith("ww.", index + 1) && !(index >= 3 && row.startsWith("://", index - 3))) spans++
    } else if (c === 60) {
      AUTOLINK_START.lastIndex = index
      if (AUTOLINK_START.test(row)) spans++
    }
  }
  if (row.endsWith("  ") || row.endsWith("\\")) spans++
  return spans + delimiters / 2 + ticks / 2
}

/** The model's findings for a text of rows, lexed in the parts `splitMarkdown` splits it into. */
function lexRows(rows: readonly string[], sink: Sink, lexer: BlockLexer, own: number[]): void {
  for (const segment of fenceSegments(rows)) {
    if (segment.code) {
      own.push(segment.from)
      continue
    }
    sink.beginSegment()
    const lines: Line[] = []
    for (let row = segment.from; row < segment.to; row++) lines.push({ t: rows[row]!, r: row })
    work.modeled += lines.length
    lexer.lex(lines)
  }
}

/** The lines the model has read, and neutralizing has written, so far (see `markdownWork`). */
const work = { modeled: 0, neutralized: 0 }

/**
 * How many lines the model has read, and neutralizing has written, so far: what measuring texts (`markdownShape`) and
 * rendering them (`renderMarkdown`) cost, for tests.
 */
export const markdownWork = (): { readonly modeled: number; readonly neutralized: number } => ({ ...work })

/**
 * marked's block work (see MAX_BLOCK_WORK) on a text of `rows` (starting at `starts`, `length` characters in all), as
 * the model tallied it in `sink`, up to the first row it passes `limit` at (or the first that starts at `end`): that row
 * (-1: none), and the work up to it.
 * The work up to the start of a row is the work at earlier rows, and of each scan that starts before it, the part
 * before it (cut there, a scan stops at the cut).
 */
function workPast(
  sink: Sink,
  rows: readonly string[],
  starts: readonly number[],
  length: number,
  limit: number,
  end = length,
): { readonly row: number; readonly work: number } {
  let total = 0
  for (let row = 0, reading = 0, readingLines = 0, setext = 0; row < rows.length && starts[row]! < end; row++) {
    reading += sink.opens[row]! - sink.closes[row]!
    readingLines += sink.lineOpens[row]! - sink.lineCloses[row]!
    setext += sink.setextOpens[row]! - sink.setextCloses[row]!
    const before = total
    total += sink.work[row]! + reading * ((starts[row + 1] ?? length) - starts[row]!) + readingLines
    if (setext > 0) total += setext * setextLineCost(rows[row]!)
    if (total > limit) return { row, work: before }
  }
  return { row: -1, work: total }
}

/**
 * marked's block work (see MAX_BLOCK_WORK) on a text, as the model tallies it, up to the start of the row `shown` is in
 * (for tests: what shows of a text is within the bound).
 */
export function blockWork(text: string, shown = text.length): number {
  const { rows, starts } = textRows(text)
  const sink = new Sink(rows)
  lexRows(rows, sink, new BlockLexer(sink), [])
  return workPast(sink, rows, starts, text.length, Infinity, shown).work
}

function measure(text: string): MarkdownShape {
  const source = text.length > MAX_MARKDOWN_TEXT ? text.slice(0, MAX_MARKDOWN_TEXT) : text
  const { rows, starts } = textRows(source)
  const sink = new Sink(rows)
  const lexer = new BlockLexer(sink, modelLimit(source.length, rows.length))
  const own: number[] = []
  let stopped = -1
  try {
    lexRows(rows, sink, lexer, own)
  } catch (error) {
    if (!(error instanceof Abort)) throw error
    stopped = lexer.topRow
  }

  let cut = Infinity
  let reason: MarkdownCutReason | undefined
  const consider = (position: number, why: MarkdownCutReason) => {
    if (position < cut) [cut, reason] = [position, why]
  }
  if (text.length > MAX_MARKDOWN_TEXT) consider(MAX_MARKDOWN_TEXT, "text")
  if (stopped >= 0) consider(starts[stopped]!, "work")
  for (const row of sink.nestRows) consider(starts[row]!, "nesting")
  for (const run of sink.runs)
    if (run.over)
      consider(starts[run.over.row]! + within(rows[run.over.row]!, run.over.allowance, run.over.exact), "paragraph")
  const over = workPast(sink, rows, starts, source.length, MAX_BLOCK_WORK)
  if (over.row >= 0) consider(starts[over.row]!, "work")
  // Blocks and inline elements (beyond what the text before them pays for), counted in the order of the text, in what
  // shows so far (a row a paragraph cut ends shows only so far).
  const limit = Math.min(cut, source.length)
  const perRow = new Float64Array(rows.length)
  sink.blockRows.forEach((row, index) => (perRow[row]! += sink.blockCounts[index]!))
  const inline = new Uint8Array(rows.length)
  for (const run of sink.runs) inline[run.row] = 1
  for (const row of sink.appended) inline[row] = 1
  for (const row of sink.headingRows) inline[row] = 1
  const spans = new Float64Array(rows.length)
  for (let row = 0; row < rows.length && starts[row]! < limit; row++) {
    if (!inline[row]) continue
    const line = rows[row]!
    spans[row] = inlineSpans(starts[row]! + line.length > limit ? line.slice(0, limit - starts[row]!) : line)
    perRow[row]! += spans[row]!
  }
  for (let row = 0, total = 0; row < rows.length; row++) {
    total += perRow[row]!
    if (total - Math.floor((starts[row + 1] ?? source.length) / CHARS_PER_BLOCK) > MAX_MARKDOWN_BLOCKS) {
      consider(starts[row]!, "blocks")
      break
    }
  }
  // A cut inside a setext heading or display math moves to its first line, and one inside a line followed by a
  // table's delimiter row (a header, or a line marked's paragraph stops at for one) to that line's start: cut there,
  // those lines would be lexed again as other blocks, joined to the run before them, at a cost the count above did not
  // see.
  const settle = (position: number) => {
    let at = position
    for (let moved = true; moved && at < Infinity; ) {
      moved = false
      for (let index = 0; index < sink.spans.length; index += 2) {
        const first = starts[sink.spans[index]!]!
        const end = starts[sink.spans[index + 1]! + 1] ?? source.length
        if (at > first && at < end) [at, moved] = [first, true]
      }
      const row = rowAt(starts, at)
      if (at > starts[row]! && row + 1 < rows.length && DELIMITER_ROW.test(rows[row + 1]!))
        [at, moved] = [starts[row]!, true]
    }
    return at
  }
  cut = settle(cut)
  let shown = text.length
  if (cut < text.length) {
    // Never between the halves of a surrogate pair.
    const high = text.charCodeAt(cut - 1)
    shown = high >= 0xd800 && high <= 0xdbff ? cut - 1 : cut
  } else reason = undefined
  const visible = (row: number) => starts[row]! < shown
  const count = (rowsOf: readonly number[]) => rowsOf.reduce((total, row) => total + (visible(row) ? 1 : 0), 0)
  const ownShown = count(own)
  // A cut text ends with a paragraph of its own ("…"), and so may one that is not, where it renders (see
  // `renderMarkdown`): counted either way.
  let blocks = 1
  sink.blockRows.forEach((row, index) => (blocks += visible(row) ? sink.blockCounts[index]! : 0))
  for (let row = 0; row < rows.length && visible(row); row++) blocks += spans[row]!
  return {
    cut: reason ? { shown, reason } : { shown },
    code: count(sink.codeRows) + count(sink.mathRows) + ownShown,
    own: ownShown,
    // The blocks and inline elements the text's length does not pay for (see CHARS_PER_BLOCK).
    blocks: Math.min(MAX_MARKDOWN_BLOCKS, Math.max(0, Math.ceil(blocks) - Math.floor(shown / CHARS_PER_BLOCK))),
  }
}

/**
 * How many characters of text the shapes of recent texts are kept for at most (and SHAPE_CACHE_SIZE texts), besides
 * the newest text whatever its length: as many as one UI's elements keep of what expressions build (KEPT_PER_SURFACE
 * in src/runtime/budget.ts). The texts are the keys: kept by count alone, 64 texts of a million characters that a
 * `$template` built stayed in memory (63 MB) after their elements were gone.
 */
export const SHAPE_CACHE_CHARS = 2_000_000
const SHAPE_CACHE_SIZE = 64

// The shapes of recent texts, least recently used first: the rows of a repeat share one text, which is measured once.
const shapes = new Map<string, MarkdownShape>()
let shapeChars = 0

/** How many characters of text the shapes cache holds (for tests). */
export const shapeCacheChars = (): number => shapeChars

/**
 * What a Markdown text shows and builds (see MarkdownShape): up to MAX_MARKDOWN_TEXT characters, cut where marked
 * would hand its inline lexer a run past MAX_PARAGRAPH, where blocks and inline elements pass MAX_MARKDOWN_BLOCKS
 * beyond one per CHARS_PER_BLOCK characters, where containers nest past MAX_NESTING, or where marked's block lexer has
 * scanned more than MAX_BLOCK_WORK; on a code point's boundary. This is what the render budget charges, from the model's reading of
 * the text as written alone: it is linear in the text and never neutralizes it, since the budget measures texts that
 * never render (an element it then refuses, an Accordion's items of an element that does not fit). A text that renders
 * may show less (see `renderMarkdown`), never more.
 */
export function markdownShape(text: string): MarkdownShape {
  let shape = shapes.get(text)
  if (shape !== undefined) {
    shapes.delete(text)
    shapes.set(text, shape)
    return shape
  }
  shape = measure(text)
  shapes.set(text, shape)
  shapeChars += text.length
  for (const [oldest] of shapes) {
    if (oldest === text || (shapes.size <= SHAPE_CACHE_SIZE && shapeChars <= SHAPE_CACHE_CHARS)) break
    shapes.delete(oldest)
    shapeChars -= oldest.length
  }
  return shape
}

/** How much of a Markdown text shows (see `markdownShape`). */
export const shownLength = (text: string): MarkdownCut => markdownShape(text).cut

/**
 * A Markdown text's code blocks: all it renders (fenced, indented, display math), and those it shows on their own
 * (see MAX_CODE_PARTS). Each is a code block of the app's renderer (display math past the math budget too).
 */
export interface CodeBlocks {
  readonly total: number
  readonly own: number
}

/** A Markdown text's code blocks in what shows (see CodeBlocks), for its charge in the render budget. */
export function codeBlocks(text: string): CodeBlocks {
  const { code, own } = markdownShape(text)
  return { total: code, own }
}

/**
 * What the model finds in a text lexed whole (as one part, as marked lexes each part genui hands it), for the tests
 * (test/unit/review8-markdown.test.ts): code blocks, display math, blocks by type, each inline run's length, the rows
 * genui writes again as definitions, and marked's block work (see MAX_BLOCK_WORK).
 */
export function blockStructure(text: string) {
  const { rows, starts } = textRows(text)
  const sink = new Sink(rows, new Uint8Array(rows.length), new Uint8Array(rows.length))
  new BlockLexer(sink).lex(rows.map((t, r) => ({ t, r })))
  const blocks: Record<string, number> = {}
  sink.blockTypes.forEach((type, index) => (blocks[type] = (blocks[type] ?? 0) + sink.blockCounts[index]!))
  return {
    code: sink.codeRows.length,
    math: sink.mathRows.length,
    blocks,
    // (A padded table cell is an empty run.)
    runs: [...sink.runs.map((run) => run.len), ...Array.from({ length: sink.runCount - sink.runs.length }, () => 0)],
    definitions: [...sink.definitions.keys()],
    rows,
    work: workPast(sink, rows, starts, text.length, Infinity).work,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 1: defuse
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Text with a joiner in every construct that could become a link, an image or HTML: `<` before a tag name, `/`, `!` or
 * `?` (a tag, comment, declaration or autolink), `](` and `]:` (an inline link and a reference definition), `![` (an
 * image), `://` (a bare URL, or inline code the app turns into a link) and `www.` (a bare address).
 */
export function defuse(text: string, breaker = JOINER): string {
  return text
    .replace(/<(?=[A-Za-z/!?])/g, `<${breaker}`)
    .replace(/\](?=[(:])/g, `]${breaker}`)
    .replace(/!(?=\[)/g, `!${breaker}`)
    .replace(/:(?=\/\/)/g, `:${breaker}`)
    .replace(/(www)(?=\.)/gi, `$1${breaker}`)
}

/**
 * Math (KaTeX) defused with spaces instead of joiners: KaTeX ignores spaces in math mode but warns about a joiner. A
 * space breaks the same constructs, so text that only looks like math to this file stays safe (with a visible space).
 */
const defuseMath = (text: string) => defuse(text, " ")

// Character references marked shows as the character and never reads as syntax.
const REFERENCES: Readonly<Record<string, string>> = {
  "*": "&#42;",
  _: "&#95;",
  "~": "&#126;",
  $: "&#36;",
  "\\": "&#92;",
}

/**
 * Text with its emphasis delimiters written as character references, except inside code spans (where a reference would
 * show as written).
 */
function plainDelimiters(text: string): string {
  let out = ""
  for (let index = 0; index < text.length; ) {
    if (text[index] === "`") {
      const end = codeSpanEnd(text, index)
      const stop = end === -1 ? runEnd(text, index, "`") : end
      out += text.slice(index, stop)
      index = stop
      continue
    }
    const char = text[index]!
    out += char === "*" || char === "_" || char === "~" ? REFERENCES[char] : char
    index++
  }
  return out
}

/** Math written as text: what makes it math (`$`, `\`) or emphasis written as character references. */
const mathAsText = (text: string) => text.replace(/[*_~$\\]/g, (char) => REFERENCES[char]!)

/** Text without the joiners `neutralizeMarkdown` added, for copying. */
export const stripJoiners = (text: string) => text.replaceAll(JOINER, "")

// ---------------------------------------------------------------------------------------------------------------------
// Step 2: links genui writes itself
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The address a link genui wrote points to: the decoded URL (already through `safeUrl`, or "" when the model's address
 * was refused), or undefined for an href that is not one of genui's links.
 */
export function linkTarget(href: string): string | undefined {
  if (!href.startsWith(LINK_PREFIX)) return undefined
  try {
    return decodeURIComponent(href.slice(LINK_PREFIX.length))
  } catch {
    return ""
  }
}

// Only letters, digits, `%`, `-` and `_` remain: no `.`, `:` or `/` that could read as an address if marked did not
// take the link as one.
const encodeTarget = (url: string) =>
  encodeURIComponent(url).replace(/[!'()*.~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const MAX_TITLE = 1000

/**
 * A link title as genui writes it: quoted (single quotes in a link; double quotes in a definition, whose title marked
 * reads without escapes), defused, on one line, with no `"` that could end the attribute.
 */
function titlePart(url: string, title: string, quote: "'" | '"' = "'"): string {
  const own = title.replace(/\s+/g, " ").trim()
  const text = own && url ? `${own} (${url})` : own || url
  if (!text) return ""
  const safe = defuse(text.slice(0, MAX_TITLE))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll('"', "&#34;")
    .replace(/[\\'|]/g, "\\$&")
  return ` ${quote}${safe}${quote}`
}

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/
const isEscapable = (char: string | undefined) => char !== undefined && ASCII_PUNCTUATION.test(char)

/**
 * Text (an address) that marked shows as written: defused, so it stays inert even as plain text, with the characters
 * that would start emphasis, code, math, a table cell, a link or an entity written as character references. Not as
 * backslash escapes: marked makes a token of each, and a link text of 9,500 of them (a bare URL full of `_`) took 0.4 s.
 */
const literal = (text: string) =>
  defuse(text).replace(/[\\`*_[\]<>~|!$]|&(?=#?\w+;)/g, (char) => `&#${char.charCodeAt(0)};`)

/** Backslash escapes and the usual character references in a link's address or title resolved (as CommonMark does). */
function unescape(text: string): string {
  return text
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (match, dec, hex, name) => {
      if (name) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name as "amp"]
      const code = dec ? Number(dec) : Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match
    })
}

/** Whether a blank line starts right after the line break at `index` (inline syntax never crosses one). */
function blankAfter(src: string, index: number): boolean {
  let next = index + 1
  while (src[next] === " " || src[next] === "\t") next++
  return next >= src.length || src[next] === "\n" || src[next] === "\r"
}

const runEnd = (src: string, index: number, char: string) => {
  while (src[index] === char) index++
  return index
}

/** Whether the text ends in an odd number of backslashes (which would escape the character that follows it). */
function endsEscaping(text: string): boolean {
  let index = text.length
  while (index > 0 && text[index - 1] === "\\") index--
  return ((text.length - index) & 1) === 1
}

// Where each run of backticks in a text ends its code span, computed in one pass from the end: a run opens a span
// when a later run of the same length follows before a blank line. Cached per text (a prose run and the link labels
// in it) for one `neutralizeMarkdown` call, so scanning from every `[` stays linear.
const spanCache = new Map<string, Map<number, number>>()

function spanEnds(src: string): Map<number, number> {
  const cached = spanCache.get(src)
  if (cached) return cached
  const ends = new Map<number, number>()
  let next = new Map<number, number>()
  for (let index = src.length - 1; index >= 0; index--) {
    const char = src[index]
    if (char === "\n" && blankAfter(src, index)) next = new Map()
    if (char !== "`" || src[index - 1] === "`") continue
    const end = runEnd(src, index, "`")
    const length = end - index
    const close = next.get(length)
    ends.set(index, close === undefined ? -1 : close + length)
    next.set(length, index)
  }
  spanCache.set(src, ends)
  return ends
}

/** The end of the code span whose opening backticks start at `index`, or -1 when they open none. */
const codeSpanEnd = (src: string, index: number): number => spanEnds(src).get(index) ?? -1

const MAX_LABEL = 1000
const MAX_ADDRESS = 8192

/**
 * What the scans after a link's `](` (its address and title), and the rare bracket scans `bracketEnds` does not cover,
 * may still read in one prose run, in characters. A text built for it (`[a](x` repeated) would make those scans
 * quadratic; once the budget is spent, no further link is recognized, and the rest stays text (defused like everything
 * else). Ordinary text uses a small part of it: brackets alone never spend it.
 */
interface LinkWork {
  left: number
}

const linkWork = (src: string): LinkWork => ({ left: 16 * src.length + 4 * MAX_LABEL })

// The `]` that closes each `[` of a text, computed in one pass with a stack: nesting, escapes, code spans, a blank line
// (which closes nothing), and at most MAX_LABEL characters from the `[`. Cached per text for one `neutralizeMarkdown`
// call. Scanning from every `[` instead cost a budget that about 50 unmatched brackets in ordinary prose spent ("[0, 10)",
// ANSI colour codes), after which later links in the run showed as raw text.
const bracketCache = new Map<string, Map<number, number>>()

function bracketEnds(src: string): Map<number, number> {
  const cached = bracketCache.get(src)
  if (cached) return cached
  const ends = new Map<number, number>()
  const open: number[] = []
  for (let index = 0; index < src.length; index++) {
    const char = src[index]
    if (char === "\\" && isEscapable(src[index + 1])) index++
    else if (char === "`") {
      const end = codeSpanEnd(src, index)
      index = (end === -1 ? runEnd(src, index, "`") : end) - 1
    } else if (char === "\n" && blankAfter(src, index)) open.length = 0
    else if (char === "[") {
      open.push(index)
      ends.set(index, -1)
    } else if (char === "]") {
      const start = open.pop()
      if (start !== undefined && index - start < MAX_LABEL) ends.set(start, index)
    }
  }
  bracketCache.set(src, ends)
  return ends
}

/**
 * The `]` that closes the link text opened at `open`, with nesting, escapes and code spans; -1 when there is none. A
 * `[` that the text's own pass reads as part of something else (an escape at the end of a bare URL that `inline`
 * skipped) is scanned on its own, from the work budget.
 */
function closingBracket(src: string, open: number, work: LinkWork): number {
  const known = bracketEnds(src).get(open)
  if (known !== undefined) return known
  let depth = 0
  const limit = Math.min(src.length, open + MAX_LABEL, open + work.left)
  let index = open
  let found = -1
  for (; index < limit; index++) {
    const char = src[index]
    if (char === "\\" && isEscapable(src[index + 1])) index++
    else if (char === "`") {
      const end = codeSpanEnd(src, index)
      index = (end === -1 ? runEnd(src, index, "`") : end) - 1
    } else if (char === "\n" && blankAfter(src, index)) break
    else if (char === "[") depth++
    else if (char === "]" && --depth === 0) {
      found = index
      break
    }
  }
  work.left -= index - open + 1
  return found
}

function skipBlanks(src: string, index: number): number {
  while (src[index] === " " || src[index] === "\t") index++
  return index
}

function skipSpace(src: string, index: number): number {
  while (src[index] === " " || src[index] === "\t") index++
  if (src[index] === "\n" && !blankAfter(src, index)) {
    index++
    while (src[index] === " " || src[index] === "\t") index++
  }
  return index
}

interface ParsedLink {
  /** The link text (an image's alt text), as written. */
  readonly label: string
  readonly url: string
  readonly title: string
  readonly end: number
}

/** The inline link (or image, without its `!`) whose `[` is at `open`: `[text](address "title")`, or undefined. */
function parseLink(src: string, open: number, work: LinkWork): ParsedLink | undefined {
  const close = closingBracket(src, open, work)
  if (close === -1 || src[close + 1] !== "(") return undefined
  const scan = { at: close + 2 }
  try {
    return parseDestination(src, open, close, scan)
  } finally {
    work.left -= scan.at - (close + 2)
  }
}

/**
 * The rest of an inline link after its `](`: the address and title, and the closing `)`, on the same line (a link that
 * goes on to another line stays text: written on one line, it would join lines that marked may read as other blocks).
 * `scan.at` is how far it read.
 */
function parseDestination(src: string, open: number, close: number, scan: { at: number }): ParsedLink | undefined {
  let index = skipBlanks(src, close + 2)
  let address: string
  if (src[index] === "<") {
    let end = index + 1
    for (; end < src.length && src[end] !== ">"; end++) {
      if (src[end] === "\n" || src[end] === "<") break
      if (src[end] === "\\" && isEscapable(src[end + 1])) end++
    }
    scan.at = end
    if (src[end] !== ">") return undefined
    address = src.slice(index + 1, end)
    index = end + 1
  } else {
    // At most 32 nested parentheses (as cmark allows) and MAX_ADDRESS characters, so a scan from every `[` stays short.
    const start = index
    const limit = Math.min(src.length, index + MAX_ADDRESS)
    let depth = 0
    for (; index < limit; index++) {
      const char = src[index]!
      if (char === "\\" && isEscapable(src[index + 1])) index++
      else if (char === "(") {
        if (++depth > 32) break
      } else if (char === ")") {
        if (depth === 0) break
        depth--
      } else if (/[ \t\n\u0000-\u001f\u007f]/.test(char)) break
    }
    scan.at = index
    if (depth !== 0 || index >= limit) return undefined
    address = src.slice(start, index)
  }
  let title = ""
  const spaced = skipBlanks(src, index)
  const quote = src[spaced]
  if (spaced > index && (quote === '"' || quote === "'" || quote === "(")) {
    const end = quote === "(" ? ")" : quote
    let at = spaced + 1
    let valid = true
    for (; at < src.length && src[at] !== end; at++) {
      if (src[at] === "\\" && isEscapable(src[at + 1])) at++
      else if ((quote === "(" && src[at] === "(") || src[at] === "\n") {
        valid = false
        break
      }
    }
    scan.at = at
    if (!valid || src[at] !== end) return undefined
    title = src.slice(spaced + 1, at)
    index = skipBlanks(src, at + 1)
  } else index = spaced
  scan.at = index
  if (src[index] !== ")") return undefined
  return { label: src.slice(open + 1, close), url: unescape(address), title: unescape(title), end: index + 1 }
}

/** Link text as marked shows it inside a link: images become their alt text (a link cannot hold another). */
function linkText(src: string, work: LinkWork): string {
  let out = ""
  for (let index = 0; index < src.length; ) {
    const char = src[index]!
    if (char === "\\" && isEscapable(src[index + 1])) {
      out += src.slice(index, index + 2)
      index += 2
    } else if (char === "`") {
      const end = codeSpanEnd(src, index)
      const stop = end === -1 ? runEnd(src, index, "`") : end
      out += src.slice(index, stop)
      index = stop
    } else {
      const image = char === "!" && src[index + 1] === "[" ? parseLink(src, index + 1, work) : undefined
      if (image) {
        out += linkText(image.label, work)
        index = image.end
      } else {
        out += char
        index++
      }
    }
  }
  return out
}

// The app's inline math (packages/ui/src/context/marked-parser.tsx `inlineDollarMathRegex`, `inlineParenMathRegex`),
// with the `$$` and `$` alternatives of the first tried one after the other, as its alternation does.
const DISPLAY_MATH = /\$\$(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\$\$/y
const DOLLAR_MATH = /\$(?=[^\s$])((?:\\.|[^\\\n$])*?(?:\\\S|[^\s\\$]))\$(?!\w)/y
const PAREN_MATH = /\\\(((?:\\.|[^\\\n])*?)\\\)/y

/**
 * Where a `$$…$$` or `\(…\)` body that starts at `from` stops at the latest: at a line break, or a backslash before
 * one (both patterns read a body as escapes and characters other than a backslash or a line break).
 */
function bodyStop(src: string, from: number): number {
  let index = from
  while (index < src.length && src[index] !== "\n") {
    if (src[index] !== "\\") index++
    else if (/[^\n\r\u2028\u2029]/.test(src[index + 1] ?? "\n")) index += 2
    else break
  }
  return index
}

// marked's autolinks: `<scheme:…>` and `<address@host>` (marked 18, src/rules.ts `autolink`).
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\u0000-\u001f]*)>/y
const EMAIL_AUTOLINK =
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/y
// marked's GFM bare URL (marked 18, src/rules.ts `url`): a scheme or `www.` and a host character, then everything up to
// a space or `<`. Unlike marked, a bare URL here also stops at `|`: in a table row, marked splits the cells first.
const BARE_URL_START = /(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)[a-zA-Z0-9-]/y
const BARE_URL_REST = /[^\s<|]*/y
/** The characters marked's `_backpedal` gives back at the end of a bare URL. */
const TRAILING = "?!.,:;*_'\"~)"
const ENTITY_NAME = /^[a-zA-Z0-9]+$/

/**
 * Where the bare URL `src[start, end)` ends once it has given back trailing punctuation as marked's does: marked 18
 * (src/Tokenizer.ts `url`) applies `_backpedal`, `(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+`,
 * again until nothing changes, which takes a pass per character given back. This reads the URL once instead: the
 * first pass as that pattern reads it, then what the later passes do, which only depends on its last parts: a run of
 * trailing punctuation goes, a character a pass, and `&name;` goes when it ends the URL. `lastClose` is the last `)`
 * before `end` (or -1), so an unclosed `(` is known without a scan to the end.
 */
function backpedal(src: string, start: number, end: number, lastClose: number): number {
  type Part = { readonly kind: "text" | "group" | "amp" | "trailing"; readonly start: number }
  const parts: Part[] = []
  let index = start
  while (index < end) {
    const char = src[index]!
    let next = -1
    let kind: Part["kind"] = "text"
    if (char === "(") {
      if (lastClose > index) [next, kind] = [src.indexOf(")", index + 1) + 1, "group"]
    } else if (char === "&") {
      let name = index + 1
      while (name < end && /[a-zA-Z0-9]/.test(src[name]!)) name++
      const entity = name > index + 1 && name === end - 1 && src[name] === ";"
      if (!entity) [next, kind] = [index + 1, "amp"]
    } else if (TRAILING.includes(char)) {
      let stop = index
      while (stop < end && TRAILING.includes(src[stop]!)) stop++
      if (stop === end) stop--
      if (stop > index) [next, kind] = [stop, "trailing"]
    } else {
      next = index
      while (next < end && !TRAILING.includes(src[next]!) && src[next] !== "(" && src[next] !== "&") next++
    }
    if (next === -1) break
    parts.push({ kind, start: index })
    index = next
  }
  // The later passes, on what the first one kept.
  for (;;) {
    const last = parts.length - 1
    const part = parts[last]
    if (part?.kind !== "trailing") break
    if (
      index - part.start === 1 &&
      src[part.start] === ";" &&
      parts[last - 1]?.kind === "text" &&
      parts[last - 2]?.kind === "amp" &&
      ENTITY_NAME.test(src.slice(parts[last - 1]!.start, part.start))
    ) {
      index = parts[last - 2]!.start
      parts.length = last - 2
    } else if (index - part.start > 1) index--
    else {
      index = part.start
      parts.length = last
    }
  }
  return index
}

/**
 * The end of the inline math (`$…$`, `$$…$$` or `\(…\)`) that starts at an index of `src`, or -1, as the app's
 * patterns read it. Calls come in increasing order of index: a `$$…$$` or `\(…\)` that does not close from one start
 * does not close from any later start before where its body stopped either (the bodies read the same characters from
 * there on), so each line is read once for each kind instead of once for each start.
 */
export function mathScanner(src: string): (index: number) => number {
  let displayFails = -1
  let parenFails = -1
  return (index) => {
    if (src[index] === "\\") {
      if (src[index + 1] !== "(" || index + 2 <= parenFails) return -1
      PAREN_MATH.lastIndex = index
      const match = PAREN_MATH.exec(src)
      if (match) return index + match[0].length
      parenFails = bodyStop(src, index + 2)
      return -1
    }
    if (src[index] !== "$") return -1
    if (src[index + 1] === "$" && src[index + 2] !== "$" && index + 2 > displayFails) {
      DISPLAY_MATH.lastIndex = index
      const match = DISPLAY_MATH.exec(src)
      if (match) return index + match[0].length
      displayFails = bodyStop(src, index + 2)
    }
    DOLLAR_MATH.lastIndex = index
    const match = DOLLAR_MATH.exec(src)
    return match ? index + match[0].length : -1
  }
}

/**
 * The end of the bare URL marked links at an index of `src` (once it has given back trailing punctuation), or -1. The
 * run of URL characters it is in, and that run's last `)`, are kept for the next call, so bare URLs that start in the
 * part of a run an earlier one gave back do not read the run again.
 */
export function bareUrlScanner(src: string): (index: number) => number {
  let run = { start: -1, end: -1, lastClose: -1 }
  return (index) => {
    BARE_URL_START.lastIndex = index
    if (!BARE_URL_START.test(src)) return -1
    if (index < run.start || index >= run.end) {
      BARE_URL_REST.lastIndex = index
      const end = index + BARE_URL_REST.exec(src)![0].length
      let lastClose = -1
      for (let at = index; at < end; at++) if (src[at] === ")") lastClose = at
      run = { start: index, end, lastClose }
    }
    return backpedal(src, index, run.end, run.lastClose)
  }
}

/** A reference definition of the text, by its label as `definitionKey` reads it: the first one of a label counts. */
type Definitions = ReadonlyMap<string, { readonly url: string; readonly title: string }>

/** A reference label as marked matches it: case-insensitive, runs of whitespace as one space. */
const definitionKey = (label: string) => label.trim().toLowerCase().replace(/\s+/g, " ")

/**
 * A reference image whose `[` is at `open` (`![alt][label]`, `![alt][]` or `![alt]`) when its label is defined in the
 * text: the alt text, the definition's address and title, and where it ends.
 */
function referenceImage(src: string, open: number, work: LinkWork, definitions: Definitions): ParsedLink | undefined {
  const close = closingBracket(src, open, work)
  if (close === -1) return undefined
  const label = src.slice(open + 1, close)
  if (src[close + 1] === "[") {
    const end = closingBracket(src, close + 1, work)
    // (The reference goes; across a line break, that would join lines.)
    const reference = end === -1 || src.slice(close + 1, end).includes("\n") ? undefined : src.slice(close + 2, end)
    const found = reference === undefined ? undefined : definitions.get(definitionKey(reference || label))
    if (found) return { label, ...found, end: end + 1 }
  }
  const found = definitions.get(definitionKey(label))
  return found && { label, ...found, end: close + 1 }
}

/** Rewrites the links, images, autolinks and bare URLs of a prose run (step 2), defusing everything else (step 1). */
/**
 * One paragraph through steps 1 and 2. The emphasis delimiters `plain` marks are written as character references (and
 * all of them in a link's text after the first one marked), and math past what is left of `budget.math` as text (see
 * MarkdownBudget).
 */
function inline(
  src: string,
  imageLabel: string,
  definitions: Definitions,
  plain: Uint8Array | undefined,
  budget: MarkdownBudget,
): string {
  let out = ""
  let pending = ""
  const flush = (before: "link" | "math" | "end") => {
    let text = defuse(pending)
    pending = ""
    if (before === "link") {
      // `!` or an odd backslash right before genui's `[` would make it an image, or escape it.
      if (text.endsWith("!")) text += JOINER
      if (endsEscaping(text)) text += "\\"
    }
    out += text
  }
  const link = (label: string, url: string, title = "") => {
    flush("link")
    const target = safeUrl(url, "link") ?? ""
    out += `[${label}](${LINK_PREFIX}${encodeTarget(target)}${titlePart(target, title)})`
  }
  /** The model's link text: defused, and never ending in a backslash that would escape genui's `]`. */
  const label = (text: string, plain: boolean) => {
    const defused = defuse(plain ? plainDelimiters(text) : text)
    return endsEscaping(defused) ? `${defused}\\` : defused
  }

  // Whether the budget ran out before `index` (the first marked character comes before it).
  const firstPlain = plain ? plain.indexOf(1) : -1
  const past = (index: number) => firstPlain >= 0 && index >= firstPlain
  const mathEnd = mathScanner(src)
  const bareUrlEnd = bareUrlScanner(src)
  const work = linkWork(src)
  let escapes = 0

  for (let index = 0; index < src.length; ) {
    const char = src[index]!
    if (char === "$" || (char === "\\" && src[index + 1] === "(")) {
      const end = mathEnd(index)
      if (end > index) {
        const cost = end - index + MATH_SPAN_COST
        if (budget.math >= cost) {
          budget.math -= cost
          flush("math")
          out += defuseMath(src.slice(index, end))
        } else pending += mathAsText(src.slice(index, end))
        index = end
        continue
      }
    }
    if (char === "\\") {
      const next = src[index + 1]
      const length = isEscapable(next) ? 2 : 1
      // Past the paragraph's first MAX_ESCAPES, a backslash (or the character it escapes) is written as a character
      // reference, which shows the same and is no token for the renderer. A backslash before a line break stays.
      if (++escapes > MAX_ESCAPES && next !== "\n") pending += length === 2 ? `&#${next!.charCodeAt(0)};` : "&#92;"
      else pending += src.slice(index, index + length)
      index += length
      continue
    }
    if (char === "`") {
      const end = codeSpanEnd(src, index)
      const stop = end === -1 ? runEnd(src, index, "`") : end
      pending += src.slice(index, stop)
      index = stop
      continue
    }
    if (char === "<") {
      AUTOLINK.lastIndex = EMAIL_AUTOLINK.lastIndex = index
      const auto = AUTOLINK.exec(src)
      const email = auto ? null : EMAIL_AUTOLINK.exec(src)
      if (auto || email) {
        const text = (auto ?? email)![1]!
        link(literal(text), auto ? text : `mailto:${text}`)
        index += (auto ?? email)![0].length
        continue
      }
    }
    if (char === "[" || (char === "!" && src[index + 1] === "[")) {
      const image = char === "!"
      // A reference image becomes a link here too (marked would show its `!`, then a reference link).
      const parsed =
        parseLink(src, image ? index + 1 : index, work) ??
        (image ? referenceImage(src, index + 1, work, definitions) : undefined)
      if (parsed) {
        const text = linkText(parsed.label, work)
        link(image && !text.trim() ? literal(imageLabel) : label(text, past(index)), parsed.url, parsed.title)
        index = parsed.end
        continue
      }
    }
    if (/[hHfFw]/.test(char)) {
      const end = bareUrlEnd(index)
      if (end > index) {
        const url = src.slice(index, end)
        link(literal(url), url.startsWith("www.") ? `http://${url}` : url)
        index = end
        continue
      }
    }
    pending += plain?.[index] ? REFERENCES[char] : char
    index++
  }
  flush("end")
  return out
}

/**
 * Which characters of a paragraph inline() writes as character references: the opening emphasis runs past what
 * `budget.emphasis` pays for, which it charges (undefined: none). An opening run is a run of `*`, `_` or `~` that marked
 * could take as opening emphasis (left-flanking, and for `_` not after a letter or digit); marked then scans the
 * runs of that character after it for its closing run. When the next one is a run of the same length that can only
 * close, the scan ends there, and the run costs 1 and a 50th of the characters in between; otherwise it costs every
 * run of that character after it and a 50th of the rest of the paragraph. Runs that can only close cost nothing (marked
 * scans from none), so they stay, and close the openers that were paid for.
 */
function emphasisCutoff(text: string, budget: MarkdownBudget): Uint8Array | undefined {
  interface Run {
    readonly index: number
    readonly length: number
    readonly char: string
    readonly opens: boolean
    readonly onlyCloses: boolean
  }
  const runs: Run[] = []
  for (let index = 0; index < text.length; ) {
    const char = text[index]!
    if (char === "`") {
      // Code spans hold no delimiters.
      const end = codeSpanEnd(text, index)
      index = end === -1 ? runEnd(text, index, "`") : end
      continue
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      index++
      continue
    }
    const end = runEnd(text, index, char)
    const before = index > 0 ? charBefore(text, index) : undefined
    const after = end < text.length ? charAt(text, end) : undefined
    const left =
      after !== undefined &&
      !SPACE.test(after) &&
      (!PUNCTUATION.test(after) || before === undefined || SPACE_OR_PUNCTUATION.test(before))
    const right =
      before !== undefined &&
      !SPACE.test(before) &&
      (!PUNCTUATION.test(before) || after === undefined || SPACE_OR_PUNCTUATION.test(after))
    const opens = left && !(char === "_" && before !== undefined && ALPHANUMERIC.test(before))
    runs.push({ index, length: end - index, char, opens, onlyCloses: right && !left })
    index = end
  }
  // For each run, the next run of the same character and how many such runs follow it.
  const next: (Run | undefined)[] = []
  const following: number[] = []
  const seen = new Map<string, { run: Run; count: number }>()
  for (let at = runs.length - 1; at >= 0; at--) {
    const run = runs[at]!
    const later = seen.get(run.char)
    next[at] = later?.run
    following[at] = later?.count ?? 0
    seen.set(run.char, { run, count: (later?.count ?? 0) + 1 })
  }
  let cutoff = -1
  for (let at = 0; at < runs.length; at++) {
    const run = runs[at]!
    if (!run.opens) continue
    const closer = next[at]
    const cost =
      closer && closer.onlyCloses && closer.length === run.length
        ? 1 + Math.ceil((closer.index - run.index) / 50)
        : following[at]! + Math.ceil((text.length - run.index) / 50)
    if (cost > budget.emphasis) {
      cutoff = at
      break
    }
    budget.emphasis -= cost
  }
  if (cutoff < 0) return undefined
  const plain = new Uint8Array(text.length)
  for (let at = cutoff; at < runs.length; at++) {
    const run = runs[at]!
    if (run.opens) plain.fill(1, run.index, run.index + run.length)
  }
  return plain
}

const SPACE = /\s/u
const PUNCTUATION = /[\p{P}\p{S}]/u
const SPACE_OR_PUNCTUATION = /[\s\p{P}\p{S}]/u
const ALPHANUMERIC = /[\p{L}\p{N}]/u

/** The character (a whole code point) at `index`, and the one that ends right before `index`. */
const charAt = (text: string, index: number) => String.fromCodePoint(text.codePointAt(index)!)
function charBefore(text: string, index: number): string {
  const low = text.charCodeAt(index - 1)
  return low >= 0xdc00 && low <= 0xdfff && index >= 2 ? charAt(text, index - 2) : text[index - 1]!
}

// A reference definition on a line of its own: `[label]: address "title"` (the title on the same line).
const DEFINITION =
  /^( {0,3})\[((?:\\[\s\S]|[^\\[\]])+)\]:[ \t]*(?:<((?:\\.|[^\\<>\n])*)>|(\S+))(?:[ \t]+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?[ \t]*$/

/** A definition (a row's text as marked reads it, see Sink.definitions) as genui writes it again. */
function definitionText(match: RegExpExecArray): string {
  const target = safeUrl(unescape(match[3] ?? match[4]!), "link") ?? ""
  const title = match[5] ? unescape(match[5].slice(1, -1)) : ""
  return `${match[1]}[${defuse(match[2]!)}]: ${LINK_PREFIX}${encodeTarget(target)}${titlePart(target, title, '"')}`
}

/**
 * A prose run: the definitions marked reads in it written again (`rowDefinitions`, by row from `first`), the rest
 * through `inline`, a paragraph at a time (inline syntax never crosses a blank line, and the emphasis budget is per
 * paragraph's scans).
 */
function prose(
  lines: readonly string[],
  first: number,
  rowDefinitions: ReadonlyMap<number, string>,
  imageLabel: string,
  definitions: Definitions,
  budget: MarkdownBudget,
): string {
  const out: string[] = []
  let run: string[] = []
  const paragraph = (text: string) => inline(text, imageLabel, definitions, emphasisCutoff(text, budget), budget)
  const flush = () => {
    let start = 0
    for (let index = 0; index <= run.length; index++) {
      if (index < run.length && run[index]!.trim() !== "") continue
      if (index > start) out.push(paragraph(run.slice(start, index).join("\n")))
      if (index < run.length) out.push(run[index]!)
      start = index + 1
    }
    run = []
  }
  lines.forEach((line, index) => {
    const text = rowDefinitions.get(first + index)
    const match = text === undefined ? null : DEFINITION.exec(text)
    if (match && text !== undefined) {
      flush()
      out.push(line.slice(0, line.length - text.length) + definitionText(match))
    } else run.push(line)
  })
  flush()
  return out.join("\n")
}

/**
 * Markdown that the app renders with no remote content and no markup of the model's: images, links, autolinks and
 * bare URLs become links to `#genui-link:` fragments that MarkdownText opens through the link policy, and every other
 * construct that could make a link, image or tag is broken with an invisible joiner (see the top of this file).
 * `imageLabel` is the link text for an image without alt text.
 */
export function neutralizeMarkdown(
  text: string,
  imageLabel: string,
  budget: MarkdownBudget = markdownBudget(text.length),
): string {
  const lines = text.split("\n")
  try {
    return neutralizeLines(lines, imageLabel, budget, partModel(lines)).join("\n")
  } finally {
    spanCache.clear()
    bracketCache.clear()
  }
}

/** What the model finds in one part's lines (see Sink): what each row is, and the structure it reads. */
interface PartModel {
  readonly kinds: Uint8Array
  readonly starts: Uint8Array
  readonly definitions: ReadonlyMap<number, string>
  readonly sink: Sink
  /** The row of the top-level block where the model stopped, on text built to make it slow (-1: it did not). */
  readonly stopped: number
}

/** What marked makes of each row (see Sink): its kind, whether it starts a code or math block, its definitions. */
function partModel(lines: readonly string[]): PartModel {
  const kinds = new Uint8Array(lines.length)
  const starts = new Uint8Array(lines.length)
  const sink = new Sink(lines, kinds, starts)
  work.modeled += lines.length
  let chars = 0
  for (const line of lines) chars += line.length + 1
  const lexer = new BlockLexer(sink, modelLimit(chars, lines.length))
  try {
    lexer.lex(lines.map((t, r) => ({ t, r })))
    return { kinds, starts, definitions: sink.definitions, sink, stopped: -1 }
  } catch (error) {
    // Text built to make the model slow: all prose (written again, and defused, as such).
    if (!(error instanceof Abort)) throw error
    kinds.fill(PROSE)
    starts.fill(0)
    return { kinds, starts, definitions: new Map<number, string>(), sink, stopped: lexer.topRow }
  }
}

const BLOCK_TYPES: Readonly<Record<string, number>> = {
  heading: 2,
  hr: 3,
  cell: 5,
  paragraph: 6,
  blockquote: 7,
  item: 8,
}

/**
 * The structure the model read in a part, as (row, event) pairs sorted by row (events of a row in the order they were
 * found): each inline run's first row and the rows added to it, code and math blocks, blocks (type and count; a math
 * block is its rows), nesting past MAX_NESTING, and each row's kind.
 */
function structureEvents(model: PartModel, rowCount: number): { rows: Int32Array; events: Float64Array } {
  const { sink, kinds, starts } = model
  const rowList: number[] = []
  const eventList: number[] = []
  const add = (row: number, event: number) => {
    rowList.push(Math.max(0, Math.min(rowCount, row)))
    eventList.push(event)
  }
  for (const run of sink.runs) add(run.row, 1)
  for (const row of sink.appended) add(row, 2)
  for (const row of sink.codeRows) add(row, 3)
  for (const row of sink.mathRows) add(row, 4)
  for (const row of sink.nestRows) add(row, 5)
  sink.blockRows.forEach((row, index) => {
    const type = sink.blockTypes[index]!
    if (type !== "math") add(row, 16 + (BLOCK_TYPES[type] ?? 15) + 16 * sink.blockCounts[index]!)
  })
  for (let row = 0; row < rowCount; row++) if (kinds[row] || starts[row]) add(row, 8 + 2 * kinds[row]! + starts[row]!)
  // Sorted by row, stably.
  const firsts = new Int32Array(rowCount + 2)
  for (const row of rowList) firsts[row + 1]!++
  for (let row = 0; row <= rowCount; row++) firsts[row + 1]! += firsts[row]!
  const rows = new Int32Array(rowList.length)
  const events = new Float64Array(rowList.length)
  rowList.forEach((row, index) => {
    const at = firsts[row]!++
    rows[at] = row
    events[at] = eventList[index]!
  })
  return { rows, events }
}

/**
 * Whether an event of a part as written (`was`) is the same one neutralized (`is`): display math genui writes as a code
 * block past the math budget (see `mathGroup`) is one, as the model reads it (and costs the same); nothing else is.
 */
const sameEvent = (was: number, is: number) =>
  was === is || (was === 4 && is === 3) || ((was === 8 + 2 * MATH || was === 9 + 2 * MATH) && is === was - 2)

/**
 * The first row where the model reads a part as written (`a`) and neutralized (`b`) differently (-1: it reads them
 * alike).
 */
function divergence(a: PartModel, b: PartModel, rowCount: number): number {
  const x = structureEvents(a, rowCount)
  const y = structureEvents(b, rowCount)
  const length = Math.min(x.rows.length, y.rows.length)
  for (let index = 0; index < length; index++)
    if (x.rows[index] !== y.rows[index] || !sameEvent(x.events[index]!, y.events[index]!))
      return Math.min(x.rows[index]!, y.rows[index]!)
  if (x.rows.length !== y.rows.length) return (x.rows.length > length ? x.rows : y.rows)[length]!
  return -1
}

/**
 * How the model reads a part's lines neutralized (`rows`): that reading (`read`; the one as written, `model` of
 * `lines`, when neutralizing changed no line), and the first row where it reads them otherwise than as written
 * (`diverges`, -1: nowhere). Neutralizing lengthens lines (a joiner, a link written again, a character reference),
 * and marked decides some structure by a line's length or by the characters at a column (a list item's lazy lines):
 * read otherwise, a line neutralized as code could reach marked's inline lexer past every budget, or a code block
 * marked renders go uncounted. And marked's setext and lazy-line scans read the lengthened lines character by
 * character, so its block work is tallied on this reading (see `checkedParts`).
 */
function readNeutralized(
  lines: readonly string[],
  model: PartModel,
  rows: readonly string[],
): { readonly read: PartModel; readonly diverges: number } {
  if (model.stopped >= 0) return { read: model, diverges: model.stopped }
  // (Neutralizing keeps every line: no line break is added or taken away.)
  if (rows.length !== lines.length) return { read: model, diverges: 0 }
  let changed = false
  for (let row = 0; row < rows.length && !changed; row++) changed = rows[row] !== lines[row]
  if (!changed) return { read: model, diverges: -1 }
  const read = partModel(rows)
  return { read, diverges: read.stopped >= 0 ? read.stopped : divergence(model, read, rows.length) }
}

/** Where each of `rows` starts in them joined with "\n", and their length so joined. */
function joinedStarts(rows: readonly string[]): { readonly starts: number[]; readonly length: number } {
  const starts: number[] = []
  let at = 0
  for (const row of rows) {
    starts.push(at)
    at += row.length + 1
  }
  return { starts, length: Math.max(0, at - 1) }
}

/** The lines a cut text ends with, after the line break before the cut (see `checkedParts`). */
const ENDING = ["", "", "…"] as const

/** The event of a paragraph block (see `structureEvents`). */
const PARAGRAPH_EVENT = 16 + BLOCK_TYPES.paragraph! + 16

/**
 * Whether the model reads `rows`, a part's first `keep` rows neutralized and then ENDING, as it read those rows in the
 * part as written (`model`), with the "…" a paragraph of its own, or gone (marked's blockquote loses the lines after a
 * list it lexes again with lazy lines; MarkdownText's note still says the text is cut): so the rows before the cut are
 * the ones the first reading checked, and cutting there changed nothing in them (no block before the cut was decided
 * by a line after it).
 */
function readsAsCut(model: PartModel, rows: readonly string[], keep: number): boolean {
  const read = partModel(rows)
  if (read.stopped >= 0) return false
  const was = structureEvents(model, model.kinds.length)
  const is = structureEvents(read, rows.length)
  let before = 0
  while (before < was.rows.length && was.rows[before]! < keep) before++
  if (is.rows.length !== before + 2 && is.rows.length !== before) return false
  for (let index = 0; index < before; index++)
    if (is.rows[index] !== was.rows[index] || !sameEvent(was.events[index]!, is.events[index]!)) return false
  if (is.rows.length === before) return true
  const dots = keep + ENDING.length - 1
  return (
    is.rows[before] === dots &&
    is.events[before] === 1 &&
    is.rows[before + 1] === dots &&
    is.events[before + 1] === PARAGRAPH_EVENT
  )
}

/**
 * Where a part is cut at its row `row` (a row of the part): at the first row of a setext heading or display math the
 * row is inside of, and before the header of a table whose delimiter row it is (cut there, those rows would be lexed
 * again as other blocks).
 */
function settleRow(model: PartModel, lines: readonly string[], row: number): number {
  const first = new Int32Array(lines.length + 1).fill(-1)
  const spans = model.sink.spans
  for (let index = 0; index < spans.length; index += 2)
    for (let at = spans[index]! + 1; at <= spans[index + 1]! && at <= lines.length; at++)
      if (first[at]! < 0 || first[at]! > spans[index]!) first[at] = spans[index]!
  let at = Math.max(0, Math.min(row, lines.length))
  for (;;) {
    if (first[at]! >= 0 && first[at]! < at) at = first[at]!
    else if (at > 0 && /[:|]/.test(lines[at] ?? "") && DELIMITER_ROW.test(lines[at]!)) at--
    else return at
  }
}

/** A line ending in `<…>`: marked's setext rule stops at one (see neutralizeLines). */
const TAG_LINE = /<[^>]*>$/

/** A part's lines neutralized as the model reads them (`model`), as rows (as many as the lines). */
function neutralizeLines(
  lines: readonly string[],
  imageLabel: string,
  budget: MarkdownBudget,
  model: PartModel,
): string[] {
  const { kinds, starts, definitions: rowDefinitions } = model
  work.neutralized += lines.length
  // A reference may come before its definition: all of the text's definitions are read first.
  const definitions = new Map<string, { url: string; title: string }>()
  for (const text of rowDefinitions.values()) {
    const match = DEFINITION.exec(text)
    const key = match && definitionKey(match[2]!)
    if (match && key && !definitions.has(key))
      definitions.set(key, {
        url: unescape(match[3] ?? match[4]!),
        title: match[5] ? unescape(match[5].slice(1, -1)) : "",
      })
  }
  const out: string[] = []
  for (let start = 0; start < lines.length; ) {
    let end = start + 1
    while (end < lines.length && kinds[end] === kinds[start] && !starts[end]) end++
    const group = lines.slice(start, end)
    const kind = kinds[start]
    out.push(
      kind === PROSE || kind === DEF
        ? prose(group, start, rowDefinitions, imageLabel, definitions, budget)
        : kind === MATH
          ? mathGroup(group, budget)
          : defuse(group.join("\n")),
    )
    start = end
  }
  // marked's setext rule stops at a line `<…>` (a tag genui broke still is one), unless genui wrote it as a link: so
  // that the model, which takes no line for one, matches what marked reads, such a line ends with a joiner.
  const rows = out.join("\n").split("\n")
  for (let row = 0; row < rows.length; row++)
    if (kinds[row] !== CODE && kinds[row] !== MATH && kinds[row] !== DEF && TAG_LINE.test(rows[row]!))
      rows[row] += JOINER
  return rows
}

/**
 * A display-math block or a math fence, as math while the budget pays for it; past that, as a code block of its own
 * (a math fence named "text", a `$$` block written as a fence longer than any backtick run in it), so that it stays one
 * block and no line of it reads as Markdown. Each counts as a code block in the render budget either way.
 */
function mathGroup(lines: readonly string[], budget: MarkdownBudget): string {
  const text = lines.join("\n")
  const cost = text.length + MATH_SPAN_COST
  if (budget.math >= cost) {
    budget.math -= cost
    return defuseMath(text)
  }
  const first = lines[0] ?? ""
  const fence = /(`{3,}|~{3,})[ \t]*(?:math|latex)(?!\S)/i.exec(first)
  if (fence) {
    const named = `${first.slice(0, fence.index)}${fence[1]}text${first.slice(fence.index + fence[0].length)}`
    return defuse([named, ...lines.slice(1)].join("\n"))
  }
  let longest = 2
  for (const line of lines) for (const run of line.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  const marker = "`".repeat(longest + 1)
  const delimiter = first.endsWith("$$") ? "$$" : "$"
  const written = lines.map((line, index) =>
    (index === 0 || index === lines.length - 1) && line.endsWith(delimiter)
      ? `${line.slice(0, line.length - delimiter.length)}${marker}${index === 0 ? "text" : ""}`
      : line,
  )
  return defuse(written.join("\n"))
}

/** What MarkdownText renders of a text (see `renderMarkdown`): how much of it shows, and why not all, and its parts. */
export interface RenderedMarkdown {
  readonly cut: MarkdownCut
  readonly parts: MarkdownPart[]
}

/**
 * A model-written Markdown text as MarkdownText hands it to the renderer: what `markdownShape` lets show, as parts (see
 * `splitMarkdown`), the prose ones neutralized, sharing one budget (see MarkdownBudget), so splitting a text into parts
 * gains nothing. A cut text ends with "…". What it hands the renderer is what the model checked (see `checkedParts`):
 * where the model would read the neutralized text otherwise than the text as written, it shows less, cut with reason
 * `lines`, and where marked's block work on the neutralized text passes MAX_BLOCK_WORK (neutralizing lengthens lines,
 * a `www.` address tenfold, and marked's scans read them by the character), with reason `work`. That is only ever less
 * than `markdownShape` charged for: the parts it hands the renderer are read as the model read the text as written, up
 * to the cut.
 *
 * It runs only for a text that renders. Its work is the model's reading of the parts as written and neutralized, and
 * neutralizing them once (see `checkedParts`): 0.15 to 0.45 s for 500,000 characters of links, in the task that
 * renders the element, which the render budget's slice gives such an element alone (see TASK_UNITS in
 * src/runtime/budget.ts).
 * `imageLabel` is the link text for an image without alt text.
 */
export function renderMarkdown(text: string, imageLabel: string): RenderedMarkdown {
  const cut = markdownShape(text).cut
  const known = prepared.get(text)
  if (known && known.label === imageLabel && known.model === cut.shown) {
    prepared.delete(text)
    prepared.set(text, known)
    return known.rendered
  }
  const checked = checkedParts(text, cut.shown, imageLabel)
  const rendered: RenderedMarkdown = {
    cut: checked.shown < cut.shown && checked.reason ? { shown: checked.shown, reason: checked.reason } : cut,
    parts: checked.parts,
  }
  keepRendered(text, imageLabel, cut.shown, rendered)
  return rendered
}

/**
 * The parts MarkdownText hands the renderer for a text (see `renderMarkdown`); given a `cut` other than the one
 * `markdownShape` finds, of the text's first `cut.shown` characters, checked all the same.
 */
export function prepareMarkdown(text: string, imageLabel = "Image", cut?: MarkdownCut): MarkdownPart[] {
  if (cut === undefined || cut.shown === markdownShape(text).cut.shown) return renderMarkdown(text, imageLabel).parts
  return checkedParts(text, cut.shown, imageLabel).parts
}

/**
 * What `renderMarkdown` made of recent texts, for at most SHAPE_CACHE_SIZE texts and SHAPE_CACHE_CHARS characters of
 * texts and parts (and the newest): a text renders again when its element remounts, or in each row of a repeat.
 */
const prepared = new Map<
  string,
  {
    readonly label: string
    readonly model: number
    readonly rendered: RenderedMarkdown
    readonly chars: number
  }
>()
let preparedChars = 0

/** What `renderMarkdown` keeps of how many texts, and of how many characters (for tests). */
export const preparedCache = (): { readonly texts: number; readonly chars: number } => ({
  texts: prepared.size,
  chars: preparedChars,
})

function keepRendered(text: string, label: string, model: number, rendered: RenderedMarkdown) {
  const old = prepared.get(text)
  if (old) {
    prepared.delete(text)
    preparedChars -= old.chars
  }
  let chars = text.length
  for (const part of rendered.parts) chars += part.kind === "code" ? part.code.length : part.text.length
  prepared.set(text, { label, model, rendered, chars })
  preparedChars += chars
  for (const [oldest, entry] of prepared) {
    if (oldest === text || (prepared.size <= SHAPE_CACHE_SIZE && preparedChars <= SHAPE_CACHE_CHARS)) break
    prepared.delete(oldest)
    preparedChars -= entry.chars
  }
}

/**
 * The parts the renderer gets of a text's first `shown` characters, and how many characters of the text they show: the
 * parts of what shows, the prose ones neutralized, each checked (see `firstDivergence`). Where the model reads a part
 * neutralized otherwise than as written, the text is cut at the start of that row (see `settleRow`): the parts before
 * it stay as they are (each is lexed on its own, and the budget is spent in order, so a cut after them changes
 * nothing), and so do the part's rows before the cut, neutralized as they were. Those rows, then the lines a cut text
 * ends with, are read once more, and must read as they did as written (see `readsAsCut`); if they do not, the text is
 * cut at the start of the part. So marked gets only text whose blocks, runs and code blocks are the ones the model
 * counted and cut by, and whose every line it lexes inline was written as prose (within the emphasis, escape and math
 * budgets).
 *
 * marked's block work is tallied on the parts as it gets them, neutralized, sharing MAX_BLOCK_WORK in their order (the
 * model's cut tallied it on the text as written, and neutralizing lengthens lines that marked's scans read by the
 * character): where it passes the bound, the text is cut the same way, with reason `work`.
 *
 * Its work: the model reads each part as written and neutralized, and neutralizes it once; a cut part is read once
 * more, up to the cut, and nothing is neutralized again.
 */
function checkedParts(
  text: string,
  shown: number,
  imageLabel: string,
): { shown: number; parts: MarkdownPart[]; reason?: "lines" | "work" } {
  // marked reads "\r\n" and "\r" as "\n" (see textRows): the rows before the cut are the text's.
  const source = (shown < text.length ? `${text.slice(0, shown)}\n\n…` : text).replace(/\r\n?/g, "\n")
  const lines = source.split("\n")
  const budget = markdownBudget(source.length)
  const parts: MarkdownPart[] = []
  // marked's block work on the parts before this one, as it gets them.
  let spent = 0
  for (const segment of fenceSegments(lines)) {
    if (segment.code) {
      parts.push(codePart(lines, segment.from, segment.to, segment.code))
      continue
    }
    const part = lines.slice(segment.from, segment.to)
    if (part.join("\n").trim() === "") continue
    try {
      const model = partModel(part)
      const rows = neutralizeLines(part, imageLabel, budget, model)
      const { read, diverges } = shown > 0 ? readNeutralized(part, model, rows) : { read: model, diverges: -1 }
      const joined = joinedStarts(rows)
      const over = workPast(read.sink, rows, joined.starts, joined.length, MAX_BLOCK_WORK - spent)
      // The first row the model reads otherwise, or where marked's work passes the bound.
      let row = diverges
      let reason: "lines" | "work" = "lines"
      if (over.row >= 0 && (row < 0 || over.row < row)) [row, reason] = [over.row, "work"]
      if (row < 0) {
        spent += over.work
        parts.push({ kind: "markdown", text: rows.join("\n") })
        continue
      }
      // At the start of that row, a row of the text (the last row before the cut at the latest; the lines a cut text
      // ends with are the same neutralized).
      const { starts } = textRows(text)
      const last = rowAt(starts, shown - 1)
      if (segment.from > last) {
        parts.push({ kind: "markdown", text: rows.join("\n") })
        continue
      }
      const keep = settleRow(model, part, Math.min(row, last - segment.from))
      const cut = [...rows.slice(0, keep), ...ENDING]
      if (readsAsCut(model, cut, keep)) {
        parts.push({ kind: "markdown", text: cut.join("\n") })
        return { shown: starts[segment.from + keep]!, parts, reason }
      }
      parts.push({ kind: "markdown", text: ENDING.join("\n") })
      return { shown: starts[segment.from]!, parts, reason }
    } finally {
      spanCache.clear()
      bracketCache.clear()
    }
  }
  return { shown, parts }
}
