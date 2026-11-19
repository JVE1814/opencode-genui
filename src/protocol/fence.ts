/** One fenced code block found in Markdown text. */
export interface FenceBlock {
  /** The first word of the info string, lowercased and reduced to the characters the app keeps. */
  readonly language: string
  /** The source between the fences. Lines keep their text; the fence's own indentation is removed. */
  readonly body: string
  /** False while the closing fence has not arrived, as in a message that is still streaming. */
  readonly closed: boolean
  /** The block's position among the fenced blocks of the text, from 0. */
  readonly ordinal: number
}

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/

/** The language the app derives from a fence's info string. */
export function fenceLanguage(info: string) {
  return (info.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^\w#+.-]/g, "")
}

/**
 * Finds the fenced code blocks of a Markdown text, by the CommonMark rules the app's own renderers follow: a fence of
 * three or more backticks or tildes indented at most three spaces, closed by a fence of the same character that is at
 * least as long. A block without a closing fence runs to the end of the text and reports `closed: false`.
 *
 * This is used only to follow canvas blocks while they stream; inline blocks come from the app's own parser.
 */
export function scanFences(text: string): FenceBlock[] {
  const blocks: FenceBlock[] = []
  const lines = text.split("\n")
  let open: { char: string; length: number; indent: number; info: string; body: string[] } | undefined

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw

    if (!open) {
      const match = OPEN.exec(line)
      if (!match) continue
      const [, indent = "", fence = "", info = ""] = match
      // A backtick fence's info string cannot contain a backtick: that is inline code, not a fence.
      if (fence.startsWith("`") && info.includes("`")) continue
      open = { char: fence[0]!, length: fence.length, indent: indent.length, info, body: [] }
      continue
    }

    const trimmed = line.trimEnd()
    const close = /^( {0,3})(`{3,}|~{3,})$/.exec(trimmed)
    if (close && close[2]![0] === open.char && close[2]!.length >= open.length) {
      blocks.push({
        language: fenceLanguage(open.info),
        body: open.body.join("\n"),
        closed: true,
        ordinal: blocks.length,
      })
      open = undefined
      continue
    }

    // Body lines lose up to the opening fence's indentation.
    let skip = 0
    while (skip < open.indent && line[skip] === " ") skip++
    open.body.push(line.slice(skip))
  }

  if (open)
    blocks.push({
      language: fenceLanguage(open.info),
      body: open.body.join("\n"),
      closed: false,
      ordinal: blocks.length,
    })

  return blocks
}
