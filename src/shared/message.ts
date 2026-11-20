/** Longest message a surface may send, in characters; a longer text or data is truncated (with a note). */
export const MAX_SENT_MESSAGE = 16_000

/** Longest text a message with data keeps, so the data always has room. */
export const MAX_TEXT_WITH_DATA = 4_000

/** What a cut text or data ends with, on a line of its own. */
export const TRUNCATED = "... (truncated)"

/** `text` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/** `text` within `max` characters, with the truncation note on its own line when it had to be cut. */
function within(text: string, max: number): string {
  return text.length <= max ? text : `${cut(text, Math.max(0, max - TRUNCATED.length - 1))}\n${TRUNCATED}`
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * The fence a text leaves open (a ```` ``` ```` the user typed without closing it), or undefined. Fences open and close
 * at the start of a line, as CommonMark reads them.
 */
function openFence(text: string): string | undefined {
  let open: string | undefined
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1]![0] === open[0] && close[1]!.length >= open.length) open = undefined
      continue
    }
    const start = FENCE_OPEN.exec(line)
    if (start && !(start[1]![0] === "`" && start[2]!.includes("`"))) open = start[1]
  }
  return open
}

/** `text` within `max` characters, as `within` cuts it, with any fence it leaves open closed on a last line. */
function closed(text: string, max: number): string {
  for (let room = max; ; ) {
    const kept = within(text, room)
    const fence = openFence(kept)
    if (!fence) return kept
    if (kept.length + 1 + fence.length <= max) return `${kept}\n${fence}`
    // The closing fence did not fit: keep less (a shorter text leaves at most a fence it holds open).
    room = Math.min(room - 1, max - 1 - fence.length)
  }
}

/**
 * The user message a `sendPrompt` action sends: the action's text, then its data (if any) as a fenced JSON block, which
 * is always the message's last fenced block. A fence the text leaves open is closed first, so the data block stays a
 * block of its own. The agent's instructions (src/catalog/prompt.ts) describe this format, so keep them in sync.
 *
 * ```text
 * Deploy with these settings
 *
 * ```json
 * { "env": "production", "replicas": 3 }
 * ```
 * ```
 *
 * The whole message stays within MAX_SENT_MESSAGE: the text within MAX_TEXT_WITH_DATA when there is data, the data in
 * the room left; whatever is cut ends with "... (truncated)".
 */
export function formatSentMessage(input: { readonly text: string; readonly data?: unknown }): string {
  const trimmed = input.text.trim() || "(no text)"
  if (input.data === undefined) return closed(trimmed, MAX_SENT_MESSAGE)

  let json: string
  try {
    json = JSON.stringify(input.data, null, 2) ?? "null"
  } catch {
    json = '"(data could not be serialized)"'
  }
  const lead = closed(trimmed, MAX_TEXT_WITH_DATA)
  const room = MAX_SENT_MESSAGE - lead.length - "\n\n```json\n\n```".length
  return `${lead}\n\n\`\`\`json\n${within(json, room)}\n\`\`\``
}
