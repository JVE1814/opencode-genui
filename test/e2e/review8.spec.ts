import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { add, block, element, root } from "../../playground/scenarios/build.ts"

// Regression tests for the eighth review ([review8#<id>]): work a spec could give the window that the earlier bounds did
// not count (an SVG image, a table's cells, the cost of one expression node, Markdown emphasis, reconciling edits,
// validateForm), and the function regressions R6F2-1..3.
//
// Timing: each test measures how long the window stays blocked with pings (an evaluate waits until the main thread is
// free), as the review's probes do, against the 1 s target. The fixed code blocks for a few hundred ms at most, the old
// code for 3 to 43 s, so the margin holds when other test workers share the CPUs.

const BLOCKED_MS = 1000

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
  await page.evaluate(() => window.__genui.appendUser("go"))
}

async function say(page: Page, text: string) {
  await page.evaluate((reply) => window.__genui.appendAssistant(reply), text)
}

/** Appends a completed assistant message whose tool part returned `output` (Markdown): blocks in it are untrusted. */
async function toolOutput(page: Page, output: string) {
  await page.evaluate((text) => {
    const app = window.__genui.host.app
    const session = app.sessions.current()
    const id = app.server.startAssistant(session.id, [
      {
        type: "tool",
        id: `call_${Date.now()}_${Math.random()}`,
        name: "webfetch",
        state: { status: "completed", output: text },
      },
      { type: "text", text: "" },
    ])
    app.server.appendText(session.id, id, "Done.")
    app.server.complete(session.id, id)
  }, output)
}

/**
 * Runs `action`, then pings the page every 100 ms for `ms`, and returns the longest the window kept the test waiting:
 * the action itself (an append or a key press renders in the page's task, which it awaits) or any one ping.
 */
async function blockedBy(page: Page, action: () => Promise<unknown>, ms = 2000): Promise<number> {
  const started = Date.now()
  await action()
  let longest = Date.now() - started
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ping = Date.now()
    await page.evaluate(() => 1)
    longest = Math.max(longest, Date.now() - ping)
    await page.waitForTimeout(100)
  }
  return longest
}

const untrusted = (page: Page) => page.locator('[data-playground-tool-output] [data-genui][data-surface="inline"]')

