import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { add, block, element, root } from "../../playground/scenarios/build.ts"

// Regression tests for the eighth review's Markdown findings ([R7S2-2], [R7S1-5], [R7F2-3], [R7F2-2], [R7F1-1],
// [R7S2-4]), the ninth's ([R8S-1], [R8S-2], [R8F-2], [R8C-1], [R8C-2]), the tenth's ([R8D-1], [R8D-2], [R8E-1]), the
// eleventh's ([R8G-1]) and the twelfth's ([R8H-1], [R8H-2]) in the playground. Timing is the page's own long tasks
// (PerformanceObserver "longtask"), with each message appended in a task of the page's own. The playground's
// ui.Markdown is not marked, so marked's block lexing is timed in the page on its own (the model's cut decides what it
// gets). See test/unit/review8-markdown.test.ts.

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
    expect(await issueText(surface)).toContain("too many and too close")
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

  test("the render charge of Markdown that never shows neutralizes nothing: a closed Accordion of 495 KB texts [R8C-1]", async ({
    page,
  }) => {
    // Charging each text neutralized and checked it, and one that diverges at its end twice: four such items in a
    // 103 KB spec, which the budget then refuses, blocked the window 2 s (0.11 s before), and 41 s with relative links
    // (each a caught exception, slow with an inspector attached).
    await boot(page)
    // The markdown.ts the page runs (the playground serves the sources: imported by the very URL the page loaded it
    // from, it is the same module), for its count of the lines the model read and neutralizing wrote.
    const work = () =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((name) => /\/src\/gui\/components\/markdown\.ts(\?|$)/.test(name))
        const markdown = await import(/* @vite-ignore */ url!)
        return markdown.markdownWork() as { modeled: number; neutralized: number }
      })
    const lines = (line: string) => {
      const out: string[] = []
      for (let length = 0, index = 0; length < 99_000; index++) {
        out.push(index % 3 === 2 ? "" : line)
        length += out.at(-1)!.length + 1
      }
      return out.join("\n")
    }
    for (const line of ["[a](http://b.c) [c](http://d.e) [f](http://g.h)", "[a](b) [c](d) [e](f) [g](h)"]) {
      await page.evaluate(() => window.__genui.appendUser("go"))
      const items = [0, 1, 2, 3].map((index) => ({
        title: `Item ${index}`,
        content: { $template: "${/s}".repeat(5) + `\n\n1.   *\n<i> #\n\t-\nend ${index}` },
      }))
      const before = await work()
      await recordLongTasks(page)
      await say(
        page,
        `Here:\n\n${block("spec", undefined, [
          add("/state", { s: lines(line) }),
          root("a"),
          element("a", "Accordion", { items, type: "multiple", defaultOpen: [] }),
        ])}\n`,
      )
      const surface = page.locator('[data-genui][data-surface="inline"]').last()
      expect(await issueText(surface)).toContain("the UI is too large")
      await settle(page)
      const after = await work()
      // The charge read the items (the model, as written) and neutralized none of them: nothing of them renders. This
      // is what bounds the task, whatever the machine's load (it compared the longest task with 400 ms, which a
      // loaded machine failed now and then on these 113 to 490 ms [R8E-1]).
      expect(after.modeled).toBeGreaterThan(before.modeled)
      expect({ line, neutralized: after.neutralized - before.neutralized }).toEqual({ line, neutralized: 0 })
      // And a ceiling with room for any load (the 2 s of before is past it).
      const longest = await longestTask(page)
      expect({ line, blocked: longest < 1000 }).toEqual({ line, blocked: true })
    }
  })

  test("a text of tiny links, emphases or code spans is cut or refused for them, in a bounded task [R8D-2]", async ({
    page,
  }) => {
    // Only blocks counted: a 99 KB spec whose `$template` built 480 KB of bare addresses (53,000 links), emphases or
    // code spans (80,000) blocked the playground 1.5 to 2.1 s in one task, building them all.
    test.slow()
    await boot(page)
    const lines = (line: string, size: number) => {
      const out: string[] = []
      for (let length = 0, index = 0; length < size; index++) {
        out.push(index % 3 === 2 ? "" : line)
        length += out.at(-1)!.length + 1
      }
      return out.join("\n")
    }
    const spec = (line: string, size: number) =>
      `Here:\n\n${block("spec", undefined, [
        add("/state", { s: lines(line, size) }),
        root("m"),
        element("m", "Markdown", { content: { $template: "${/s}".repeat(5) } }),
      ])}\n`
    for (const [line, tag] of [
      ["www.a www.b www.c www.d", "a"],
      ["*a* *b* *c* *d* *e*", "em"],
      ["`a` `b` `c` `d` `e`", "code"],
    ] as const) {
      // 480 KB of them: more than a UI holds once they are charged, so the budget refuses the element, and says so.
      await page.evaluate(() => window.__genui.appendUser("go"))
      await recordLongTasks(page)
      await say(page, spec(line, 96_000))
      const big = page.locator('[data-genui][data-surface="inline"]').last()
      expect(await issueText(big)).toContain("the UI is too large")
      await settle(page)
      await expect(big.locator(tag)).toHaveCount(0)
      // A ceiling with room for any load (the 1.5 to 2.1 s of before is past it; 0.1 to 0.15 s now, unloaded).
      expect({ line, blocked: (await longestTask(page)) < 1000 }).toEqual({ line, blocked: true })
      // 96 KB of them: shown up to where they pass the bound, 10,000 beyond one per 25 characters, with a note, and an
      // issue that says why; before, all 16,000 of them and their paragraphs.
      await page.evaluate(() => window.__genui.appendUser("go"))
      await recordLongTasks(page)
      await say(page, spec(line, 19_200))
      const cut = page.locator('[data-genui][data-surface="inline"]').last()
      const note = cut.locator("[data-gu-cut]")
      await expect(note).toContainText("Showing the first")
      expect(await issueText(cut)).toContain("links, emphases or code spans")
      await settle(page)
      const shown = Number(/first ([\d,]+)/.exec((await note.textContent()) ?? "")![1]!.replaceAll(",", ""))
      const built = await cut
        .locator('[data-gu="markdown"]')
        .evaluate(
          (markdown) =>
            markdown.querySelectorAll("p, li, h1, h2, h3, h4, blockquote, td, th, hr, a, em, strong, code, del, br")
              .length,
        )
      expect(await cut.locator(`[data-gu="markdown"] ${tag}`).count()).toBeGreaterThan(5000)
      expect({ line, built: built <= 10_000 + Math.floor(shown / 25) }).toEqual({ line, built: true })
      expect({ line, blocked: (await longestTask(page)) < 1000 }).toEqual({ line, blocked: true })
    }
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
        // The same with one column, and lines between rules that start with spaces or a run of `|-`, which marked's
        // setext rule reads slowest [R8C-2].
        "a one-column table between rules": (length) => "|h|\n|-|\n" + repeat("|r|\n***\nx\n***\n", length),
        "indented lines between rules": (length) => repeat("   a\n***\n", length),
        "runs of |- between rules": (length) => repeat("|-|-|-|-|-|-|-|-|-|-|-|-|-|-|x\n***\n", length),
        // Lines neutralizing lengthens (a bare `www.` address tenfold), which marked's scans read by the character,
        // and lines of spaces and `|`, and quoted lists of short lines, which it read more slowly than the model
        // weighed: 0.2 to 0.93 s each [R8D-1].
        "a list item's lines of www.a": (length) => "- a\n" + repeat("www.a\n", length),
        "a quoted item's lines of www.a": (length) => "> - a\n" + repeat("www.a\n", length),
        "addresses between rules": (length) => repeat("www.a.b www.c.d\n***\n", length),
        "spaces and pipes between rules": (length) => repeat("   | | | | | | | |x\n***\n", length),
        "quoted items of short lines": (length) =>
          repeat("> - the scheduler retries jobs whose\nwindow overlaps a\n", length),
        "task items": (length) => repeat("- [ ] a\n", length),
        "tables of the wrong width": (length) => repeat("a|b\n-|-|-\n", length),
        "headers of one column over two": (length) => repeat("a\n-|-\n", length),
        "lists nested eight deep, lazy lines": (length) => "- ".repeat(8) + "a\n" + repeat("y\n", length),
        "headings and indented code": (length) => repeat("#\n\tc\n", length),
        // A lazy line neutralizing lengthens, before a run of `*a ` [R8S-1], or before indented code [R8S-2].
        "a lengthened lazy line, then a paragraph": (length) => "1.   *\n<i>xx#\n\t" + repeat("*a ", length),
        "lengthened lazy lines, then code": (length) => repeat("1.   *\n<i> #\n\t-\n\n", length),
        // An ordinary one, which shows whole [R8F-2]: a quoted list whose items go on to a line without the `>`. (At
        // 80 KB since [R8D-1]: marked takes twice as long on such lists when the text has a character outside Latin-1,
        // and the bound weighs that, so at 100 KB it is cut at about 80.)
        "ordinary: a quoted list with lazy lines": (size) => {
          const length = Math.min(size, 80_000)
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
      const handed = (text: string) =>
        markdown.renderMarkdown(text, "Image") as {
          cut: { shown: number; reason?: string }
          parts: { kind: string; text?: string }[]
        }
      const lexed = (text: string) => {
        const { cut, parts } = handed(text)
        for (const part of parts) if (part.kind === "markdown") new Lexer().blockTokens(part.text)
        return cut
      }
      // A reference measured next to each shape: marked on the ordinary document, which shows whole, at the same load.
      const ordinary = shapes["ordinary: a quoted list with lazy lines"]!(100_000)
      const out: {
        name: string
        length: number
        model: number
        marked: number
        reference: number
        reason?: string
        work: number
      }[] = []
      for (const [name, shape] of Object.entries(shapes))
        for (const length of [100_000]) {
          const text = await task(() => shape(length))
          longest()
          await task(() => markdown.markdownShape(text))
          const model = longest()
          await task(() => lexed(ordinary))
          const reference = longest()
          const cut = await task(() => lexed(text))
          const marked = longest()
          // The model's work on the parts marked got, each lexed on its own, as marked lexes them: neutralized, not as
          // written (which bounded it on lines up to ten times shorter [R8D-1]).
          let work = 0
          for (const part of handed(text).parts)
            if (part.kind === "markdown") work += (markdown.blockStructure(part.text!) as { work: number }).work
          out.push({ name, length, model, marked, reference, reason: cut.reason, work })
        }
      return { out, bound: markdown.MAX_BLOCK_WORK as number }
    }, repo)
    for (const { name, length, model, marked, reference, reason, work } of rows.out) {
      const shape = `${name} (${length / 1000} KB)`
      // Each adversarial shape is cut, and what marked gets of it is within the model's bound on its block work
      // (MAX_BLOCK_WORK, calibrated in Chromium at 1 to 3.9 ns a unit on these shapes, as marked gets them, and the
      // quoted lists of test/unit/review8-markdown.test.ts, so 40 to 155 ms): what keeps marked's time bounded,
      // whatever the load.
      expect({ shape, cut: reason !== undefined }).toEqual({ shape, cut: !name.startsWith("ordinary") })
      expect({ shape, work: work <= rows.bound }).toEqual({ shape, work: true })
      // The model reads a 100 KB text within the 1 s target (30 to 160 ms unloaded; test/unit/review8-markdown.test.ts
      // checks it is linear up to 500 KB).
      expect({ shape, model: model < 1000 }).toEqual({ shape, model: true })
      // marked: 0.7 to 3.7 s for these shapes at 100 KB before; what shows of them takes it 40 to 150 ms unloaded (the
      // ordinary document 60 to 140 ms). A ceiling with room for any load: under 1 s, or three times the ordinary
      // document measured next to it. (This compared with 400 ms, or three times the reference, which a loaded machine
      // passed on a table between rules only by a few percent: the model weighed its lines by their characters alone,
      // at twice the time a unit of the other shapes took [R8C-2].)
      expect({ shape, marked: marked < Math.max(1000, 3 * reference) }).toEqual({ shape, marked: true })
    }
  })
})

