import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, root } from "../../playground/scenarios/build.ts"

// Regression tests for the eighth review's Markdown findings ([R7S2-2], [R7S1-5], [R7F2-3], [R7F2-2], [R7F1-1],
// [R7S2-4]) and the ninth's ([R8S-1], [R8S-2], [R8F-2]) in the playground. Timing is the page's own long tasks (PerformanceObserver "longtask"), with each message
// appended in a task of the page's own. The playground's ui.Markdown is not marked, so marked's block lexing is timed in
// the page on its own (the model's cut decides what it gets). See test/unit/review8-markdown.test.ts.

const pageErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on("pageerror", (error) => errors.push(error.message))
})
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([])
  expect(await page.evaluate(() => window.__genui?.errors ?? [])).toEqual([])
})

/** The longest task allowed where the code before took seconds: well under the 1 s target, with room for load. */
const BLOCKED_MS = 400

async function boot(page: Page) {
  await page.goto("/?scenario=empty&speed=instant&persist=0")
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(() => window.__genui.ready)
  await page.evaluate(() => window.__genui.scenarioDone)
  await page.evaluate(() => window.__genui.appendUser("go"))
}

/** Records the page's long tasks from now on; `longestTask` reads the longest one so far. */
const recordLongTasks = (page: Page) =>
  page.evaluate(() => {
    const record = window as unknown as { __r8m: number[]; __r8mObserver?: PerformanceObserver }
    record.__r8mObserver?.disconnect()
    record.__r8m = []
    record.__r8mObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record.__r8m.push(entry.duration)
    })
    record.__r8mObserver.observe({ type: "longtask" })
  })
const longestTask = (page: Page) =>
  page.evaluate(() => {
    const record = window as unknown as { __r8m: number[]; __r8mObserver?: PerformanceObserver }
    for (const entry of record.__r8mObserver?.takeRecords() ?? []) record.__r8m.push(entry.duration)
    return Math.max(0, ...record.__r8m)
  })

/** Waits until no long task was recorded for `quiet` ms. */
async function settle(page: Page, quiet = 1500) {
  let count = -1
  let since = Date.now()
  for (;;) {
    const now = await page.evaluate(() => (window as unknown as { __r8m: number[] }).__r8m.length)
    if (now !== count) {
      count = now
      since = Date.now()
    } else if (Date.now() - since >= quiet) return
    await page.waitForTimeout(100)
  }
}

/** Appends a completed assistant message with `text`, in a task of the page's own. */
const say = (page: Page, text: string) =>
  page.evaluate(
    (reply) =>
      new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          Promise.resolve(window.__genui.appendAssistant(reply)).then(() => resolve(), reject)
        }, 0),
      ),
    text,
  )

/** Appends a completed assistant message whose tool part returned `output` (untrusted), in a task of the page's own. */
const toolOutput = (page: Page, output: string) =>
  page.evaluate(
    (text) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const app = window.__genui.host.app
          const session = app.sessions.current()
          const id = app.server.startAssistant(session.id, [
            { type: "tool", id: `call_${Date.now()}`, name: "webfetch", state: { status: "completed", output: text } },
            { type: "text", text: "" },
          ])
          app.server.complete(session.id, id)
          resolve()
        }, 0),
      ),
    output,
  )

const untrusted = (page: Page) => page.locator('[data-playground-tool-output] [data-genui][data-surface="inline"]')
const canvasOf = (page: Page) => page.locator('[data-genui][data-surface="canvas"]')

/** The issues a surface lists in its footer. */
async function issueText(surface: Locator): Promise<string> {
  const footer = surface.locator('[data-gu-chrome="issues"]')
  await expect(footer).toBeVisible()
  await footer.locator("summary").click()
  return (await footer.locator('[data-slot="body"]').textContent()) ?? ""
}

/** A canvas with one Markdown element. */
const canvasDoc = (content: string) =>
  block("canvas", { canvas: "doc", title: "Doc" }, [root("md"), element("md", "Markdown", { content })])

