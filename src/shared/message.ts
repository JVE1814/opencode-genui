/** Longest message a surface may send, in characters; longer data is truncated with a note. */
export const MAX_SENT_MESSAGE = 16_000

/**
 * The user message a `sendPrompt` action sends: the action's text, then its data (if any) as a fenced JSON block.
 * The agent's instructions (src/catalog/prompt.ts) describe this format, so keep them in sync.
 *
 * ```text
 * Deploy with these settings
 *
 * ```json
 * { "env": "production", "replicas": 3 }
 * ```
 * ```
 */
export function formatSentMessage(input: { readonly text: string; readonly data?: unknown }): string {
  const text = input.text.trim() || "(no text)"
  if (input.data === undefined) return text.slice(0, MAX_SENT_MESSAGE)

  let json: string
  try {
    json = JSON.stringify(input.data, null, 2) ?? "null"
  } catch {
    json = '"(data could not be serialized)"'
  }
  const room = MAX_SENT_MESSAGE - text.length - 16
  if (json.length > room) json = `${json.slice(0, Math.max(0, room - 40))}\n... (truncated)`
  return `${text}\n\n\`\`\`json\n${json}\n\`\`\``
}
