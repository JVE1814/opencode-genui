import { afterEach, describe, expect, test } from "bun:test"
import { createMarkdownParser } from "@opencode/ui/context/marked-parser"
import { createRoot, createSignal } from "solid-js"
import { Lexer, type Token } from "marked"
import { normalizeOption, normalizeOptions } from "../../src/catalog/components.ts"
import { CELLS_PER_UNIT, domUnits, ITEM_LISTS, itemList, splitKeys } from "../../src/gui/costs.ts"
import { elementUnits, RENDER_UNITS, unitsOf } from "../../src/gui/element.ts"
import { chartCut, listCut, markdownCut, MAX_CUT_ISSUES, moreCuts, tableCut } from "../../src/gui/issues.ts"
import {
  MAX_ESCAPES,
  MAX_MARKDOWN_TEXT,
  MAX_PARAGRAPH,
  neutralizeMarkdown,
  prepareMarkdown,
  shownLength,
  splitMarkdown,
} from "../../src/gui/components/markdown.ts"
import { foldCanvases, type CanvasBlock } from "../../src/protocol/fold.ts"
import { parseBlock } from "../../src/protocol/surface.ts"
import { backfill, type MessageListClient } from "../../src/runtime/backfill.ts"
import { createSessionIndex, type MessageLike } from "../../src/runtime/session-index.ts"

// Regression tests for the seventh review's app findings ([review7#<id>]): what components build from list props, and
// what the Markdown renderer is given.

describe("a component that draws a list item by item is charged for it and draws at most ITEM_LISTS' count [review7#R6S3-2]", () => {
  test("a Keybind of 48,000 keys written as one string costs what it draws, not a character a key", () => {
    // 96 KB of "a+a+…" cost about 400 units of text and built 96,000 nodes in one element (3 s of frozen window).
    const keys = Array.from({ length: 48_000 }, () => "a").join("+")
    const { max, cells } = ITEM_LISTS.Keybind
    expect(domUnits("Keybind", { keys })).toBe(Math.ceil((max * cells) / CELLS_PER_UNIT))
    expect(domUnits("Keybind", { keys: ["Mod", "K"] })).toBe(Math.ceil((2 * cells) / CELLS_PER_UNIT))
    expect(splitKeys(keys, max)).toEqual({ keys: Array.from({ length: max }, () => "a"), total: 48_000 })
  })

  test("every list a component draws item by item is charged per item drawn, up to its maximum", () => {
    for (const [type, list] of Object.entries(ITEM_LISTS)) {
      const items = Array.from({ length: 10_000 }, (_, index) => ({ label: "a", value: String(index), title: "a" }))
      const charged = domUnits(type, { [list.prop]: items })
      expect(charged, type).toBe(Math.ceil((list.max * list.cells) / CELLS_PER_UNIT))
      expect(domUnits(type, { [list.prop]: items.slice(0, 3) }), type).toBe(
        Math.ceil((3 * list.cells) / CELLS_PER_UNIT),
      )
      expect(elementUnits({ type, props: { [list.prop]: items } }), type).toBeGreaterThan(
        unitsOf({ [list.prop]: items }),
      )
    }
    // A Radio of 10,000 options (79 KB, 60,000 nodes, 1.2 s) costs what its 200 options build.
    const options = Array.from({ length: 10_000 }, (_, index) => `o${index}`)
    expect(domUnits("Radio", { options })).toBe((ITEM_LISTS.Radio.max * ITEM_LISTS.Radio.cells) / CELLS_PER_UNIT)
    expect(itemList("Text")).toBeUndefined()
    expect(itemList("toString")).toBeUndefined()
    expect(domUnits("Text", { keys: options })).toBe(0)
  })

  test("what a surface may draw from lists in one task stays bounded: the slice starts at most 1,000 units of them", () => {
    // Each Radio of 200 options costs at least 80 units, so a 2,000-unit surface holds at most 25 of them (35,000
    // nodes), and one task starts at most a dozen.
    const radio = {
      type: "Radio",
      props: { label: "L", options: Array.from({ length: 200 }, (_, index) => `o${index}`) },
    }
    expect(elementUnits(radio)).toBeGreaterThanOrEqual(80)
    expect(Math.floor(RENDER_UNITS / elementUnits(radio))).toBeLessThanOrEqual(25)
  })

  test("splitKeys keeps the non-blank parts of a Keybind string, and counts them all", () => {
    expect(splitKeys("Mod+K", 16)).toEqual({ keys: ["Mod", "K"], total: 2 })
    expect(splitKeys("Ctrl++ +Shift", 16)).toEqual({ keys: ["Ctrl", "Shift"], total: 2 })
    expect(splitKeys("", 16)).toEqual({ keys: [], total: 0 })
    expect(splitKeys("a+b+c", 2)).toEqual({ keys: ["a", "b"], total: 3 })
  })

  test("options are normalized one at a time, as the capped components read them", () => {
    expect(normalizeOption("a")).toEqual({ label: "a", value: "a" })
    expect(normalizeOption({ value: "v" })).toEqual({ label: "v", value: "v" })
    expect(normalizeOption({ label: "L", value: "v" })).toEqual({ label: "L", value: "v" })
    expect(normalizeOption({ label: "L" })).toBeUndefined()
    expect(normalizeOption(3)).toBeUndefined()
    expect(normalizeOptions(["a", { value: "b" }, 5] as never)).toEqual([
      { label: "a", value: "a" },
      { label: "b", value: "b" },
    ])
  })

  test("what is cut is reported to the agent, with the bound that cut it", () => {
    expect(listCut("Radio", 10_000)).toEqual({
      severity: "warning",
      code: "list_cut",
      message: "shows only its first 200 of 10,000 options: a Radio shows at most 200",
    })
    expect(listCut("Keybind", 48_000).message).toBe(
      "shows only its first 16 of 48,000 keys: a Keybind shows at most 16",
    )
    expect(tableCut(500, 3000, 1, 1).message).toContain("shows 500 of its 3,000 rows")
    expect(chartCut(500, 900, 6, 8).message).toContain("draws 500 of its 900 labels and 6 of its 8 series")
    expect(moreCuts(5).message).toBe("5 more elements show only part of their lists or text")
    expect(MAX_CUT_ISSUES).toBeGreaterThan(0)
  })
})

