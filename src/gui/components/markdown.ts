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

import { safeUrl } from "../../protocol/url.ts"

/** U+2060 WORD JOINER: invisible, and breaks link, image and tag syntax apart for the parser. */
export const JOINER = "\u2060"

/** The href of every link genui hands the renderer starts with this, then the encoded address (see `linkTarget`). */
export const LINK_PREFIX = "#genui-link:"

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
 * Splits Markdown into prose and fenced code blocks: a fence with only whitespace before it, at the top level or
 * indented in a list item (its lines lose the fence's indentation). Math fences and fences that open after a quote or
 * list marker stay in the prose, up to and including their closing fence. An unclosed block runs to the end.
 */
export function splitMarkdown(text: string): MarkdownPart[] {
  const parts: MarkdownPart[] = []
  let prose: string[] = []
  let open: (Fence & { indent: string; language?: string; lines: string[] }) | undefined
  /** A fence kept in the prose (math, quoted, after a list marker), up to and including its closing fence. */
  let kept: Fence | undefined

  const flush = () => {
    const joined = prose.join("\n")
    if (joined.trim() !== "") parts.push({ kind: "markdown", text: joined })
    prose = []
  }
  const close = () => {
    if (!open) return
    const { language, lines } = open
    parts.push({ kind: "code", code: lines.join("\n"), ...(language ? { language } : {}) })
    open = undefined
  }

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (open) {
      if (closes(open, FENCE_CLOSE.exec(line))) close()
      else open.lines.push(dedent(line, open.indent))
      continue
    }
    if (kept) {
      if (closes(kept, NESTED_CLOSE.exec(line))) kept = undefined
      prose.push(line)
      continue
    }
    const nested = NESTED_FENCE.exec(line)
    const start = nested ? null : FENCE.exec(line)
    const fence = nested ? opening(nested[1], nested[2]!) : opening(start?.[2], start?.[3] ?? "")
    if (fence && start && !MATH_FENCES.has(languageOf(start[3]!).toLowerCase())) {
      flush()
      const language = languageOf(start[3]!)
      open = { ...fence, indent: start[1]!, ...(language ? { language } : {}), lines: [] }
      continue
    }
    if (fence) kept = fence
    prose.push(line)
  }
  close()
  flush()
  return parts
}

type LineKind = "prose" | "code" | "math"

/** A display-math block's opening line (`$` or `$$` alone, as the app's KaTeX extension reads it). */
const MATH_BLOCK = /^\${1,2}$/

/**
 * What each line of a prose text is. Nothing is rewritten in code and math (step 2 above): fenced blocks (math, quoted
 * or in a list item, or any other fence when the text was not split), indented code after a blank line, and display
 * math blocks.
 */
function lineKinds(lines: readonly string[]): LineKind[] {
  // Whether the same `$` or `$$` line comes later, computed once from the end (a search per line was quadratic).
  const closed: boolean[] = []
  const seen = new Set<string>()
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    closed[index] = seen.has(line)
    if (MATH_BLOCK.test(line)) seen.add(line)
  }
  const kinds: LineKind[] = []
  let fence: (Fence & { kind: LineKind }) | undefined
  let mathBlock: string | undefined
  let blank = true
  let indented = false
  for (const [index, line] of lines.entries()) {
    if (fence) {
      kinds.push(fence.kind)
      if (closes(fence, NESTED_CLOSE.exec(line))) fence = undefined
      blank = indented = false
      continue
    }
    if (mathBlock !== undefined) {
      kinds.push("math")
      if (line === mathBlock) mathBlock = undefined
      blank = indented = false
      continue
    }
    const nested = NESTED_FENCE.exec(line)
    const start = nested ? null : FENCE.exec(line)
    const open = nested ? opening(nested[1], nested[2]!) : opening(start?.[2], start?.[3] ?? "")
    if (open) {
      const math = !!start && MATH_FENCES.has(languageOf(start[3]!).toLowerCase())
      fence = { ...open, kind: math ? "math" : "code" }
      kinds.push(fence.kind)
      blank = indented = false
      continue
    }
    if (blank && MATH_BLOCK.test(line) && closed[index]) {
      mathBlock = line
      kinds.push("math")
      blank = indented = false
      continue
    }
    const empty = line.trim() === ""
    const isCode: boolean = !empty && /^(?: {4}| {0,3}\t)/.test(line) && (blank || indented)
    kinds.push(isCode ? "code" : "prose")
    indented = isCode || (indented && empty)
    blank = empty
  }
  return kinds
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

