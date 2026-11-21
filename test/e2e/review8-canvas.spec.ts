import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, replace, root } from "../../playground/scenarios/build.ts"

// Regression tests for the eighth review's canvas findings ([review8#R7F2-<n>]): the tabs auto-open keeps for canvases
// the agent closes and sends again, and what the session index keeps while a canvas streams. Timing is measured as the
// page's own long tasks (PerformanceObserver "longtask"), each delta appended in a task of the page's own, as the
// server's would be; memory as the heap after a full collection. See test/unit/review8-canvas.test.ts.

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

/** The longest task allowed: well under the 1 s target, with room for load. */
const BLOCKED_MS = 400

async function boot(page: Page) {
  await page.goto("/?scenario=empty&speed=instant&persist=0")
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(() => window.__genui.ready)
  await page.evaluate(() => window.__genui.scenarioDone)
}

const whole = (id: string, version: string) =>
  block("canvas", { canvas: id, title: id.toUpperCase() }, [
    root("t"),
    element("t", "Text", { text: `${id} ${version}` }),
  ])
const closing = (id: string) => block("canvas", { canvas: id, close: true }, [])
const patching = (id: string, text: string) =>
  block("canvas", { canvas: id }, [replace("/elements/t/props/text", text)])

/** A step of a streamed reply: a delta of text, or something the user does between two deltas. */
type Step = string | { readonly user: (page: Page) => Promise<void> }

/**
 * Streams one assistant message in the session shown when it starts: each text step is a delta appended in a task of
 * the page's own, `every` ms apart; then completes it. The reply goes on in its session whichever one is shown.
 */
async function stream(page: Page, steps: readonly Step[], every = 150) {
  await page.evaluate(() => window.__genui.appendUser("go"))
  const [message, session] = await page.evaluate(() => {
    const app = window.__genui.host.app
    const id = app.sessions.current().id
    return [app.server.startAssistant(id), id] as const
  })
  const run = (task: "append" | "complete", text = "") =>
    page.evaluate(
      ([kind, id, sessionID, delta]) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            const server = window.__genui.host.app.server
            if (kind === "append") server.appendText(sessionID, id, delta)
            else server.complete(sessionID, id)
            resolve()
          }, 0),
        ),
      [task, message, session, text] as const,
    )
  for (const step of steps) {
    if (typeof step === "string") await run("append", `${step}\n\n`)
    else await step.user(page)
    await page.waitForTimeout(every)
  }
  await run("complete")
}

/** The genui canvas tabs in the side strip, in order; a tab struck through (its canvas closed) ends in "~". */
const tabs = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-playground-tab]")].map(
      (tab) =>
        tab.getAttribute("data-playground-tab")!.replace("genui:canvas.", "") +
        (tab.hasAttribute("data-missing") ? "~" : ""),
    ),
  )
const canvas = (page: Page) => page.locator('[data-genui][data-surface="canvas"]')
const userCloses = (id: string): Step => ({
  user: (page) => page.locator(`[data-playground-tab="genui:canvas.${id}"] [data-playground-tab-close]`).click(),
})
const showSession = (which: number): Step => ({
  user: (page) => page.evaluate((index) => window.__genui.routeSession(index), which),
})

test.describe("a canvas the agent closes and sends again whole in its reply gets its tab back [R7F2-1]", () => {
  test("open, close and open again in separate deltas: the tab is open and shows the second version", async ({
    page,
  }) => {
    // Before: the close took the tab with it (the canvas was withdrawn), and the canvas sent again was never fresh
    // again, so the live canvas ended with no tab and the side region closed.
    await boot(page)
    await stream(page, ["Here is the plan.", whole("plan", "v1"), closing("plan"), "Revised:", whole("plan", "v2")])
    await expect.poll(() => tabs(page)).toEqual(["plan"])
    await expect(canvas(page).getByText("plan v2", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__genui.layout())).toMatchObject({ open: true })
  })

  test("patched after it came back, closed again, sent again: the newest version shows; closed last, no tab", async ({
    page,
  }) => {
    await boot(page)
    await stream(page, [whole("plan", "v1"), closing("plan"), whole("plan", "v2"), patching("plan", "plan v2 patched")])
    await expect.poll(() => tabs(page)).toEqual(["plan"])
    await expect(canvas(page).getByText("plan v2 patched", { exact: true })).toBeVisible()
    await stream(page, [whole("next", "v1"), closing("next"), whole("next", "v2"), closing("next")])
    // The second reply's canvas was withdrawn at the end: it leaves no tab; the first reply's stays.
    await expect.poll(() => tabs(page)).toEqual(["plan"])
  })

  test("a tab the user closed stays closed, before or after the canvas came back", async ({ page }) => {
    await boot(page)
    await stream(page, [whole("a", "v1"), userCloses("a"), closing("a"), whole("a", "v2")])
    await stream(page, [
      whole("b", "v1"),
      closing("b"),
      whole("b", "v2"),
      userCloses("b"),
      closing("b"),
      whole("b", "v3"),
    ])
    await page.waitForTimeout(300)
    expect(await tabs(page)).toEqual([])
  })

  test("several canvases: each comes back on its own; one closed at the end leaves no tab", async ({ page }) => {
    await boot(page)
    await stream(page, [whole("a", "v1"), whole("b", "v1"), closing("a"), whole("a", "v2"), closing("b")])
    await expect.poll(() => tabs(page)).toEqual(["a"])
    await expect(canvas(page).getByText("a v2", { exact: true })).toBeVisible()
    // Closed in a later reply, a canvas keeps its tab, struck through; sent again in a third, it shows there.
    await stream(page, [closing("a")])
    await expect.poll(() => tabs(page)).toEqual(["a~"])
    await stream(page, [whole("a", "v3")])
    await expect.poll(() => tabs(page)).toEqual(["a"])
    await expect(canvas(page).getByText("a v3", { exact: true })).toBeVisible()
  })

  test("while the user looks at another session, the canvas sent again opens when they come back", async ({ page }) => {
    // Before (as in round 6): reported while its session was not shown, then retired by its id when the close removed
    // it, so the canvas sent again was never fresh, and no tab opened when the user came back mid-reply.
    await boot(page)
    await stream(page, [showSession(1), whole("plan", "v1"), closing("plan"), whole("plan", "v2"), showSession(0)])
    await expect.poll(() => tabs(page)).toEqual(["plan"])
    await expect(canvas(page).getByText("plan v2", { exact: true })).toBeVisible()
  })

  test("a reply that opens and closes one canvas 150 times leaves no tab and no long task", async ({ page }) => {
    test.setTimeout(90_000)
    // Each start opens the tab again and each close in its reply closes it: the work of a delta does not grow.
    await boot(page)
    await page.evaluate(() => {
      const record = window as unknown as { __r8c: number[]; __r8cObserver?: PerformanceObserver }
      record.__r8c = []
      record.__r8cObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) record.__r8c.push(entry.duration)
      })
      record.__r8cObserver.observe({ type: "longtask" })
    })
    const steps: string[] = []
    for (let round = 0; round < 150; round++) steps.push(whole("plan", `v${round}`), closing("plan"))
    await stream(page, steps, 40)
    await page.waitForTimeout(1000)
    expect(await tabs(page)).toEqual([])
    const longest = await page.evaluate(() => {
      const record = window as unknown as { __r8c: number[]; __r8cObserver?: PerformanceObserver }
      for (const entry of record.__r8cObserver?.takeRecords() ?? []) record.__r8c.push(entry.duration)
      return Math.max(0, ...record.__r8c)
    })
    expect(longest).toBeLessThan(BLOCKED_MS)
  })
})

