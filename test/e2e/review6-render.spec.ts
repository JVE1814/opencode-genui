import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, replace, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the sixth review's rendering findings ([review6#R<n>]): the render budget across surfaces,
// elements that come back once room is freed, select-all over many rows, and a canvas whose root element came late.

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

async function boot(page: Page) {
  await page.goto("/?scenario=empty&speed=instant&persist=0")
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(() => window.__genui.ready)
  await page.evaluate(() => window.__genui.scenarioDone)
}

async function say(page: Page, text: string, options: { stream?: boolean } = {}) {
  await page.evaluate(([reply, opts]) => window.__genui.appendAssistant(reply, opts), [text, options] as const)
}

/** Appends a completed assistant message whose tool part returned `output` (Markdown): blocks in it are untrusted. */
async function toolOutput(page: Page, output: string) {
  await page.evaluate((text) => {
    const app = window.__genui.host.app
    const session = app.sessions.current()
    const id = app.server.startAssistant(session.id, [
      { type: "tool", id: `call_${Date.now()}`, name: "webfetch", state: { status: "completed", output: text } },
      { type: "text", text: "" },
    ])
    app.server.appendText(session.id, id, "Done.")
    app.server.complete(session.id, id)
  }, output)
}

/** Records every long task (over 50 ms) from now on. */
async function watchLongTasks(page: Page) {
  await page.evaluate(() => {
    const long: number[] = []
    ;(window as unknown as { __long: number[] }).__long = long
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) long.push(entry.duration)
    }).observe({ type: "longtask" })
  })
}
const longestTask = (page: Page) =>
  page.evaluate(() => Math.max(0, ...(window as unknown as { __long: number[] }).__long))

/** How long the page takes to answer: a frozen main thread answers late. */
async function answerTime(page: Page): Promise<number> {
  const started = Date.now()
  await page.evaluate(() => 1 + 1)
  return Date.now() - started
}

/** Times `action` (an evaluate that appends a message: its own task is not a "longtask" entry). */
async function timed(action: () => Promise<unknown>): Promise<number> {
  const started = Date.now()
  await action()
  return Date.now() - started
}

const untrusted = (page: Page) => page.locator('[data-playground-tool-output] [data-genui][data-surface="inline"]')
const canvasView = (page: Page, canvas: string) => page.locator(`[data-gu-chrome="canvas"][data-canvas="${canvas}"]`)

/** The 2.6 KB block of [review5#S3]: 300 × 300 nested rows, 90,000 elements written out. */
const nested = (id: string) => {
  const items = Array.from({ length: 300 }, (_, index) => index)
  return block("spec", { id }, [
    root("outer"),
    element("outer", "Stack", {}, ["row"], { repeat: { statePath: "/a" } }),
    element("row", "Stack", { direction: "horizontal" }, ["cell"], { repeat: { statePath: "/b" } }),
    element("cell", "Text", { text: "x" }),
    state("/a", items),
    state("/b", items),
  ])
}