describe("a long Markdown text shows in full unless a paragraph is too long for the renderer [review7#R6F3-2]", () => {
  const doc = (length: number) => {
    let text = ""
    for (let index = 1; text.length < length; index++)
      text += `## Section ${index}\n\nThis section explains **step ${index}** of the rollout, with \`config_${index}.yaml\` and _notes_.\n\n- item one for ${index}\n- item two for ${index}\n\n`
    return `${text}FINAL LINE`
  }

  test("an ordinary document of 100 KB, or 400 KB, shows whole", () => {
    // It was cut at 40,000 characters with only a trailing "…": 284 of its 704 sections showed.
    for (const length of [100_000, 400_000]) {
      const text = doc(length)
      expect(shownLength(text)).toEqual({ shown: text.length })
      const parts = prepareMarkdown(text, "Image")
      expect(parts.map((part) => (part.kind === "markdown" ? part.text : "")).join("")).toContain("FINAL LINE")
    }
  })

  test("a list, or headings, of 100 KB without blank lines are runs of their own, and show whole", () => {
    const list = Array.from({ length: 2000 }, (_, index) => `- item ${index} with some words of text in it`).join("\n")
    expect(list.length).toBeGreaterThan(MAX_PARAGRAPH)
    expect(shownLength(list)).toEqual({ shown: list.length })
    const headings = Array.from({ length: 2000 }, (_, index) => `### Heading ${index} with a few words`).join("\n")
    expect(shownLength(headings)).toEqual({ shown: headings.length })
    // A fenced code block of any length is not a paragraph.
    const code = "```\n" + "x <y \\* ".repeat(20_000) + "\n```"
    expect(shownLength(code)).toEqual({ shown: code.length })
  })

  test("a paragraph past MAX_PARAGRAPH cuts the text there, and says why", () => {
    const long = "a<b ".repeat(10_000)
    const text = `Intro.\n\n${long}\n\nAfter.`
    expect(shownLength(text)).toEqual({ shown: "Intro.\n\n".length + MAX_PARAGRAPH, reason: "paragraph" })
    const parts = prepareMarkdown(text, "Image")
    const shown = parts.map((part) => (part.kind === "markdown" ? part.text : "")).join("")
    expect(shown).not.toContain("After.")
    expect(shown.endsWith("…")).toBe(true)
    // Lines indented as list items more than three spaces continue the paragraph, as marked lexes them.
    const indented = `Intro\n${Array.from({ length: 2000 }, () => "    - a<b a<b a<b").join("\n")}`
    expect(shownLength(indented).reason).toBe("paragraph")
    // So do a quote's lines.
    expect(shownLength(Array.from({ length: 3000 }, () => "> a<b a<b").join("\n")).reason).toBe("paragraph")
    expect(markdownCut(20_000, 40_000, "paragraph").message).toBe(
      "shows only the first 20,000 of its 40,000 characters of Markdown: a paragraph (or a list item, or a table row) runs past 20,000 characters there: split it into shorter ones",
    )
  })

  test("a text past MAX_MARKDOWN_TEXT is cut there", () => {
    const paragraph = "A paragraph of ordinary prose that goes on for a sentence or so.\n\n"
    const text = paragraph.repeat(Math.ceil((MAX_MARKDOWN_TEXT + 100) / paragraph.length))
    expect(shownLength(text)).toEqual({ shown: MAX_MARKDOWN_TEXT, reason: "text" })
    // [review8] Paragraphs of three words (31,000 of them) are blocks the text's length does not pay for: they are cut
    // first, where they pass MAX_MARKDOWN_BLOCKS (the text this test used before).
    expect(shownLength("word word word\n\n".repeat(Math.ceil((MAX_MARKDOWN_TEXT + 100) / 16))).reason).toBe("blocks")
    expect(markdownCut(MAX_MARKDOWN_TEXT, text.length, "text").message).toContain("shows at most 500,000")
  })

  test("a text is cut on a code point's boundary, never between a surrogate pair's halves", () => {
    // `text.slice(0, 40000)` could leave a lone surrogate.
    const text = `${"a".repeat(MAX_PARAGRAPH - 1)}😀${"b".repeat(100)}`
    const cut = shownLength(text)
    expect(cut).toEqual({ shown: MAX_PARAGRAPH - 1, reason: "paragraph" })
    const shown = prepareMarkdown(text, "Image")
      .map((part) => (part.kind === "markdown" ? part.text : ""))
      .join("")
    expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    const after = `${"a".repeat(MAX_PARAGRAPH - 2)}😀${"b".repeat(100)}`
    expect(shownLength(after)).toEqual({ shown: MAX_PARAGRAPH, reason: "paragraph" })
  })
})