test.describe("an SVG data: image is refused [R6S2-1]", () => {
  test("an untrusted Image of 18 levels of nested <use> shows the placeholder and never blocks the window", async ({
    page,
  }) => {
    // 1.9 KB from a tool, shown without a click: the window froze for 43 s while Chromium drew 2^18 shapes.
    await boot(page)
    let defs = '<rect id="l0" width="1" height="1" fill="#c33"/>'
    for (let level = 1; level <= 18; level++)
      defs += `<g id="l${level}"><use href="#l${level - 1}"/><use href="#l${level - 1}" x="1"/></g>`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs>${defs}</defs><use href="#l18"/></svg>`
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    const spec = block("spec", undefined, [
      root("card"),
      element("card", "Card", { title: "Report" }, ["img", "who"]),
      element("img", "Image", { src, alt: "Chart", width: 320, height: 200 }),
      element("who", "Avatar", { src, name: "Ada" }),
    ])
    expect(await blockedBy(page, () => toolOutput(page, `Here:\n\n${spec}\n`))).toBeLessThan(BLOCKED_MS)
    await expect(untrusted(page).locator('[data-gu-image="placeholder"]')).toBeVisible()
    await expect(untrusted(page).locator("img")).toHaveCount(0)
  })
})

test.describe("a Table is charged for its cells [R6S2-2]", () => {
  test("500 rows × 1,000 columns from a tool render at most 10,000 cells, say what they leave out, and never block", async ({
    page,
  }) => {
    // 5.8 KB drew 500,000 cells in one task of 13 s; six such blocks held 3.3 GB.
    await boot(page)
    const columns = Array.from({ length: 1000 }, (_, index) => String(index % 10))
    const table = block("spec", undefined, [
      add("/state", { rows: Array.from({ length: 500 }, () => []) }),
      root("card"),
      element("card", "Card", { title: "Data" }, ["t"]),
      element("t", "Table", { columns, rows: { $state: "/rows" } }),
    ])
    const output = Array.from({ length: 6 }, () => table).join("\n\nand\n\n")
    expect(await blockedBy(page, () => toolOutput(page, output))).toBeLessThan(BLOCKED_MS)
    const cells = await page.locator("[data-genui] td").count()
    expect(cells).toBeGreaterThan(0)
    expect(cells).toBeLessThanOrEqual(10_000)
    await expect(untrusted(page).locator('[data-gu="table"] [data-slot="cut"]').first()).toHaveText(
      "Showing 200 of 500 rows and 50 of 1000 columns",
    )
    // The pool of tool output holds one such table; the others report that they do not fit.
    await expect(
      untrusted(page)
        .getByText(/^\d+ issues?$/)
        .first(),
    ).toBeVisible()
  })

  test("an ordinary table renders whole, without a note", async ({ page }) => {
    await boot(page)
    const rows = Array.from({ length: 40 }, (_, index) => ({ name: `svc-${index}`, status: "ok", latency: index * 3 }))
    await say(
      page,
      block("spec", undefined, [root("t"), element("t", "Table", { columns: ["name", "status", "latency"], rows })]),
    )
    await expect(page.locator('[data-genui] [data-gu="table"] tbody tr')).toHaveCount(40)
    await expect(page.locator('[data-genui] [data-gu="table"] [data-slot="cut"]')).toHaveCount(0)
  })
})

test.describe("what one expression node costs is bounded [R6S2-3]", () => {
  test("a tree of copies reading one long text: no key press blocks the window", async ({ page }) => {
    // 13 KB from a tool: `copy` doubles a subtree, so 4,096 leaves each read the million digits a key press puts in
    // /big as a number (Number() of it takes milliseconds). 10 s per key press; 42 s with 16,384 leaves.
    await boot(page)
    const leaf = { $math: "abs", a: { $state: "/big" } }
    const lines = [
      add("/state", { q: "", s: "1".repeat(9000), big: "" }),
      root("card"),
      element("card", "Card", { title: "Totals" }, ["in", "t"]),
      element("in", "Input", { label: "Search", value: { $bindState: "/q" } }, [], {
        watch: {
          "/q": [{ action: "setState", params: { statePath: "/big", value: { $template: "${/s}".repeat(111) } } }],
        },
      }),
      add("/elements/scratch", { type: "Text", props: { t0: leaf }, children: [] }),
    ]
    for (let level = 1; level <= 12; level++) {
      lines.push(
        add(`/elements/scratch/props/t${level}`, { $math: "add", a: 0, b: 0 }),
        JSON.stringify({
          op: "copy",
          from: `/elements/scratch/props/t${level - 1}`,
          path: `/elements/scratch/props/t${level}/a`,
        }),
        JSON.stringify({
          op: "copy",
          from: `/elements/scratch/props/t${level - 1}`,
          path: `/elements/scratch/props/t${level}/b`,
        }),
      )
    }
    lines.push(
      element("t", "Text", { text: 0 }),
      JSON.stringify({ op: "copy", from: "/elements/scratch/props/t12", path: "/elements/t/props/text" }),
    )
    await toolOutput(page, `Here:\n\n${block("spec", undefined, lines)}\n`)
    const search = untrusted(page).getByLabel("Search")
    await search.click()
    for (const key of ["x", "y"]) expect(await blockedBy(page, () => page.keyboard.type(key))).toBeLessThan(BLOCKED_MS)
    await expect(search).toHaveValue("xy")
    await expect(untrusted(page).getByText("0", { exact: true })).toBeVisible()
  })

  test("1,024 `lessThan` checks against a long text: a click does not block the window", async ({ page }) => {
    // 100 KB from a tool: each check read the million digits in /big as a number, and validation counted nowhere: 2.6 s.
    await boot(page)
    const check = { type: "lessThan", message: "Too many", args: { other: { $state: "/big" } } }
    const lines = [
      add("/state", { c: false, s: "1".repeat(9000), big: "" }),
      root("card"),
      element("card", "Card", { title: "Terms" }, ["cb"]),
      add("/elements/cb", {
        type: "Checkbox",
        props: {
          label: "I agree",
          checked: { $bindState: "/c" },
          validateOn: "change",
          checks: Array.from({ length: 1024 }, () => check),
        },
        children: [],
        watch: {
          "/c": [{ action: "setState", params: { statePath: "/big", value: { $template: "${/s}".repeat(111) } } }],
        },
      }),
    ]
    await toolOutput(page, `Here:\n\n${block("spec", undefined, lines)}\n`)
    // (Once /big is set, the checks' resolved args hold it 1,024 times, so the Checkbox no longer fits its budget.)
    const box = untrusted(page).getByText("I agree", { exact: true })
    expect(await blockedBy(page, () => box.click())).toBeLessThan(BLOCKED_MS)
  })
})

/** Runs `action`, then waits `ms`, and returns the longest task the page ran meanwhile (PerformanceObserver). */
async function longestTask(page: Page, action: () => Promise<unknown>, ms = 2000): Promise<number> {
  await page.evaluate(() => {
    const record = window as unknown as { __longest: number; __observer?: PerformanceObserver }
    record.__longest = 0
    record.__observer?.disconnect()
    record.__observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record.__longest = Math.max(record.__longest, entry.duration)
    })
    record.__observer.observe({ type: "longtask" })
  })
  await action()
  await page.waitForTimeout(ms)
  return page.evaluate(() => (window as unknown as { __longest: number }).__longest)
}

test.describe("showing what a validateForm found is spread over frames [R6S2-6]", () => {
  test("1,990 required Inputs: the press shows every error, and no task takes half a second", async ({ page }) => {
    // One task of about a second: every field re-read the one signal of all results, and 6,000 elements restyled.
    test.slow()
    await boot(page)
    await say(
      page,
      block("spec", undefined, [
        add("/state", { rows: Array.from({ length: 1990 }, () => ({ v: "" })) }),
        root("card"),
        element("card", "Card", { title: "Form" }, ["go", "list"]),
        element("go", "Button", { label: "Check all" }, [], { on: { press: [{ action: "validateForm" }] } }),
        add("/elements/list", { type: "Stack", props: {}, repeat: { statePath: "/rows" }, children: ["f"] }),
        element("f", "Input", {
          label: "F",
          value: { $bindItem: "v" },
          checks: [{ type: "required", message: "Required" }],
        }),
      ]),
    )
    await expect(page.locator("[data-genui] [data-gu-field]")).toHaveCount(1990, { timeout: 20_000 })
    const press = page.getByRole("button", { name: "Check all" })
    expect(await longestTask(page, () => press.click(), 2500)).toBeLessThan(500)
    await expect(page.locator("[data-genui] [data-gu-error]:not(:empty)")).toHaveCount(1990)
    // Typing into one field shows its own result at once.
    const first = page.locator("[data-genui] [data-gu-field]").first()
    await first.getByRole("textbox").fill("x")
    await first.getByRole("textbox").blur()
    await expect(page.locator("[data-genui] [data-gu-error]:not(:empty)")).toHaveCount(1989)
  })
})

test.describe("stored edits never go stale [R6F2-1]", () => {
  test("a select-all over 1,990 rows that write twice, an untick, a reload: the row stays unticked", async ({
    page,
  }) => {
    // The stored copy passed the bytes written, the old entry stayed, and the reload ticked Row 5 again.
    test.slow()
    await page.goto("/?scenario=empty&speed=instant")
    await page.waitForFunction(() => !!window.__genui)
    await page.evaluate(() => window.__genui.ready)
    await page.evaluate(() => window.__genui.scenarioDone)
    await page.evaluate(() => window.__genui.appendUser("list"))
    const rows = Array.from({ length: 1990 }, (_, index) => ({ id: `r${index}`, name: `Row ${index}`, checked: false }))
    const watch = ["checked", "f0"].map((field) => ({
      action: "setState",
      params: { statePath: { $item: field }, value: { $state: "/all" } },
    }))
    await say(
      page,
      block("spec", { id: "sel", title: "Select" }, [
        add("/state", { all: false, rows }),
        root("card"),
        element("card", "Card", { title: "Rows" }, ["all", "list"]),
        element("all", "Checkbox", { label: "Select all", checked: { $bindState: "/all" } }),
        add("/elements/list", {
          type: "Stack",
          props: { direction: "vertical", gap: "xs" },
          repeat: { statePath: "/rows", key: "id" },
          children: ["row"],
        }),
        element("row", "Checkbox", { label: { $item: "name" }, checked: { $bindItem: "checked" } }, [], {
          watch: { "/all": watch },
        }),
      ]),
    )
    const surface = page.locator("[data-genui]").last()
    const checked = surface.locator('input[type="checkbox"]:checked')
    await expect(surface.locator('input[type="checkbox"]')).toHaveCount(1991, { timeout: 20_000 })
    await surface.getByText("Select all", { exact: true }).click()
    await expect(checked).toHaveCount(1991, { timeout: 20_000 })
    await surface.getByText("Row 5", { exact: true }).click()
    await expect(checked).toHaveCount(1990)
    // Stored edits are written once the edits settle.
    await page.waitForTimeout(1500)
    await page.reload()
    await page.waitForFunction(() => !!window.__genui)
    await page.evaluate(() => window.__genui.ready)
    await expect(page.locator("[data-genui]").last().locator('input[type="checkbox"]')).toHaveCount(1991, {
      timeout: 20_000,
    })
    await page.waitForTimeout(1000)
    await expect(
      page.locator("[data-genui]").last().getByRole("checkbox", { name: "Row 5", exact: true }),
    ).not.toBeChecked()
  })
})

test.describe("two modals bound to one open path [R6F2-2]", () => {
  test("a press that opens a Dialog and a Drawer on one path leaves it open, with a modal shown", async ({ page }) => {
    // The second was refused as a loop ("again"), and its refusal wrote false back, which closed the first: nothing opened.
    await boot(page)
    const warnings: string[] = []
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text())
    })
    await say(
      page,
      block("spec", undefined, [
        add("/state", { dup: false }),
        root("card"),
        element("card", "Card", { title: "Both" }, ["go", "a", "b"]),
        element("go", "Button", { label: "Open dup" }, [], {
          on: { press: { action: "setState", params: { statePath: "/dup", value: true } } },
        }),
        element("a", "Dialog", { title: "Dup A", openPath: "/dup" }, ["ta"]),
        element("ta", "Text", { text: "Inside A" }),
        element("b", "Drawer", { title: "Dup B", openPath: "/dup" }, ["tb"]),
        element("tb", "Text", { text: "Inside B" }),
      ]),
    )
    await page.getByRole("button", { name: "Open dup" }).click()
    await expect(page.locator("[data-genui] dialog[open]")).toHaveCount(1)
    await page.waitForTimeout(300)
    await expect(page.locator("[data-genui] dialog[open]")).toHaveCount(1)
    expect(warnings.filter((text) => text.includes("did not open"))).toEqual([])
    // Closing it closes the path: nothing stays open behind it.
    await page.keyboard.press("Escape")
    await expect(page.locator("[data-genui] dialog[open]")).toHaveCount(0)
  })
})

test.describe("the agent's newest inline UI keeps room of its own [R6F2-3]", () => {
  test("four distinct UIs of 1,890 units, one per message: the newest renders in full", async ({ page }) => {
    // First come, first served: the three older UIs held the window's inline pool, and the newest showed 106 of 630 rows.
    test.slow()
    await boot(page)
    for (let version = 1; version <= 4; version++) {
      await page.evaluate((text) => window.__genui.appendUser(text), `report ${version}`)
      await say(
        page,
        `Version ${version}:\n\n${block("spec", { id: `report${version}`, title: `Report v${version}` }, [
          add("/state", {
            rows: Array.from({ length: 630 }, (_, index) => ({ id: `r${index}`, name: `Row ${index}`, ok: false })),
          }),
          root("card"),
          element("card", "Card", { title: `Report v${version}` }, ["list"]),
          add("/elements/list", {
            type: "Stack",
            props: { gap: "xs" },
            repeat: { statePath: "/rows", key: "id" },
            children: ["row"],
          }),
          add("/elements/row", { type: "Stack", props: { direction: "horizontal" }, children: ["c", "b"] }),
          element("c", "Checkbox", { label: { $item: "name" }, checked: { $bindItem: "ok" } }),
          element("b", "Badge", { text: { $item: "id" } }),
        ])}\n`,
      )
      await page.waitForTimeout(1500)
    }
    const surfaces = page.locator('[data-genui][data-surface="inline"]')
    await expect(surfaces).toHaveCount(4)
    await expect(surfaces.last().locator('input[type="checkbox"]')).toHaveCount(630, { timeout: 15_000 })
    await expect(surfaces.last().getByText(/^\d+ issues?$/)).toHaveCount(0)
    // The oldest still renders in full; the pool's bound holds (the third waits for room).
    await expect(surfaces.first().locator('input[type="checkbox"]')).toHaveCount(630)
    expect(await page.locator('[data-genui][data-surface="inline"] input[type="checkbox"]').count()).toBeLessThan(
      4 * 630,
    )
  })
})
