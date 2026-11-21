import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { add, block, element, replace, root } from "../../playground/scenarios/build.ts"

// Regression tests for the eighth review's memory finding ([R7S2-1], the [R7A-5] class): what rendered element
// instances keep of their resolved props is bounded, whatever they are, and a row whose props would build megabytes
// is refused at its parent before json-render builds it. Heap after a full garbage collection (CDP); timing as the page's
// own long tasks (PerformanceObserver "longtask"), with each message appended in a task of the page's own. See
// test/unit/review8-memory.test.ts for the same below the renderer.

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
/** The most the heap may grow for a block that, before, grew it by gigabytes (until the renderer crashed). */
const GROWTH_MB = 100

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

/** The page's JS heap after a full garbage collection, in MB. */
async function heapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  const { usedSize } = await cdp.send("Runtime.getHeapUsage")
  await cdp.detach()
  return usedSize / 1e6
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
const canvas = (page: Page) => page.locator('[data-genui][data-surface="canvas"]')

/**
 * The R7S2-1 block: a text of 90,000 characters in state, and a repeat of `rows` rows whose Text has `props` props, each
 * a $template (or $concat) that reads it eleven times: a million characters per prop, from 80 characters written.
 */
function building(rows: number, props: number, kind: "template" | "concat" = "template", big = 90_000): string[] {
  const built = () =>
    kind === "template"
      ? { $template: "${/big}".repeat(11) }
      : { $concat: Array.from({ length: 11 }, () => ({ $state: "/big" })) }
  const values = Object.fromEntries(
    Array.from({ length: props }, (_, index) => [index === 0 ? "text" : `p${index}`, built()]),
  )
  return [
    add("/state", { big: "x".repeat(big), rows: Array.from({ length: rows }, () => 0) }),
    root("s"),
    element("s", "Stack", {}, ["w"], { repeat: { statePath: "/rows" } }),
    element("w", "Text", values),
  ]
}