describe("escapes past a paragraph's first MAX_ESCAPES are no tokens for the renderer [review7#R6F3-2]", () => {
  const parser = createMarkdownParser()
  const escapes = (tokens: readonly Token[]): number =>
    tokens.reduce(
      (count, token) =>
        count +
        (token.type === "escape" ? 1 : 0) +
        escapes(("tokens" in token && Array.isArray(token.tokens) ? token.tokens : []) as Token[]) +
        escapes(("items" in token && Array.isArray(token.items) ? token.items : []) as Token[]),
      0,
    )
  const visible = (html: string) =>
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("⁠", "")

  test("a paragraph of 10,000 escapes gives marked at most MAX_ESCAPES escape tokens, and shows the same", () => {
    // marked made a token of each, and searched the rest of the paragraph for math delimiters from each: 40,000
    // characters of `a\*` took 0.7 s in Chromium, 100,000 seconds.
    for (const text of ["a\\*".repeat(10_000), "\\( ".repeat(10_000), "a\\b".repeat(10_000), "a\\*\n".repeat(5000)]) {
      const neutralized = neutralizeMarkdown(text, "Image")
      expect(MAX_ESCAPES).toBe(100)
      expect(escapes(new Lexer().lex(neutralized)), text.slice(0, 6)).toBeLessThanOrEqual(100)
      const shown = visible(parser.parse(neutralized, { async: false }) as string)
      const before = visible(parser.parse(text, { async: false }) as string)
      expect(shown, text.slice(0, 6)).toBe(before)
    }
  })

  test("the text of a link genui writes for a bare URL holds no escapes, however many special characters it has", () => {
    // Each `_` of the address was escaped with a backslash in the link's text: 9,500 tokens, 0.4 s per paragraph.
    for (const url of [
      "http://x/" + "_a".repeat(9500),
      "www.x.com/" + "*a".repeat(9500),
      "<http://x/" + "_a".repeat(9500) + ">",
    ]) {
      const neutralized = neutralizeMarkdown(url, "Image")
      expect(escapes(new Lexer().lex(neutralized)), url.slice(0, 12)).toBe(0)
      const shown = visible(parser.parse(neutralized, { async: false }) as string)
      expect(shown.replaceAll("\n", ""), url.slice(0, 12)).toBe(url.replace(/^<|>$/g, ""))
    }
  })

  test("a few escapes, a backslash before a line break and code spans stay as written", () => {
    expect(neutralizeMarkdown("a \\* b \\_ c", "Image")).toBe("a \\* b \\_ c")
    const breaks = `${"\\*".repeat(MAX_ESCAPES)}x\\\ny`
    expect(neutralizeMarkdown(breaks, "Image").endsWith("x\\\ny")).toBe(true)
    const spans = `${"\\*".repeat(MAX_ESCAPES)} \`a\\*b\``
    expect(neutralizeMarkdown(spans, "Image").endsWith("`a\\*b`")).toBe(true)
    expect(splitMarkdown("x").length).toBe(1)
  })
})