test.describe("every code block the app's Markdown renders is charged [R7S2-2] [R7S1-5]", () => {
  test("an 88 KB block of headings and indented code from a tool is refused, and the issue says code blocks count", async ({
    page,
  }) => {
    // It rendered 11,000 code blocks, each with the app's toolbar, and charged none of them.
    await boot(page)
    const content = Array.from({ length: 11_000 }, () => "#\n\tc").join("\n")
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [root("s"), element("s", "Stack", {}, ["m"]), element("m", "Markdown", { content })])}\n`,
    )
    const text = await issueText(untrusted(page))
    expect(text).toContain("the UI is too large")
    expect(text).toContain("each code block of a Markdown text as an element")
  })
})

test.describe("legitimate Markdown shows whole [R7F2-3] [R7F2-2] [R7F1-1]", () => {
  test("a 101 KB glossary with paragraphs indented 4 shows whole, with no issue", async ({ page }) => {
    // Its continuation paragraphs were charged as code: the whole glossary was refused.
    await boot(page)
    const glossary = Array.from(
      { length: 1700 },
      (_, index) => `- **term-${index}**\n\n    Meaning of term ${index} in this codebase.\n\n`,
    ).join("")
    await say(page, canvasDoc(`${glossary}FINAL LINE`))
    await expect(canvasOf(page).getByText("FINAL LINE")).toBeVisible({ timeout: 20_000 })
    await expect(canvasOf(page).locator("[data-gu-cut]")).toHaveCount(0)
    await expect(canvasOf(page).locator('[data-gu-chrome="issues"]')).toHaveCount(0)
  })

  for (const [name, head, prefix] of [
    ["after an item's paragraph", "- **Backend**\n\n  Changes in this release:\n", "    - "],
    ["numbered", "1. **Backend**\n\n   Changes in this release:\n", "    - "],
    ["quoted", "> - **Backend**\n>\n>   Changes in this release:\n", ">     - "],
  ] as const) {
    test(`a nested list ${name}, 29 KB, shows whole`, async ({ page }) => {
      // It was cut at about 20,050 characters, items #1206 to #1299 and the end missing.
      await boot(page)
      const items = Array.from(
        { length: 300 },
        (_, index) =>
          `${prefix}Fixed issue #${1000 + index}: the scheduler no longer drops jobs whose retry window overlaps a deploy`,
      ).join("\n")
      await say(page, canvasDoc(`# Release notes\n\nIntro.\n\n${head}${items}\n\n## The end\n\nFINAL LINE`))
      await expect(canvasOf(page).getByText("FINAL LINE")).toBeVisible()
      await expect(canvasOf(page).getByText("#1299", { exact: false })).toBeVisible()
      await expect(canvasOf(page).locator("[data-gu-cut]")).toHaveCount(0)
      await expect(canvasOf(page).locator('[data-gu-chrome="issues"]')).toHaveCount(0)
    })
  }
})

test.describe("a text of tiny blocks is cut and charged as a Table is [R7S2-4]", () => {
  test("a 97 KB table of 2-character cells from a tool shows its first rows in a bounded task, and says why", async ({
    page,
  }) => {
    // It rendered all 47,000 cells in one task of 743 ms, charged by its length only.
    test.slow()
    const spec = (type: string, props: Record<string, unknown>) =>
      `Here:\n\n${block("spec", undefined, [root("s"), element("s", "Stack", {}, ["c"]), element("c", type, props)])}\n`
    const row = `|${"a|".repeat(1000)}`
    const markdown = [row, `|${"--|".repeat(1000)}`, ...Array.from({ length: 46 }, () => row)].join("\n")
    // The bound is what a Table of as many cells as a text may show (10,000, 200 rows of 50) takes in this browser, the
    // larger of a fresh page before and one after, and at least BLOCKED_MS: laying out the cells is most of either task
    // (about 250 to 400 ms when the machine is idle, more with four test workers on four cores), and the cut text shows
    // about as many (11,000). All 47,000 cells took three times as long as the Table.
    const table = async () => {
      await boot(page)
      await recordLongTasks(page)
      const columns = Array.from({ length: 50 }, (_, index) => `c${index}`)
      const rows = Array.from({ length: 200 }, () => columns.map(() => "a"))
      await toolOutput(page, spec("Table", { columns, rows }))
      await expect(untrusted(page).locator("td, th")).toHaveCount(10_050, { timeout: 20_000 })
      await settle(page)
      return longestTask(page)
    }
    const before = await table()
    await boot(page)
    await recordLongTasks(page)
    await toolOutput(page, spec("Markdown", { content: markdown }))
    const surface = untrusted(page)
    await expect(surface.locator("[data-gu-cut]")).toContainText("Showing the first")
    expect(await issueText(surface)).toContain("too many and too short")
    await settle(page)
    const longest = await longestTask(page)
    const cells = await surface.locator("td, th").count()
    const after = await table()
    expect(longest).toBeLessThan(Math.max(BLOCKED_MS, 1.5 * Math.max(before, after)))
    expect(cells).toBeGreaterThan(5000)
    expect(cells).toBeLessThan(15_000)
  })
})