/** A link title as genui writes it: single-quoted, defused, on one line, with no `"` that could end the attribute. */
function titlePart(url: string, title: string): string {
  const own = title.replace(/\s+/g, " ").trim()
  const text = own && url ? `${own} (${url})` : own || url
  if (!text) return ""
  const safe = defuse(text.slice(0, MAX_TITLE))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll('"', "&#34;")
    .replace(/[\\'|]/g, "\\$&")
  return ` '${safe}'`
}

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/
const isEscapable = (char: string | undefined) => char !== undefined && ASCII_PUNCTUATION.test(char)

/**
 * Text (an address) that marked shows as written: defused, so it stays inert even as plain text, with the characters
 * that would start emphasis, code, math, a table cell, a link or an entity escaped.
 */
const literal = (text: string) => defuse(text).replace(/[\\`*_[\]<>~|!$]|&(?=#?\w+;)/g, "\\$&")

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

/** The rest of an inline link after its `](`: the address and title, and the closing `)`. `scan.at` is how far it read. */
function parseDestination(src: string, open: number, close: number, scan: { at: number }): ParsedLink | undefined {
  let index = skipSpace(src, close + 2)
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
  const spaced = skipSpace(src, index)
  const quote = src[spaced]
  if (spaced > index && (quote === '"' || quote === "'" || quote === "(")) {
    const end = quote === "(" ? ")" : quote
    let at = spaced + 1
    let valid = true
    for (; at < src.length && src[at] !== end; at++) {
      if (src[at] === "\\" && isEscapable(src[at + 1])) at++
      else if ((quote === "(" && src[at] === "(") || (src[at] === "\n" && blankAfter(src, at))) {
        valid = false
        break
      }
    }
    scan.at = at
    if (!valid || src[at] !== end) return undefined
    title = src.slice(spaced + 1, at)
    index = skipSpace(src, at + 1)
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
    const reference = end === -1 ? undefined : src.slice(close + 2, end)
    const found = reference === undefined ? undefined : definitions.get(definitionKey(reference || label))
    if (found) return { label, ...found, end: end + 1 }
  }
  const found = definitions.get(definitionKey(label))
  return found && { label, ...found, end: close + 1 }
}

/** Rewrites the links, images, autolinks and bare URLs of a prose run (step 2), defusing everything else (step 1). */
function inline(src: string, imageLabel: string, definitions: Definitions): string {
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
  const label = (text: string) => {
    const defused = defuse(text)
    return endsEscaping(defused) ? `${defused}\\` : defused
  }

  const mathEnd = mathScanner(src)
  const bareUrlEnd = bareUrlScanner(src)
  const work = linkWork(src)

  for (let index = 0; index < src.length; ) {
    const char = src[index]!
    if (char === "$" || (char === "\\" && src[index + 1] === "(")) {
      const end = mathEnd(index)
      if (end > index) {
        flush("math")
        out += defuseMath(src.slice(index, end))
        index = end
        continue
      }
    }
    if (char === "\\") {
      const length = isEscapable(src[index + 1]) ? 2 : 1
      pending += src.slice(index, index + length)
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
        link(image && !text.trim() ? literal(imageLabel) : label(text), parsed.url, parsed.title)
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
    pending += char
    index++
  }
  flush("end")
  return out
}

// A reference definition on a line of its own: `[label]: address "title"` (the title on the same line).
const DEFINITION =
  /^( {0,3})\[((?:\\[\s\S]|[^\\[\]])+)\]:[ \t]*(?:<((?:\\.|[^\\<>\n])*)>|(\S+))(?:[ \t]+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?[ \t]*$/

interface DefinitionLine {
  readonly indent: string
  readonly label: string
  readonly url: string
  readonly title: string
}

/**
 * The reference definitions of a prose group, by line (undefined for other lines): a definition cannot interrupt a
 * paragraph, so it starts the group, follows a blank line or follows another definition.
 */
function definitionLines(lines: readonly string[]): (DefinitionLine | undefined)[] {
  let previousBlank = true
  let previousDefinition = false
  return lines.map((line) => {
    const found: RegExpExecArray | null = previousBlank || previousDefinition ? DEFINITION.exec(line) : null
    const match: RegExpExecArray | null = found && /\S/.test(found[2]!) ? found : null
    previousDefinition = !!match
    previousBlank = line.trim() === ""
    if (!match) return undefined
    return {
      indent: match[1]!,
      label: match[2]!,
      url: unescape(match[3] ?? match[4]!),
      title: match[5] ? unescape(match[5].slice(1, -1)) : "",
    }
  })
}

/** A prose run: reference definitions written again, the rest through `inline`. */
function prose(lines: readonly string[], imageLabel: string, definitions: Definitions): string {
  const out: string[] = []
  let run: string[] = []
  const flush = () => {
    if (run.length > 0) out.push(inline(run.join("\n"), imageLabel, definitions))
    run = []
  }
  const found = definitionLines(lines)
  lines.forEach((line, index) => {
    const definition = found[index]
    if (definition) {
      flush()
      const target = safeUrl(definition.url, "link") ?? ""
      out.push(
        `${definition.indent}[${defuse(definition.label)}]: ${LINK_PREFIX}${encodeTarget(target)}${titlePart(target, definition.title)}`,
      )
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
export function neutralizeMarkdown(text: string, imageLabel: string): string {
  try {
    return neutralizeLines(text.split("\n"), imageLabel)
  } finally {
    spanCache.clear()
    bracketCache.clear()
  }
}

function neutralizeLines(lines: readonly string[], imageLabel: string): string {
  const kinds = lineKinds(lines)
  const groups: { readonly kind: (typeof kinds)[number]; readonly lines: readonly string[] }[] = []
  for (let start = 0; start < lines.length; ) {
    let end = start
    while (end < lines.length && kinds[end] === kinds[start]) end++
    groups.push({ kind: kinds[start]!, lines: lines.slice(start, end) })
    start = end
  }
  // A reference may come before its definition: all of the text's definitions are read first.
  const definitions = new Map<string, { url: string; title: string }>()
  for (const group of groups) {
    if (group.kind !== "prose") continue
    for (const definition of definitionLines(group.lines)) {
      const key = definition && definitionKey(definition.label)
      if (key && !definitions.has(key)) definitions.set(key, { url: definition.url, title: definition.title })
    }
  }
  return groups
    .map((group) =>
      group.kind === "prose"
        ? prose(group.lines, imageLabel, definitions)
        : group.kind === "math"
          ? defuseMath(group.lines.join("\n"))
          : defuse(group.lines.join("\n")),
    )
    .join("\n")
}