describe("a canvas on an unknown base renders, but keeps looking for the base and settles only once it is found or the history is searched [review7#R6F3-1]", () => {
  const line = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n")
  const add = (path: string, value: unknown) => ({ op: "add", path, value })
  const rep = (path: string, value: unknown) => ({ op: "replace", path, value })
  const block = (messageID: string, body: string): CanvasBlock => ({
    ref: { messageID, part: 0, ordinal: 0 },
    canvas: "deploy",
    block: parseBlock(body),
    closed: true,
    complete: true,
  })
  // The base: a title, the state, and the elements a later switch points at.
  const baseBody = line(
    { canvas: "deploy", title: "Deploy" },
    add("/root", "running"),
    add("/elements/running", { type: "Card", props: { title: "Deploying" }, children: [] }),
    add("/elements/done", { type: "Alert", props: { title: "Deployed", type: "success" }, children: [] }),
    add("/state/version", "v2.4"),
  )
  const switchBody = line({ canvas: "deploy" }, rep("/root", "done"))
  // The switched-to element written whole: the spec then holds its whole tree.
  const rewriteBody = line(
    { canvas: "deploy" },
    rep("/elements/done", { type: "Alert", props: { title: { $template: "Deployed ${/version}" } }, children: [] }),
  )

  test("an old canvas's view switch, whose switched-to element a later block rewrites whole, does not settle without its base", () => {
    // It lost the base's title and state, and was saved so: its base was never looked for.
    const blocks = [block("msg_10", switchBody), block("msg_11", rewriteBody)]
    const alone = foldCanvases({}, blocks).canvases.get("deploy")!
    expect(alone.missingBase).toBe(false)
    expect(alone.baseUnknown).toBe(true)
    expect(alone.settled).toBeUndefined()
    // Once the backfill finds the base, the canvas has its title, its state and its other elements, and settles.
    const found = foldCanvases({}, [block("msg_01", baseBody), ...blocks]).canvases.get("deploy")!
    expect(found.title).toBe("Deploy")
    expect(found.spec?.state).toEqual({ version: "v2.4" })
    expect(Object.keys(found.spec?.elements ?? {}).sort()).toEqual(["done", "running"])
    expect(found.baseUnknown).toBe(false)
    expect(found.settled?.spec).toBe(found.spec!)
    // A later switch back to an element of the base keeps working.
    const back = foldCanvases({}, [
      block("msg_01", baseBody),
      ...blocks,
      block("msg_12", line({ canvas: "deploy" }, rep("/root", "running"))),
    ]).canvases.get("deploy")!
    expect(back.spec?.root).toBe("running")
    expect(back.settled?.spec).toBe(back.spec!)
    // With the whole history loaded and no base in it, the canvas settles as it is.
    const searched = foldCanvases({}, blocks, { searched: true }).canvases.get("deploy")!
    expect(searched.baseUnknown).toBe(false)
    expect(searched.settled?.spec).toBe(searched.spec!)
  })

  const disposers: Array<() => void> = []
  afterEach(() => {
    while (disposers.length) disposers.pop()!()
  })
  const assistant = (id: string, body: string): MessageLike =>
    ({
      id,
      type: "assistant",
      content: [{ type: "text", text: `\`\`\`canvas\n${body}\n\`\`\`` }],
      time: { created: 1, completed: 2 },
    }) as MessageLike

  test("the session index asks for a backfill until the base is found, or the history is searched to its start", async () => {
    const [extra, setExtra] = createSignal<readonly MessageLike[]>([])
    const [searched, setSearched] = createSignal(false)
    const window = [assistant("msg_10", switchBody), assistant("msg_11", rewriteBody)]
    let index!: ReturnType<typeof createSessionIndex>
    createRoot((dispose) => {
      disposers.push(dispose)
      index = createSessionIndex({ messages: () => window, snapshots: () => ({}), extra, searched, loaded: () => true })
    })
    // The canvas renders, but its base may be in older messages.
    expect(index.canvas("deploy")?.missingBase).toBe(false)
    expect(index.needsBackfill()).toBe(true)
    expect(index.canvas("deploy")?.settled).toBeUndefined()
    // The base is found: no more backfill, and the canvas settles with its title and state.
    setExtra([assistant("msg_01", baseBody)])
    expect(index.needsBackfill()).toBe(false)
    expect(index.canvas("deploy")?.settled?.title).toBe("Deploy")
    // Without a base in the history, a backfill that reached the start lets it settle as it is.
    setExtra([])
    expect(index.needsBackfill()).toBe(true)
    setSearched(true)
    expect(index.needsBackfill()).toBe(false)
    expect(index.canvas("deploy")?.settled?.spec.root).toBe("done")
  })

  test("backfill says when it reached the session's first message, and only then", async () => {
    const pages = (count: number): MessageListClient => {
      const all = Array.from({ length: count }, (_, index) => ({
        id: `msg_${String(index).padStart(4, "0")}`,
        type: "assistant",
      }))
      return {
        message: {
          async list(input) {
            const ordered = all.toReversed()
            const start = input.cursor === undefined ? 0 : ordered.findIndex((item) => item.id === input.cursor) + 1
            const data = ordered.slice(start, start + (input.limit ?? 50))
            return { data, cursor: { next: data.at(-1)?.id ?? null } }
          },
        },
      }
    }
    let started = 0
    await backfill(pages(250), "ses", { onStart: () => started++ })
    expect(started).toBe(1)
    await backfill(pages(200), "ses", { onStart: () => started++ })
    expect(started).toBe(2)
    // Stopped by max, or by until: the history may hold more.
    await backfill(pages(500), "ses", { max: 150, onStart: () => started++ })
    await backfill(pages(500), "ses", { until: () => true, onStart: () => started++ })
    expect(started).toBe(2)
  })
})
