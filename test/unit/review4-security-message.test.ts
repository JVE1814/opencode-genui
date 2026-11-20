import { describe, expect, test } from "bun:test"
import { formatSentMessage, MAX_SENT_MESSAGE, MAX_TEXT_WITH_DATA, TRUNCATED } from "../../src/shared/message.ts"

/** The fenced blocks of a message, as CommonMark reads them: [info, body]. */
function blocks(message: string): [string, string][] {
  const found: [string, string][] = []
  let open: { fence: string; info: string; body: string[] } | undefined
  for (const line of message.split("\n")) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === open.fence[0] && close[1]!.length >= open.fence.length) {
        found.push([open.info, open.body.join("\n")])
        open = undefined
      } else open.body.push(line)
      continue
    }
    const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (start) open = { fence: start[1]!, info: start[2]!.trim(), body: [] }
  }
  if (open) found.push([open.info, open.body.join("\n")])
  return found
}

const lastBlock = (message: string) => blocks(message).at(-1)

describe("formatSentMessage", () => {
  test("a fence the text leaves open is closed, so the data stays a block of its own [review4-correctness#9]", () => {
    for (const text of ["see:\n```", "see:\n~~~~ js\nconst a = 1", "````md\n```\nnested", "  ```\nindented open"]) {
      const message = formatSentMessage({ text, data: { env: "staging" } })
      expect(lastBlock(message), text).toEqual(["json", '{\n  "env": "staging"\n}'])
      expect(JSON.parse(lastBlock(message)![1])).toEqual({ env: "staging" })
    }
    // A text with closed blocks is sent as typed, and its blocks come before the data, which is always last.
    const typed = 'Use this:\n```json\n{"fake": true}\n```'
    const message = formatSentMessage({ text: typed, data: { real: 1 } })
    expect(message.startsWith(`${typed}\n\n\`\`\`json\n`)).toBe(true)
    expect(lastBlock(message)).toEqual(["json", '{\n  "real": 1\n}'])
    // Without data, an open fence is closed too (the timeline then reads the message as the user meant it).
    expect(formatSentMessage({ text: "see:\n```sh\nnpm i" })).toBe("see:\n```sh\nnpm i\n```")
  })

  test("a cut text says so, with or without data [review4-use#6]", () => {
    const long = "word ".repeat(2000).trim()
    const withData = formatSentMessage({ text: long, data: { a: 1 } })
    const text = withData.slice(0, withData.indexOf("\n\n```json"))
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_WITH_DATA)
    expect(text.endsWith(`\n${TRUNCATED}`)).toBe(true)
    const alone = formatSentMessage({ text: "x".repeat(MAX_SENT_MESSAGE + 10) })
    expect(alone).toHaveLength(MAX_SENT_MESSAGE)
    expect(alone.endsWith(`\n${TRUNCATED}`)).toBe(true)
    // Text that fits is sent as it is.
    expect(formatSentMessage({ text: "x".repeat(MAX_SENT_MESSAGE) })).toBe("x".repeat(MAX_SENT_MESSAGE))
  })

  test("never cuts a character in half", () => {
    const emoji = "😀".repeat(MAX_SENT_MESSAGE)
    for (const message of [
      formatSentMessage({ text: emoji }),
      formatSentMessage({ text: `x${emoji}` }),
      formatSentMessage({ text: emoji, data: { blob: emoji } }),
      formatSentMessage({ text: `x${emoji}`, data: `y${emoji}` }),
    ]) {
      expect(message.length).toBeLessThanOrEqual(MAX_SENT_MESSAGE)
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(message)).toBe(false)
    }
  })

  test("stays within the cap with an open fence near the cut, and with long fences", () => {
    const fenced = `${"a".repeat(MAX_TEXT_WITH_DATA - 20)}\n${"`".repeat(30)}\n${"b".repeat(100)}`
    for (const text of [fenced, `${"`".repeat(5000)}\nx`, `\`\`\`\n${"c".repeat(50_000)}`]) {
      const withData = formatSentMessage({ text, data: { d: "e".repeat(30_000) } })
      expect(withData.length).toBeLessThanOrEqual(MAX_SENT_MESSAGE)
      expect(lastBlock(withData)![0]).toBe("json")
      expect(formatSentMessage({ text }).length).toBeLessThanOrEqual(MAX_SENT_MESSAGE)
    }
  })
})