test.describe("the auto-open cap holds across an app restart [R8F-3]", () => {
  test("32 canvases per reply, closed in the next, with a reload between: the strip keeps 32 tabs", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    // The count was in memory only: after a restart the strip came back with the 32 struck tabs, which neither
    // counted nor made room, and each round added 32 more (32, 64, 96).
    const load = async () => {
      await page.waitForFunction(() => !!window.__genui)
      await page.evaluate(() => window.__genui.ready)
      await page.evaluate(() => window.__genui.scenarioDone)
    }
    await page.goto("/?scenario=empty&speed=instant")
    await load()
    for (let round = 0; round < 3; round++) {
      const ids = Array.from({ length: 32 }, (_, index) => `r${round}x${index}`)
      await stream(
        page,
        ids.map((id) => whole(id, "v1")),
        40,
      )
      await expect
        .poll(() => tabs(page).then((open) => open.filter((tab) => !tab.endsWith("~")).sort()))
        .toEqual([...ids].sort())
      expect(await tabs(page)).toHaveLength(32)
      await stream(page, ids.map(closing), 40)
      await expect.poll(() => tabs(page).then((open) => open.filter((tab) => tab.endsWith("~")).length)).toBe(32)
      // The session's index is saved 300 ms after its last change (SNAPSHOT_SAVE_DELAY_MS in src/gui/sessions.ts); the
      // playground's transcript is not, so a reload sooner would come back to canvases still open.
      await page.waitForTimeout(1000)
      await page.reload()
      await load()
      // The restored strip, struck through once the session's index has loaded.
      await expect.poll(() => tabs(page).then((open) => open.filter((tab) => tab.endsWith("~")).length)).toBe(32)
      expect(await tabs(page)).toHaveLength(32)
    }
  })
})

/** The page's JS heap after a full garbage collection, in MB. */
async function heapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  const { usedSize } = await cdp.send("Runtime.getHeapUsage")
  await cdp.detach()
  return usedSize / 1e6
}

test.describe("what the session index keeps is bounded by its size", () => {
  test("a canvas of 100 KB streamed in 600 deltas keeps no partial body of each delta", async ({ page }) => {
    test.setTimeout(90_000)
    // Before: the index's parse cache kept the last 512 bodies whatever their size: the heap grew by 116 MB, where the
    // canvas and its 635 rows take about 20.
    await boot(page)
    const lines = [JSON.stringify({ canvas: "big", title: "Big" }), root("list")]
    const children: string[] = []
    for (let row = 0; lines.join("\n").length < 100_000; row++) {
      children.push(`r${row}`)
      lines.push(element(`r${row}`, "Text", { text: `row ${row} `.repeat(8) }))
    }
    lines.push(element("list", "Stack", {}, children))
    const text = `\`\`\`canvas\n${lines.join("\n")}\n\`\`\``
    const before = await heapMB(page)
    const size = Math.ceil(text.length / 600)
    const deltas: string[] = []
    for (let at = 0; at < text.length; at += size) deltas.push(text.slice(at, at + size))
    // The deltas are pieces of one text: appended without the blank line `stream` puts after each step.
    await page.evaluate(() => window.__genui.appendUser("go"))
    await page.evaluate(
      (parts) =>
        new Promise<void>((resolve) => {
          const app = window.__genui.host.app
          const session = app.sessions.current().id
          const id = app.server.startAssistant(session)
          let at = 0
          const step = () => {
            if (at < parts.length) {
              app.server.appendText(session, id, parts[at++]!)
              setTimeout(step, 10)
            } else {
              app.server.complete(session, id)
              resolve()
            }
          }
          setTimeout(step, 0)
        }),
      deltas,
    )
    await expect(canvas(page).locator('[data-gu="text"]')).toHaveCount(children.length, { timeout: 20_000 })
    expect((await heapMB(page)) - before).toBeLessThan(60)
  })
})
