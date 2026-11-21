import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, createSignal, untrack } from "solid-js"
import {
  markdownShape,
  MAX_MARKDOWN_TEXT,
  SHAPE_CACHE_CHARS,
  shapeCacheChars,
} from "../../src/gui/components/markdown.ts"
import { createSessionIndex, type MessageLike, type SessionIndex } from "../../src/runtime/session-index.ts"

// Regression tests for what the eighth round's integration found where the groups' fixes meet.

describe("the Markdown shapes cache is bounded by the characters it keeps [review8#R7A-5]", () => {
  test("long texts a $template built are not all kept after their elements are gone", () => {
    // Each text is a distinct million characters, as a `$template` may build (MAX_EXPANSION); kept by count alone, 64
    // such keys stayed (63 MB of page heap after GC once the canvas that showed them closed).
    for (let index = 0; index < 8; index++) {
      const text = `${index}\n\n` + "word ".repeat(200_000)
      markdownShape(text)
      expect(shapeCacheChars()).toBeLessThanOrEqual(SHAPE_CACHE_CHARS + text.length)
    }
    expect(shapeCacheChars()).toBeLessThanOrEqual(SHAPE_CACHE_CHARS + 1_000_100)
    expect(SHAPE_CACHE_CHARS).toBeLessThan(8 * 1_000_000)
  })

  test("the newest text stays cached whatever its length, so the rows of a repeat that share it measure it once", () => {
    const text = "x\n\n" + "y ".repeat(MAX_MARKDOWN_TEXT)
    const first = markdownShape(text)
    // The same object: measured once, not again for each row.
    expect(markdownShape(text)).toBe(first)
    expect(markdownShape(text)).toBe(first)
  })

  test("short texts still share the cache: 64 of them stay, the least recently used goes first", () => {
    const texts = Array.from({ length: 64 }, (_, index) => `# heading ${index}\n\nsome text`)
    const shapes = texts.map((text) => markdownShape(text))
    // Touch the first, so it is the most recently used; one more text then evicts the second.
    expect(markdownShape(texts[0]!)).toBe(shapes[0]!)
    markdownShape("one more")
    expect(markdownShape(texts[0]!)).toBe(shapes[0]!)
    expect(markdownShape(texts[1]!)).not.toBe(shapes[1]!)
  })
})

describe("a streamed delta wakes only the surfaces whose block it changes [review8#R7S2-3]", () => {
  test("1,700 surfaces asking whether their block is the agent's re-run only for a block that became known", () => {
    // Each delta of a reply changed the set of the agent's block texts (the block being written grows), and every
    // mounted surface asked about the whole set: a reply of 1,700 small blocks re-ran 1,700 computations per delta.
    const block = (index: number) =>
      "```spec\n" + `{"root":"a","elements":{"a":{"type":"Text","props":{"text":"${index}"}}}}` + "\n```"
    const [messages, setMessages] = createSignal<readonly MessageLike[]>([])
    const reply = (text: string, completed: boolean) =>
      setMessages([
        {
          id: "msg_0002",
          type: "assistant",
          content: [{ type: "text", text }],
          time: { created: 1, ...(completed ? { completed: 2 } : {}) },
        },
      ])
    const blocks = Array.from({ length: 1700 }, (_, index) => block(index))
    const texts = blocks.map((text) => text.slice("```spec\n".length, -"\n```".length))
    let runs = 0
    let dispose!: () => void
    let index!: SessionIndex
    createRoot((done) => {
      dispose = done
      index = createSessionIndex({ messages, snapshots: () => ({}), loaded: () => true })
      reply(blocks.join("\n\n"), false)
      for (const text of texts)
        createComputed(() => {
          index.knows(text)
          runs++
        })
    })
    expect(texts.every((text) => untrack(() => index.knows(text)))).toBe(true)
    runs = 0
    // The next delta starts a block, then grows it: no block a surface shows changes.
    reply(`${blocks.join("\n\n")}\n\n\`\`\`spec\n{"root":`, false)
    reply(`${blocks.join("\n\n")}\n\n\`\`\`spec\n{"root":"a","elements":`, false)
    expect(runs).toBe(0)
    // A block a surface shows leaves the reply (the agent's text changed): only its computation runs again.
    reply(blocks.slice(1).join("\n\n"), true)
    expect(runs).toBe(1)
    expect(untrack(() => index.knows(texts[0]!))).toBe(false)
    expect(untrack(() => index.knows(texts[1]!))).toBe(true)
    dispose()
  })
})
