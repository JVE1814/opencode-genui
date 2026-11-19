// Model-written Markdown made safe for the app's renderer (`ui.Markdown`), used by MarkdownText in content.tsx. Kept
// free of JSX so unit tests can run it against the app's own marked configuration (test/unit/markdown.test.ts).
//
// The app renders Markdown with marked, which turns `![alt](url)` into an <img> and passes raw HTML through. Either
// would load remote content as soon as the text renders, skipping the "remote images are click-to-load" rule, and with
// a `$template` over state it would send what the user types to any server on every keystroke. So before the text
// reaches the renderer:
//
// - images become links (`[alt](url)`), which open through the surface's link policy when clicked;
// - every `<` that could start an HTML tag, comment or declaration is followed by an invisible U+2060 WORD JOINER, so
//   the parser sees text (autolinks such as `<https://…>` are left alone; they are links);
// - every `"` becomes the entity `&#34;`. The app's link renderer writes a link's href and title into the HTML without
//   escaping them, so a quote in a link, a bare URL or an autolink would end the attribute and add new ones
//   (`style="background-image:url(…)"`, `onfocus=…`). As an entity it stays inside the attribute; in text the browser
//   shows it as `"`.
//
// None of this depends on parsing Markdown the way marked does (a parser that disagrees with marked about where code
// or a link starts could be fooled into leaving markup alone): the joiner and the entity go in everywhere, inside code
// too. There the joiner is invisible, and marked shows the entity as written, so MarkdownText turns `&#34;` in the
// rendered text back into `"` (restoreQuotes). Top-level fenced code blocks are split out and shown with `ui.Code`
// instead, so copying them gives the exact code; copying a selection strips the joiners (see MarkdownText).

/** U+2060 WORD JOINER: invisible, and breaks `![` and `<tag` apart for the parser. */
export const JOINER = "⁠"

/** What `"` becomes before the text reaches the renderer: an entity, so it can never end an HTML attribute. */
export const QUOTE_ENTITY = "&#34;"

/** One part of a Markdown text: prose for `ui.Markdown`, or a top-level fenced code block for `ui.Code`. */
export type MarkdownPart =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "code"; readonly code: string; readonly language?: string }

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
/** Fences the app renders as display math (KaTeX); they stay in the Markdown. */
const MATH_FENCES = new Set(["math", "latex"])

/**
 * Splits Markdown into prose and fenced code blocks that start at column 0 (a block indented inside a list item stays
 * in its prose). Math fences stay in the prose, which the app renders as math. An unclosed block runs to the end.
 */
export function splitMarkdown(text: string): MarkdownPart[] {
  const parts: MarkdownPart[] = []
  let prose: string[] = []
  let open: { char: string; length: number; language?: string; lines: string[] } | undefined
  /** A math fence, kept in the prose up to and including its closing fence. */
  let math: { char: string; length: number } | undefined

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
      const end = FENCE_CLOSE.exec(line)
      if (end && end[1]![0] === open.char && end[1]!.length >= open.length) close()
      else open.lines.push(line)
      continue
    }
    if (math) {
      const end = FENCE_CLOSE.exec(line)
      if (end && end[1]![0] === math.char && end[1]!.length >= math.length) math = undefined
      prose.push(line)
      continue
    }
    const start = FENCE_OPEN.exec(line)
    const fence = start?.[1]
    const info = start?.[2] ?? ""
    const language = info.trim().split(/\s+/)[0] ?? ""
    if (fence && !(fence[0] === "`" && info.includes("`"))) {
      if (MATH_FENCES.has(language.toLowerCase())) math = { char: fence[0]!, length: fence.length }
      else {
        flush()
        open = { char: fence[0]!, length: fence.length, ...(language ? { language } : {}), lines: [] }
        continue
      }
    }
    prose.push(line)
  }
  close()
  flush()
  return parts
}

// marked's autolink: `<scheme:…>` with no whitespace, `<` or `>` inside (marked 18, src/rules.ts `autolink`). It can
// never be an HTML tag: a tag name is followed by whitespace, `/` or `>`, never by `:`, `+` or `.`.
const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*>/
/** What may follow `<` in an HTML tag, closing tag, comment, declaration, CDATA or processing instruction. */
const TAG_START = /[A-Za-z/!?]/

/**
 * Markdown with images turned into links, raw HTML into text and quotes into entities. `imageLabel` is the link text
 * for an image without alt text. On lines with a backtick or indented as code, an image keeps its `!` (with a joiner
 * after it), so code that shows Markdown syntax still reads the same.
 */
export function neutralizeMarkdown(text: string, imageLabel: string): string {
  const lines = text
    .replaceAll('"', QUOTE_ENTITY)
    .split("\n")
    .map((line) => {
      const code = line.includes("`") || /^(?: {4}|\t)/.test(line)
      // A run of `!` is matched whole, so dropping one cannot leave another `!` right before the `[`.
      return line.replace(/(!*)!\[(\]?)/g, (_match, bangs: string, empty: string) => {
        if (code) return `${bangs}!${JOINER}[${empty}`
        return `${bangs}${bangs ? JOINER : ""}[${empty ? `${imageLabel}]` : ""}`
      })
    })
  const joined = lines.join("\n")
  let out = ""
  for (let index = 0; index < joined.length; index++) {
    const char = joined[index]!
    out += char
    if (char !== "<") continue
    const autolink = AUTOLINK.exec(joined.slice(index, index + 2100))
    if (autolink) {
      out += autolink[0].slice(1)
      index += autolink[0].length - 1
    } else if (TAG_START.test(joined[index + 1] ?? "")) out += JOINER
  }
  return out
}

/** Text without the joiners `neutralizeMarkdown` added, for copying. */
export const stripJoiners = (text: string) => text.replaceAll(JOINER, "")

/**
 * Rendered text with the quote entities `neutralizeMarkdown` added shown as `"` again: marked keeps `&#34;` as written
 * in code (and after a backslash), where the browser does not decode it.
 */
export const restoreQuotes = (text: string) => text.replaceAll(QUOTE_ENTITY, '"')