test.describe("render budget across surfaces [review6#R3]", () => {
  test("twenty copies of a nested-repeat block in one tool output render once, and the window keeps answering", async ({
    page,
  }) => {
    await boot(page)
    await watchLongTasks(page)
    // 53 KB: each copy rendered its own 2,000 elements, 40,000 in all, and froze the window for 9 s.
    const output = Array.from({ length: 20 }, (_, index) => nested(`copy${index}`)).join("\n\n")
    const appended = await timed(() => toolOutput(page, output))
    expect(appended).toBeLessThan(1500)
    expect(await answerTime(page)).toBeLessThan(1000)
    const texts = untrusted(page).locator('[data-gu="text"]')
    // All copies share the window's pool for blocks outside the agent's reply: one copy's worth renders.
    await expect(untrusted(page)).toHaveCount(20)
    await expect(untrusted(page).locator('[data-gu-chrome="issues"]')).toHaveCount(20)
    await expect.poll(() => texts.count()).toBeGreaterThan(1000)
    await page.waitForTimeout(500)
    expect(await texts.count()).toBeLessThan(2000)
    await expect(untrusted(page).first().locator('[data-gu-chrome="issues"]')).toContainText("too large")
    expect(await longestTask(page)).toBeLessThan(1000)
  })

  // This test expected the repeat to render nothing at all; a repeat whose rows do not all fit shows its first rows now,
  // as it did before the slots were counted (R6F1-1): 8 rows of 500 children, as many as SLOT_UNITS holds.
  test("a repeat whose rows list hundreds of children builds only the rows that fit", async ({ page }) => {
    await boot(page)
    await watchLongTasks(page)
    // 11 KB: 2,000 rows × 500 children built a million renderers to show 2,000 (minutes of frozen window).
    const output = block("spec", { id: "slots" }, [
      root("outer"),
      element(
        "outer",
        "Stack",
        {},
        Array.from({ length: 500 }, () => "c"),
        { repeat: { statePath: "/a" } },
      ),
      element("c", "Text", { text: "x" }),
      state(
        "/a",
        Array.from({ length: 2000 }, (_, index) => index),
      ),
    ])
    expect(await timed(() => toolOutput(page, output))).toBeLessThan(1500)
    expect(await answerTime(page)).toBeLessThan(1000)
    await expect(untrusted(page).locator('[data-gu-chrome="issues"]')).toContainText("too large")
    await expect.poll(() => untrusted(page).locator('[data-gu="text"]').count()).toBeGreaterThan(1000)
    expect(await untrusted(page).locator('[data-gu="text"]').count()).toBeLessThanOrEqual(4000)
    expect(await longestTask(page)).toBeLessThan(1000)
  })

  // Needs the reserveToolbar change in src/gui/components/shared.tsx described with this test: each surface's toolbar
  // observer read the layout after the previous one wrote, as each surface's height observer did.
  test("nine hundred small blocks in one tool output lay out once, not once per block", async ({ page }) => {
    await boot(page)
    await watchLongTasks(page)
    const output = Array.from({ length: 900 }, (_, index) =>
      block("spec", undefined, [root("a"), element("a", "Text", { text: `t${index}` })]),
    ).join("\n\n")
    await toolOutput(page, output)
    await expect(untrusted(page).locator('[data-gu="text"]')).toHaveCount(900)
    await page.waitForTimeout(500)
    // A layout per surface: one long task of a second.
    expect(await longestTask(page)).toBeLessThan(600)
  })

  test("a few normal UIs in one reply all render in full", async ({ page }) => {
    await boot(page)
    const ui = (index: number) =>
      block("spec", { id: `tasks${index}`, title: `Tasks ${index}` }, [
        root("card"),
        element("card", "Card", { title: `Tasks ${index}` }, ["search", "list", "total"]),
        element("search", "Input", { label: "Search", value: { $bindState: "/q" } }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows", key: "id" } }),
        element("row", "Checkbox", { label: { $item: "name" }, checked: { $bindItem: "done" } }),
        element("total", "Text", { text: "40 items" }),
        state(
          "/rows",
          Array.from({ length: 40 }, (_, row) => ({ id: row, name: `Item ${index}.${row}`, done: row % 3 === 0 })),
        ),
        state("/q", ""),
      ])
    await say(page, Array.from({ length: 5 }, (_, index) => ui(index)).join("\n\nAnd another:\n\n"))
    const surfaces = page.locator('[data-genui][data-surface="inline"][aria-label^="Tasks"]')
    await expect(surfaces).toHaveCount(5)
    await expect(surfaces.locator('input[type="checkbox"]')).toHaveCount(200)
    await expect(surfaces.locator('[data-gu="text"]')).toHaveCount(5)
    expect(await surfaces.locator('[data-gu-chrome="issues"]').count()).toBe(0)
  })
})

test.describe("room freed [review6#R6]", () => {
  test("elements a long text pushed out come back once the agent shrinks it, and the issue clears", async ({
    page,
  }) => {
    await boot(page)
    await page.evaluate(() => window.__genui.appendUser("show the report"))
    await say(
      page,
      block("canvas", { canvas: "plan", title: "Plan" }, [
        root("card"),
        element("card", "Card", { title: "Report" }, ["f1", "big", "f2", "f3"]),
        element("big", "Text", { text: { $state: "/big" } }),
        element("f1", "Text", { text: "footer one" }),
        element("f2", "Text", { text: "footer two" }),
        element("f3", "Text", { text: "footer three" }),
        state("/big", "x".repeat(499_000)),
      ]),
    )
    const canvas = canvasView(page, "plan")
    await expect(canvas.getByText("footer one")).toBeVisible()
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toContainText("1 issue")
    await expect(canvas.getByText("footer three")).toHaveCount(0)
    // "Ask agent to fix": the agent shrinks the text. Before, the footers kept static props, nothing asked them
    // again, and they stayed out (with the issue) until a remount.
    await page.evaluate(() => window.__genui.appendUser("make it smaller"))
    await say(page, block("canvas", { canvas: "plan" }, [replace("/state/big", "short now")]))
    await expect(canvas.getByText("short now")).toBeVisible()
    await expect(canvas.getByText("footer two")).toBeVisible()
    await expect(canvas.getByText("footer three")).toBeVisible()
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
  })
})

test.describe("select all over many rows [review6#R7]", () => {
  test("select all over 600 rows ticks 601, and unselect all leaves none", async ({ page }) => {
    await boot(page)
    const rows = Array.from({ length: 600 }, (_, index) => ({ id: `r${index}`, name: `Row ${index}`, checked: false }))
    await say(
      page,
      block("spec", { id: "pick", title: "Pick" }, [
        root("card"),
        element("card", "Card", { title: "Pick rows" }, ["all", "list"]),
        element("all", "Checkbox", { label: "Select all", checked: { $bindState: "/all" } }),
        element("list", "Stack", { direction: "vertical", gap: "xs" }, ["row"], {
          repeat: { statePath: "/rows", key: "id" },
        }),
        element("row", "Checkbox", { label: { $item: "name" }, checked: { $bindItem: "checked" } }, [], {
          watch: {
            "/all": [{ action: "setState", params: { statePath: { $item: "checked" }, value: { $state: "/all" } } }],
          },
        }),
        state("/all", false),
        state("/rows", rows),
      ]),
    )
    const surface = page.locator('[data-genui][data-surface="inline"][aria-label="Pick"]')
    const boxes = surface.locator('input[type="checkbox"]')
    await expect(boxes).toHaveCount(601)
    await surface.getByText("Select all", { exact: true }).click()
    // The 500-edit cap dropped the oldest edits from what the user saw: the click itself and the first rows.
    await expect(surface.locator('input[type="checkbox"]:checked')).toHaveCount(601)
    await surface.getByText("Select all", { exact: true }).click()
    await expect(surface.locator('input[type="checkbox"]:checked')).toHaveCount(0)
  })
})

test.describe("a canvas whose root element comes late [review6#R9]", () => {
  test("a canvas started with a `replace` of /root, its element in a later block, renders and is not missing", async ({
    page,
  }) => {
    await boot(page)
    // Every error card or missing-base notice the canvas panel shows, also for a moment.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { __seen: string[] }).__seen = seen
      new MutationObserver(() => {
        const panel = document.querySelector('[data-gu-chrome="canvas"][data-canvas="late"]')
        if (panel?.querySelector('[data-gu-chrome="error"]')) seen.push("error")
        if (panel?.textContent?.includes("Part of this canvas is missing")) seen.push("missing")
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await page.evaluate(() => window.__genui.appendUser("start"))
    const first = block("canvas", { canvas: "late", title: "Late" }, [replace("/root", "main"), state("/x", 1)])
    await say(page, first, { stream: true })
    await page.evaluate(() => window.__genui.appendUser("go on"))
    await say(page, block("canvas", { canvas: "late" }, [element("main", "Text", { text: "arrived" })]))
    const canvas = canvasView(page, "late")
    await expect(canvas.getByText("arrived")).toBeVisible()
    await expect(canvas).not.toContainText("Part of this canvas is missing")
    // While the first block streamed, the canvas showed no error card (the switch counts as a new canvas then).
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen.includes("error"))).toBe(false)
  })
})