test.describe("a cut that would not read alike steps back, rather than showing nothing [R8G-1]", () => {
  test("quoted lists whose items go on to lazy lines show most of what their charge allows, with a note", async ({
    page,
  }) => {
    // The cut for marked's work landed on a quoted item's lazy line, where the rows before it did not read as they
    // did, so the text was cut at its start: "Showing the first 0 of 20,000 characters" (and of 44,000), no link, where
    // the charge allowed all of it. Now it is cut before that item.
    await boot(page)
    const words = "alpha beta gamma delta service cache token queue".split(" ")
    let state = 3
    const word = () => words[(state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % words.length]!
    let references = ""
    while (references.length < 44_000)
      references += `> - ${word()} ${word()} [${word()}](https://${word()}.io)\n${word()} https://${word()}.dev/x\n`
    for (const content of ["> - www.a\nwww.b\n".repeat(1250), references]) {
      await page.evaluate(() => window.__genui.appendUser("go"))
      await say(page, `Here:\n\n${block("spec", undefined, [root("m"), element("m", "Markdown", { content })])}\n`)
      const surface = page.locator('[data-genui][data-surface="inline"]').last()
      const note = surface.locator("[data-gu-cut]")
      await expect(note).toContainText(`of ${content.length.toLocaleString()} characters`)
      const shown = Number(/first ([\d,]+)/.exec((await note.textContent()) ?? "")![1]!.replaceAll(",", ""))
      expect({ length: content.length, shown: shown > content.length / 2 }).toEqual({
        length: content.length,
        shown: true,
      })
      expect(await surface.locator('[data-gu="markdown"] a').count()).toBeGreaterThan(500)
      expect(await issueText(surface)).toContain("blank lines")
    }
  })
})

test.describe("a loose list cut before the blank line that made it loose reads as a tight one [R8H-1]", () => {
  test("a long first item of a loose list shows most of what its charge allows, with links and a note", async ({
    page,
  }) => {
    // Cut for marked's work inside the first item, the list was tight, and the rows before the cut did not read as
    // they did: "Showing the first 10 of 12,037 characters" (8 of 20,026), no link and no list item, where the charge
    // allowed all of it; the issue's advice (blank lines between items) was what made the list loose.
    await boot(page)
    const texts = [
      "## Links\n\n- References:\n" + "  www.a.com\n".repeat(1000) + "\n- Next item\n",
      "Intro.\n\n- Sources\n" + "  [a](https://a.io)\n".repeat(1000) + "\n- More\n",
    ]
    for (const content of texts) {
      await page.evaluate(() => window.__genui.appendUser("go"))
      await say(page, `Here:\n\n${block("spec", undefined, [root("m"), element("m", "Markdown", { content })])}\n`)
      const surface = page.locator('[data-genui][data-surface="inline"]').last()
      const note = surface.locator("[data-gu-cut]")
      await expect(note).toContainText(`of ${content.length.toLocaleString()} characters`)
      const shown = Number(/first ([\d,]+)/.exec((await note.textContent()) ?? "")![1]!.replaceAll(",", ""))
      expect({ length: content.length, shown: shown > content.length / 2 }).toEqual({
        length: content.length,
        shown: true,
      })
      expect(await surface.locator('[data-gu="markdown"] a').count()).toBeGreaterThan(500)
      expect(await issueText(surface)).toContain("between the lines of a long item")
    }
  })
})

test.describe("a link at the column where marked cuts a list item's lazy line keeps the item whole [R8H-2]", () => {
  test("a loose list whose item goes on to a line starting with a one-character link shows whole, every link", async ({
    page,
  }) => {
    // genui's `[x](#genui-link:…)` put its `#` at the column where marked cuts the item's lazy line, where marked read a
    // heading and ended the item: "Showing the first 8 of 33,593 characters", no list item. The address is written in
    // angle brackets there now, the same link.
    await boot(page)
    const item = (i: number) => `  - item ${i} [ref](https://a.io/${i})\nmore text about ${i}\n`
    const items = (from: number) => Array.from({ length: 300 }, (_, i) => item(from + i)).join("")
    const content = `Intro.\n\n${items(0)}  - nested\n[x](https://b.io)\nafter\n${items(300)}\n  - last\n`
    await say(page, `Here:\n\n${block("spec", undefined, [root("m"), element("m", "Markdown", { content })])}\n`)
    const surface = page.locator('[data-genui][data-surface="inline"]').last()
    await expect(surface.getByText("more text about 599")).toBeVisible({ timeout: 20_000 })
    await expect(surface.locator("[data-gu-cut]")).toHaveCount(0)
    await expect(surface.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
    const links = surface.locator('[data-gu="markdown"] a')
    expect(await links.count()).toBe(601)
    // The one written in angle brackets is a link like the others: genui's address, no new window.
    const bracketed = surface.locator('[data-gu="markdown"] a', { hasText: /^x$/ })
    await expect(bracketed).toHaveAttribute("href", /^#genui-link:https%3A%2F%2Fb%2Eio/)
    await expect(bracketed).not.toHaveAttribute("target", /./)
  })
})