test.describe("what rendered elements keep is bounded [R7S2-1]", () => {
  // Before: each task built 4 million more characters that the rows kept (every row's resolved props), so one block of
  // 95 KB, untrusted and without a click, grew the heap by gigabytes and crashed the renderer in about 23 s.
  const shapes: Array<{
    readonly name: string
    readonly send: (page: Page) => Promise<unknown>
    readonly ui: (page: Page) => ReturnType<Page["locator"]>
  }> = [
    {
      name: "2,000 rows of four templates, in tool output",
      send: (page) => toolOutput(page, `Here:\n\n${block("spec", undefined, building(2000, 4))}\n`),
      ui: untrusted,
    },
    {
      name: "2,000 rows of four $concat, in tool output",
      send: (page) => toolOutput(page, `Here:\n\n${block("spec", undefined, building(2000, 4, "concat"))}\n`),
      ui: untrusted,
    },
    {
      name: "2,000 rows of four templates, as the agent's canvas",
      send: (page) => say(page, block("canvas", { canvas: "mem", title: "Mem" }, building(2000, 4))),
      ui: canvas,
    },
  ]
  for (const shape of shapes)
    test(`${shape.name} keep a bounded heap and are reported`, async ({ page }) => {
      test.setTimeout(90_000)
      await boot(page)
      const before = await heapMB(page)
      await recordLongTasks(page)
      await shape.send(page)
      await expect(shape.ui(page).locator('[data-gu-chrome="issues"]')).toContainText("the UI is too large", {
        timeout: 20_000,
      })
      await settle(page)
      expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
      expect((await heapMB(page)) - before).toBeLessThan(GROWTH_MB)
      // The one row that fits keeps what its UI may keep; the rest of its props are left empty, and said so.
      await expect(shape.ui(page).locator('[data-gu-chrome="issues"]')).toContainText("left some of its props empty")
    })

  test("five such blocks in tool output share one bound", async ({ page }) => {
    test.setTimeout(120_000)
    await boot(page)
    const before = await heapMB(page)
    await recordLongTasks(page)
    for (let index = 0; index < 5; index++)
      await toolOutput(page, `Here:\n\n${block("spec", undefined, building(2000, 4))}\n`)
    await expect(untrusted(page)).toHaveCount(5)
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
    expect((await heapMB(page)) - before).toBeLessThan(GROWTH_MB)
  })

  test("when the agent makes the text its rows read long, what they keep stays bounded", async ({ page }) => {
    test.setTimeout(90_000)
    // The rows fit while the text is one character, so all 2,000 are built; the agent's patch makes it 90,000: every
    // row's props would build 4 million characters, and only what its UI may keep is kept.
    await boot(page)
    const before = await heapMB(page)
    await recordLongTasks(page)
    await say(page, block("canvas", { canvas: "grow", title: "Grow" }, building(2000, 4, "template", 1)))
    await expect.poll(() => canvas(page).locator('[data-gu="text"]').count(), { timeout: 20_000 }).toBeGreaterThan(1000)
    // Only what the patch sets off is timed: the rows have all mounted (rendering 2,000 rows takes tasks of its own).
    await settle(page)
    await recordLongTasks(page)
    await say(page, block("canvas", { canvas: "grow" }, [replace("/state/big", "y".repeat(90_000))]))
    await expect(canvas(page).locator('[data-gu-chrome="issues"]')).toContainText("left some of its props empty", {
      timeout: 20_000,
    })
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
    expect((await heapMB(page)) - before).toBeLessThan(GROWTH_MB)
  })

  test("what remounted blocks kept is given back", async ({ page }) => {
    test.setTimeout(120_000)
    // Timeline rows unmount when they scroll out and mount again when they come back: each time, every instance gives
    // back what it kept and takes it again, so the heap stays where it was and the issue comes back.
    await boot(page)
    for (let index = 0; index < 3; index++)
      await toolOutput(page, `Here:\n\n${block("spec", undefined, building(2000, 4))}\n`)
    await expect(untrusted(page)).toHaveCount(3)
    await recordLongTasks(page)
    await settle(page)
    const first = await heapMB(page)
    for (let round = 0; round < 4; round++) {
      await page.evaluate(() => window.__genui.virtualize(true))
      await expect(untrusted(page)).toHaveCount(0)
      await page.evaluate(() => window.__genui.virtualize(false))
      await expect(untrusted(page)).toHaveCount(3)
      await settle(page)
    }
    expect((await heapMB(page)) - first).toBeLessThan(20)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
    // The blocks share one pool: whichever mounts first holds the room (the one row that fits, and what it keeps).
    await expect(
      untrusted(page).locator('[data-gu-chrome="issues"]', { hasText: "left some of its props empty" }),
    ).toHaveCount(1)
  })
})

test.describe("ordinary UIs built with expressions show whole [R7S2-1]", () => {
  test("2,000 rows of short templated strings, and a Markdown text of 450,000 characters built with $template", async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await boot(page)
    const rows = Array.from({ length: 1998 }, (_, index) => ({ name: `item ${index}`, price: index * 3 }))
    const word = "lorem ipsum dolor sit amet, consectetur adipiscing elit. "
    const text = word
      .repeat(Math.ceil(90_000 / word.length))
      .slice(0, 89_990)
      .replace(/(.{1,9000})/g, "$1\n\n")
    await say(
      page,
      [
        block("spec", undefined, [
          add("/state", { rows, cur: "EUR" }),
          root("s"),
          element("s", "Stack", {}, ["t"], { repeat: { statePath: "/rows" } }),
          element("t", "Text", { text: { $template: "${name}: ${price} ${/cur}" } }),
        ]),
        block("spec", undefined, [
          add("/state", { s: text }),
          root("m"),
          element("m", "Markdown", { content: { $template: "${/s}".repeat(5) } }),
        ]),
      ].join("\n\n"),
    )
    const list = page.locator('[data-genui][data-surface="inline"]').nth(0)
    const markdown = page.locator('[data-genui][data-surface="inline"]').nth(1)
    await expect.poll(() => list.locator('[data-gu="text"]').count(), { timeout: 30_000 }).toBe(1998)
    await expect(list.locator('[data-gu="text"]').last()).toHaveText("item 1997: 5991 EUR")
    await expect
      .poll(async () => (await markdown.textContent())?.length ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(449_000)
    await expect(list.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
    await expect(markdown.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
  })
})