test.describe("Markdown built to make marked's block lexer slow is cut, and says why [R7F2-2]", () => {
  test("paragraphs between rules, and lists nested past the limit, are cut with a note and an issue", async ({
    page,
  }) => {
    // Ending runs at a rule (as marked does) let 100 KB of `a\n***\n` through, which marked lexes in 3.4 s.
    await boot(page)
    await say(page, canvasDoc("a\n***\n".repeat(17_000)))
    const canvas = canvasOf(page)
    await expect(canvas.locator("[data-gu-cut]")).toContainText("Showing the first")
    expect(await issueText(canvas)).toContain("blank lines")
    await page.evaluate(() => window.__genui.appendUser("nested"))
    await say(
      page,
      block("canvas", { canvas: "deep", title: "Deep" }, [
        root("md"),
        element("md", "Markdown", { content: `before\n\n${"> ".repeat(9)}x` }),
      ]),
    )
    const deep = page.locator('[data-genui][data-surface="canvas"]').filter({ hasText: "before" })
    await expect(deep.locator("[data-gu-cut]")).toContainText("Showing the first")
    expect(await issueText(deep)).toContain("nest more than 8 deep")
  })

  test("a list item's lazy line that neutralizing lengthens is cut there, with a note and an issue [R8S-1] [R8S-2]", async ({
    page,
  }) => {
    // The model read the third line as code, but marked got `<⁠i>xx#` (a joiner after `<`) and lexed the rest as one
    // 40 KB paragraph, every `*` raw: 25 s in V8, in the app's Markdown worker. b943538 cut it at 20,000.
    await boot(page)
    const content = "1.   *\n<i>xx#\n\t" + "*a ".repeat(13_333)
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [root("s"), element("s", "Stack", {}, ["m"]), element("m", "Markdown", { content })])}\n`,
    )
    const surface = untrusted(page)
    await expect(surface.locator("[data-gu-cut]")).toContainText(
      `Showing the first 14 of ${(40_014).toLocaleString()} characters`,
    )
    expect(await issueText(surface)).toContain("indent such lines")
    // The same with indented code after the line (4,310 code blocks the model did not count, in 98 KB).
    await page.evaluate(() => window.__genui.appendUser("code"))
    await say(page, canvasDoc(Array.from({ length: 5800 }, () => "1.   *\n<i> #\n\t-").join("\n\n")))
    const canvas = canvasOf(page)
    await expect(canvas.locator("[data-gu-cut]")).toContainText("Showing the first 13 of")
    expect(await issueText(canvas)).toContain("indent such lines")
  })

  test("in Chromium, the model reads adversarial texts, and marked lexes what shows, in bounded tasks", async ({
    page,
  }) => {
    test.slow()
    await boot(page)
    await recordLongTasks(page)
    // Each shape's text, the model's reading of it (markdownShape) and marked's block lexing of what shows, each in a
    // task of its own; the longest task of each phase, from the page's long-task entries.
    const repo = fileURLToPath(new URL("../..", import.meta.url))
    const rows = await page.evaluate(async (repo) => {
      const markdown = await import(/* @vite-ignore */ `/@fs${repo}src/gui/components/markdown.ts`)
      const { Lexer } = await import(/* @vite-ignore */ `/@fs${repo}node_modules/marked/lib/marked.esm.js`)
      const record = window as unknown as { __r8m: number[]; __r8mObserver: PerformanceObserver }
      const task = <T>(work: () => T) =>
        new Promise<T>((resolve) => setTimeout(() => resolve(work()), 0)).then(async (value) => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return value
        })
      const longest = () => {
        for (const entry of record.__r8mObserver.takeRecords()) record.__r8m.push(entry.duration)
        const value = Math.max(0, ...record.__r8m)
        record.__r8m.length = 0
        return value
      }
      const repeat = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
      const shapes: Record<string, (length: number) => string> = {
        "paragraphs between rules": (length) => repeat("a\n***\n", length),
        "a list item's short lines": (length) => "- a\n" + repeat("y\n", length),
        "quoted list items with lazy lines": (length) => repeat("> - a\nlazy\n", length),
        "quoted code with lazy lines": (length) => repeat(">     a\nlazy\n", length),
        "a table between rules": (length) => "h|h\n-|-\n" + repeat("r|r\n***\nx\n***\n", length),
        "task items": (length) => repeat("- [ ] a\n", length),
        "tables of the wrong width": (length) => repeat("a|b\n-|-|-\n", length),
        "lists nested eight deep, lazy lines": (length) => "- ".repeat(8) + "a\n" + repeat("y\n", length),
        "headings and indented code": (length) => repeat("#\n\tc\n", length),
        // A lazy line neutralizing lengthens, before a run of `*a ` [R8S-1], or before indented code [R8S-2].
        "a lengthened lazy line, then a paragraph": (length) => "1.   *\n<i>xx#\n\t" + repeat("*a ", length),
        "lengthened lazy lines, then code": (length) => repeat("1.   *\n<i> #\n\t-\n\n", length),
        // An ordinary one, which shows whole [R8F-2]: a quoted list whose items go on to a line without the `>`.
        "ordinary: a quoted list with lazy lines": (length) => {
          const words =
            "the scheduler retries jobs whose window overlaps a deploy cache invalidation config service request handler token user session queue worker index migration rollback build release pipeline cluster node metric alert latency budget storage backup restore schema field value default option flag endpoint client server proxy route header payload response error timeout".split(
              " ",
            )
          let state = 7
          const draw = () =>
            Math.floor(((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32) * words.length)
          const sentence = (count: number) => `${Array.from({ length: count }, () => words[draw()]).join(" ")}.`
          let text = ""
          while (text.length < length) text += `> - ${sentence(8)}\n${sentence(6)}\n`
          return text
        },
      }
      // What genui hands marked: the parts of what shows, neutralized (and checked as the model read them).
      const lexed = (text: string, cut: { shown: number }) => {
        for (const part of markdown.prepareMarkdown(text, "Image", cut) as { kind: string; text?: string }[])
          if (part.kind === "markdown") new Lexer().blockTokens(part.text)
      }
      // A reference measured next to each shape: marked on the ordinary document, which shows whole, at the same load.
      const ordinary = shapes["ordinary: a quoted list with lazy lines"]!(100_000)
      const out: { name: string; length: number; model: number; marked: number; reference: number; reason?: string }[] =
        []
      for (const [name, shape] of Object.entries(shapes))
        for (const length of [100_000]) {
          const text = await task(() => shape(length))
          longest()
          const { cut } = await task(() => markdownShape(text))
          const model = longest()
          await task(() => lexed(ordinary, { shown: ordinary.length }))
          const reference = longest()
          await task(() => lexed(text, cut))
          out.push({ name, length, model, marked: longest(), reference, reason: cut.reason })
        }
      return out
      function markdownShape(text: string) {
        return markdown.markdownShape(text) as { cut: { shown: number; reason?: string } }
      }
    }, repo)
    for (const { name, length, model, marked, reference, reason } of rows) {
      const shape = `${name} (${length / 1000} KB)`
      expect({ shape, cut: reason !== undefined }).toEqual({ shape, cut: !name.startsWith("ordinary") })
      // The model reads a 100 KB text within the 1 s target (30 to 160 ms unloaded; test/unit/review8-markdown.test.ts
      // checks it is linear up to 500 KB).
      expect({ shape, model: model < 1000 }).toEqual({ shape, model: true })
      // marked: 0.7 to 3.7 s for these shapes at 100 KB before. What shows of them costs it at most MAX_BLOCK_WORK
      // (110 to 250 ms here unloaded, the ordinary document 60 to 140 ms): within BLOCKED_MS, or three times the
      // reference when the machine is loaded [R8F-2].
      expect({ shape, marked: marked < Math.max(BLOCKED_MS, 3 * reference) }).toEqual({ shape, marked: true })
    }
  })
})
