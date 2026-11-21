import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { add, block, element, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the seventh review's cost audit ([R7A-<n>]): blocks of up to about 100 KB whose work no bound
// counted, each of which froze the window for seconds (or crashed it) at HEAD. Each test measures the page's own long
// tasks (PerformanceObserver "longtask"), with the message appended in a task of the page's own, as the server's would
// be. See test/unit/review7-audit.test.ts for the same below the renderer.

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

/** The longest task allowed where HEAD took seconds: well under the 1 s target, with room for a loaded machine. */
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
    const record = window as unknown as { __r7a: number[]; __r7aObserver?: PerformanceObserver }
    record.__r7aObserver?.disconnect()
    record.__r7a = []
    record.__r7aObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record.__r7a.push(entry.duration)
    })
    record.__r7aObserver.observe({ type: "longtask" })
  })
const longestTask = (page: Page) =>
  page.evaluate(() => {
    const record = window as unknown as { __r7a: number[]; __r7aObserver?: PerformanceObserver }
    for (const entry of record.__r7aObserver?.takeRecords() ?? []) record.__r7a.push(entry.duration)
    return Math.max(0, ...record.__r7a)
  })

/** Waits until no long task was recorded for `quiet` ms. */
async function settle(page: Page, quiet = 1500) {
  let count = -1
  let since = Date.now()
  for (;;) {
    const now = await page.evaluate(() => (window as unknown as { __r7a: number[] }).__r7a.length)
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
const issuesOf = (scope: ReturnType<Page["locator"]>) => scope.locator('[data-gu-chrome="issues"]')

test.describe("blocks that froze the window at HEAD stay within the target [R7A]", () => {
  test("a lattice of relative repeats is validated in linear time [R7A-1]", async ({ page }) => {
    // HEAD: one task of 5.3 s for 20 layers (5.6 KB), 24.7 s for 22.
    await boot(page)
    const lines = [state("/x", []), root("r"), element("r", "Stack", {}, ["a1", "b1"], { repeat: { statePath: "/x" } })]
    for (let layer = 1; layer <= 20; layer++) {
      const children = layer < 20 ? [`a${layer + 1}`, `b${layer + 1}`] : ["leaf"]
      lines.push(element(`a${layer}`, "Stack", {}, children, { repeat: { statePath: { $item: "a" } } }))
      lines.push(element(`b${layer}`, "Stack", {}, children, { repeat: { statePath: { $item: "b" } } }))
    }
    lines.push(element("leaf", "Text", { text: "leaf" }))
    await recordLongTasks(page)
    await toolOutput(page, `Here:\n\n${block("spec", undefined, lines)}\n`)
    await expect(untrusted(page)).toHaveCount(1)
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })

  test("a deep pointer in a spec patch is a line error, not seconds of work [R7A-3]", async ({ page }) => {
    // HEAD: 6.4 s and 1.3 GB on arrival, then a stack overflow in the code block's render.
    await boot(page)
    await recordLongTasks(page)
    const deep = "/a".repeat(50_000)
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [root("t"), element("t", "Text", { text: "shown" }), add(`/state${deep}`, 1)])}\n`,
    )
    await expect(untrusted(page).getByText("shown")).toBeVisible()
    await expect(issuesOf(untrusted(page))).toContainText("a path has at most 2,048 characters and 64 levels")
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })

  test("a deep setState path is refused: a click costs nothing and crashes nothing [R7A-3]", async ({ page }) => {
    // HEAD: 2.0 s per click at 35,000 segments (70 KB), and the renderer crashed at 50,000.
    await boot(page)
    const deep = "/a".repeat(50_000)
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [
        root("b"),
        element("b", "Button", { label: "Go" }, [], {
          on: { press: [{ action: "setState", params: { statePath: deep, value: 1 } }] },
        }),
      ])}\n`,
    )
    const surface = untrusted(page)
    await expect(issuesOf(surface)).toContainText("on.press's statePath: the path is")
    await recordLongTasks(page)
    await surface.getByRole("button", { name: "Go" }).click()
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
    await expect(surface.getByRole("button", { name: "Go" })).toBeVisible()
  })

  test("an agent canvas patch with a deep pointer neither blocks nor throws into the host [R7A-3]", async ({
    page,
  }) => {
    // HEAD: 2.2 s and 1.4 GB, then a RangeError out of the session index into the host's message update.
    await boot(page)
    await say(
      page,
      block("canvas", { canvas: "d", title: "Deep" }, [root("t"), element("t", "Text", { text: "base" })]),
    )
    await expect(page.locator('[data-genui][data-surface="canvas"]').getByText("base")).toBeVisible()
    await recordLongTasks(page)
    await say(page, block("canvas", { canvas: "d" }, [add(`/state${"/a".repeat(50_000)}`, 1)]))
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
    await expect(page.locator('[data-genui][data-surface="canvas"]').getByText("base")).toBeVisible()
  })

  test("an element's watched paths are bounded, for every instance [R7A-2]", async ({ page }) => {
    // HEAD: 4,000 entries of a Text watching 7,000 paths (99 KB, each bound to {}): one task of 11 s and 470 MB. Here
    // 1,000 entries of 1,500 paths with a binding each (about 85 KB), about 0.6 s at HEAD (4,000 entries took 2.4 s).
    // With the bound, the arrival's first task is about 120 ms on an idle machine: 1,000 entries rather than 4,000
    // leave room for four workers on four CPUs (at 4,000, about 200 ms idle, it passed 400 ms under that load).
    await boot(page)
    const binding = { action: "setState", params: { statePath: "/q", value: 1 } }
    const watch = Object.fromEntries(Array.from({ length: 1500 }, (_, index) => [`/p${index}`, binding]))
    await recordLongTasks(page)
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [
        root("s"),
        element(
          "s",
          "Stack",
          {},
          Array.from({ length: 1000 }, () => "w"),
        ),
        element("w", "Text", { text: "." }, [], { watch }),
      ])}\n`,
    )
    await expect(issuesOf(untrusted(page))).toContainText("watches 1,500 state paths")
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })

  test("an element's props are bounded, for every instance [R7A-5]", async ({ page }) => {
    // HEAD: 4,000 entries of a Text with 7,000 props (85 KB): a first task of 5.7 s, 25 s of tasks and 850 MB. Here 1,000
    // entries (73 KB), about 1.4 s at HEAD; with the bound, a first task of about 115 ms on an idle machine (see R7A-2
    // for why 1,000).
    await boot(page)
    const props = Object.fromEntries(Array.from({ length: 7000 }, (_, index) => [`k${index}`, 0]))
    await recordLongTasks(page)
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [
        root("s"),
        element(
          "s",
          "Stack",
          {},
          Array.from({ length: 1000 }, () => "w"),
        ),
        element("w", "Text", { ...props, text: "." }),
      ])}\n`,
    )
    await expect(issuesOf(untrusted(page))).toContainText("has 7,001 props")
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })

  test("a Markdown text's code blocks are bounded and charged [R7A-4]", async ({ page }) => {
    // HEAD: 12 Markdown elements reading a text of 3,900 fences (52 KB) built 46,800 code blocks of their own, each the
    // app's code block component (tasks of 1.4 s, 508 MB). Each code block now costs the render budget: such a text is
    // more than a UI shows, and says so.
    await boot(page)
    const fences = (count: number) =>
      Array.from({ length: count }, (_, index) => `\`\`\`\nx${index}\n\`\`\``).join("\n")
    const ids = Array.from({ length: 12 }, (_, index) => `m${index}`)
    await recordLongTasks(page)
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [
        state("/md", fences(3900)),
        root("s"),
        element("s", "Stack", {}, ids),
        ...ids.map((id) => element(id, "Markdown", { content: { $state: "/md" } })),
      ])}\n`,
    )
    await expect(issuesOf(untrusted(page))).toContainText("the UI is too large")
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)

    // A text of 100 fences shows its first 32 as code blocks of their own (the playground's ui.Code is a
    // [data-component=markdown] with data-fence), the rest as code in the Markdown after them.
    await toolOutput(
      page,
      `Again:\n\n${block("spec", undefined, [root("m"), element("m", "Markdown", { content: fences(100) })])}\n`,
    )
    const text = untrusted(page).last().locator('[data-gu="markdown"]')
    await expect(text.getByText("x99", { exact: true })).toBeVisible()
    await expect(text.locator(':scope > [data-component="markdown"][data-fence]')).toHaveCount(32)
    await expect(text.locator('[data-component="markdown-code"]')).toHaveCount(100)
  })

  test("after a select-all, an agent patch to the list costs what the list costs [R7A-6]", async ({ page }) => {
    test.setTimeout(60_000)
    // HEAD: 2.2 s per agent patch that rewrote the 3,500 rows of {a: {b, c}} a select-all had ticked (an edit at a/b in
    // each row).
    await boot(page)
    const rows = (shift: number) => Array.from({ length: 3500 }, (_, index) => ({ a: { b: false, c: index + shift } }))
    await say(
      page,
      block("canvas", { canvas: "r", title: "Rows" }, [
        add("/state", { all: false, rows: rows(0) }),
        root("card"),
        element("card", "Card", { title: "Rows" }, ["go", "list"]),
        element("go", "Button", { label: "Select all" }, [], {
          on: { press: [{ action: "setState", params: { statePath: "/all", value: true } }] },
        }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows" } }),
        element("row", "Text", { text: "." }, [], {
          watch: { "/all": { action: "setState", params: { statePath: { $item: "a/b" }, value: true } } },
        }),
      ]),
    )
    const canvas = page.locator('[data-genui][data-surface="canvas"]')
    // A watch acts once its row has rendered: the select-all waits for the rows that fit (about 2,000).
    await expect.poll(() => canvas.locator('[data-gu="text"]').count(), { timeout: 20_000 }).toBeGreaterThan(1900)
    await canvas.getByRole("button", { name: "Select all" }).click()
    await recordLongTasks(page)
    await settle(page)
    await page.evaluate(() => window.__genui.appendUser("again"))
    await recordLongTasks(page)
    await say(
      page,
      block("canvas", { canvas: "r" }, [JSON.stringify({ op: "replace", path: "/state/rows", value: rows(100_000) })]),
    )
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })

  test("elements nested deeper than 20 levels are not shown, and the surface says so [R7A-7]", async ({ page }) => {
    // HEAD: past about 51 levels the stack overflowed and the rest of the UI vanished, with no issue.
    await boot(page)
    const lines = [root("e0")]
    for (let level = 0; level < 100; level++)
      lines.push(element(`e${level}`, "Stack", {}, level < 99 ? [`e${level + 1}`] : ["leaf"]))
    lines.push(element("leaf", "Text", { text: "leaf" }))
    await toolOutput(page, `Here:\n\n${block("spec", undefined, lines)}\n`)
    const surface = untrusted(page)
    await expect(issuesOf(surface)).toContainText("nested more than 20 levels deep")
    expect(await surface.locator('[data-gu="stack"]').count()).toBe(20)
    await expect(surface.getByText("leaf")).toHaveCount(0)

    // Within the bound, a chain renders whole.
    const shallow = [root("f0")]
    for (let level = 0; level < 19; level++)
      shallow.push(element(`f${level}`, "Stack", {}, level < 18 ? [`f${level + 1}`] : ["end"]))
    shallow.push(element("end", "Text", { text: "the end" }))
    await toolOutput(page, `Again:\n\n${block("spec", undefined, shallow)}\n`)
    await expect(untrusted(page).last().getByText("the end")).toBeVisible()
    await expect(issuesOf(untrusted(page).last())).toHaveCount(0)
  })

  test("a reply that names 100 canvases opens 32, and the newest one says so [R7A-8]", async ({ page }) => {
    // HEAD: a 99 KB reply naming 1,100 canvases opened 1,100 tabs and kept the window 81% busy for 85 s.
    await boot(page)
    const text = Array.from({ length: 100 }, (_, index) =>
      block("canvas", { canvas: `c${index}` }, [
        JSON.stringify({
          root: "t",
          elements: { t: { type: "Text", props: { text: `canvas ${index}` }, children: [] } },
        }),
      ]),
    ).join("\n\n")
    await recordLongTasks(page)
    await page.evaluate(
      (reply) =>
        new Promise<void>((resolve) => {
          const app = window.__genui.host.app
          const session = app.sessions.current().id
          const id = app.server.startAssistant(session)
          const size = Math.ceil(reply.length / 40)
          let at = 0
          const step = () => {
            if (at < reply.length) {
              app.server.appendText(session, id, reply.slice(at, at + size))
              at += size
              setTimeout(step, 50)
            } else {
              app.server.complete(session, id)
              resolve()
            }
          }
          setTimeout(step, 0)
        }),
      text,
    )
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
    const tabs = await page.evaluate(() => new Set(JSON.stringify(window.__genui.layout()).match(/canvas\.c\d+/g)).size)
    expect(tabs).toBe(32)
    await expect(
      page.locator('[data-surface="chip"]').filter({ hasText: "Not opened: 32 canvases were open" }),
    ).toHaveCount(68)
    await page.locator('[data-surface="chip"]').filter({ hasText: "c31" }).getByRole("button", { name: "Open" }).click()
    await expect(issuesOf(page.locator('[data-genui][data-surface="canvas"]'))).toContainText(
      "68 more canvases were not opened",
    )
  })
})
