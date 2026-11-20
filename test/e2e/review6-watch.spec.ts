import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the sixth review's json-render findings: [review6#R1] watches woken by one key press, and
// [review6#O1] expressions that read one long text many times. See test/unit/review6-watch.test.ts for the rules.

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

/** Appends a completed assistant message whose tool part returned `output` (Markdown): blocks in it are untrusted. */
async function toolOutput(page: Page, output: string) {
  await page.evaluate((text) => {
    const app = window.__genui.host.app
    const session = app.sessions.current()
    const id = app.server.startAssistant(session.id, [
      {
        type: "tool",
        id: `call_${Date.now()}`,
        name: "webfetch https://example.com/page",
        state: { status: "completed", output: text },
      },
      { type: "text", text: "" },
    ])
    app.server.appendText(session.id, id, "Done.")
    app.server.complete(session.id, id)
  }, output)
}

const untrustedSurface = (page: Page) =>
  page.locator('[data-playground-tool-output] [data-genui][data-surface="inline"]')
const setState = (statePath: string, value: unknown) => ({ action: "setState", params: { statePath, value } })

/** Records the page's long tasks (over 50 ms) from now on. */
const recordLongTasks = (page: Page) =>
  page.evaluate(() => {
    const tasks: number[] = []
    ;(window as unknown as { longTasks: number[] }).longTasks = tasks
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(entry.duration)
    }).observe({ type: "longtask" })
  })
const longTasks = (page: Page) => page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)

/** A repeat of `rows` rows whose row watches the Search field's /q with `actions`, as untrusted tool output. */
async function watchingRows(page: Page, rows: number, actions: unknown[]) {
  await toolOutput(
    page,
    block("spec", { id: "rows" }, [
      root("card"),
      element("card", "Card", { title: "Rows" }, ["search", "list"]),
      element("search", "Input", { label: "Search", value: { $bindState: "/q" } }),
      element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows" } }),
      element("row", "Text", { text: "." }, [], { watch: { "/q": actions } }),
      state("/q", ""),
      state("/a", ""),
      state(
        "/rows",
        Array.from({ length: rows }, () => 0),
      ),
    ]),
  )
  const surface = untrustedSurface(page)
  await expect(surface.getByText(".", { exact: true })).toHaveCount(rows)
  return surface
}

/** Types one character into the surface's Search field; resolves with how long until the page answered again. */
async function keyPress(page: Page, surface: ReturnType<typeof untrustedSurface>) {
  await surface.getByLabel("Search").click()
  await recordLongTasks(page)
  const started = Date.now()
  await page.keyboard.type("x")
  await page.evaluate(() => 1 + 1)
  return Date.now() - started
}

test.describe("watches woken by one key press [review6#R1]", () => {
  test("a 600-row repeat whose row watch is [setState {$index}, validateForm] answers at once", async ({ page }) => {
    await boot(page)
    // Every row's watch ran validateForm, each re-evaluating every row: one key press froze the window for 22 s.
    const surface = await watchingRows(page, 600, [setState("/a", { $index: true }), { action: "validateForm" }])
    expect(await keyPress(page, surface)).toBeLessThan(600)
    // The awaited actions past the time slice run in later tasks, each short.
    await page.waitForTimeout(500)
    expect(Math.max(0, ...(await longTasks(page)))).toBeLessThan(600)
  })

  test("a 1,000-row repeat whose row watch makes 10 writes answers at once", async ({ page }) => {
    await boot(page)
    // 1,000 rows × 10 writes, every write calling every row's listener: 5.5 s for one key press.
    const writes = Array.from({ length: 10 }, (_, index) => setState("/a", index % 2 ? "x" : "y"))
    const surface = await watchingRows(page, 1000, writes)
    expect(await keyPress(page, surface)).toBeLessThan(600)
    await page.waitForTimeout(300)
    expect(Math.max(0, ...(await longTasks(page)))).toBeLessThan(600)
  })

  test("a select-all over 400 rows, from a watch in each row, ticks every row and unticks them again", async ({
    page,
  }) => {
    await boot(page)
    const rows = Array.from({ length: 400 }, (_, index) => ({ id: `r${index}`, name: `Row ${index}`, checked: false }))
    await toolOutput(
      page,
      block("spec", { id: "select-all" }, [
        root("card"),
        element("card", "Card", { title: "Files" }, ["all", "list"]),
        element("all", "Checkbox", { label: "Select all", checked: { $bindState: "/all" } }),
        element("list", "Stack", { direction: "vertical", gap: "xs" }, ["row"], {
          repeat: { statePath: "/rows", key: "id" },
        }),
        element("row", "Checkbox", { label: { $item: "name" }, checked: { $bindItem: "checked" } }, [], {
          watch: { "/all": setState({ $item: "checked" } as never, { $state: "/all" }) },
        }),
        state("/all", false),
        state("/rows", rows),
      ]),
    )
    const surface = untrustedSurface(page)
    await expect(surface.locator('input[type="checkbox"]')).toHaveCount(401)
    await surface.getByText("Select all", { exact: true }).click()
    await expect(surface.locator('input[type="checkbox"]:checked')).toHaveCount(401)
    await surface.getByText("Select all", { exact: true }).click()
    await expect(surface.locator('input[type="checkbox"]:checked')).toHaveCount(0)
  })
})

test.describe("expressions that read one long text many times [review6#O1]", () => {
  test("a block whose templates read a 30 KB text 2,000 times each renders at once, those texts left empty", async ({
    page,
  }) => {
    await boot(page)
    // Ten templates of 2,000 references each built 600 million characters before the render budget could leave them
    // out (a larger block ran the window out of memory). Now each stops before building more than a million, and the
    // console says so once.
    const warnings: string[] = []
    const errors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text())
      if (message.type() === "error") errors.push(message.text())
    })
    const template = { $template: "${/doc}".repeat(2000) }
    const texts = Array.from({ length: 10 }, (_, index) => `t${index}`)
    const started = Date.now()
    await toolOutput(
      page,
      block("spec", { id: "expand" }, [
        root("card"),
        element("card", "Card", { title: "Expand" }, ["ok", "copy", "copied", ...texts]),
        element("ok", "Text", { text: "the rest renders" }),
        element("copy", "Button", { label: "Copy" }, [], { on: { press: [setState("/copy", template)] } }),
        element("copied", "Text", { text: { $template: "copied: ${/copy}" } }),
        ...texts.map((key) => element(key, "Text", { text: template })),
        state("/doc", "x".repeat(30_000)),
        state("/copy", "none"),
      ]),
    )
    const surface = untrustedSurface(page)
    await expect(surface.getByText("the rest renders")).toBeVisible()
    await page.evaluate(() => 1 + 1)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(await surface.innerText()).not.toContain("xxxxxxxxxx")
    const unresolved = () => warnings.filter((warning) => warning.includes("Left an expression unresolved"))
    // Said once per task, not once per expression: the ten templates are evaluated over a few tasks now (a task builds
    // at most 4 million characters, R6S1-3), so it was said once in all before and is said a few times now.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)))
    const told = unresolved().length
    expect(told).toBeGreaterThanOrEqual(1)
    expect(told).toBeLessThanOrEqual(texts.length)

    // An action whose param would build such a text does not run; json-render says so once for the press's task, and
    // the press reports no failure of its own.
    await surface.getByRole("button", { name: "Copy" }).click()
    await expect.poll(() => unresolved().length).toBe(told + 1)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    await expect(surface.getByText("copied: none")).toBeVisible()
    expect(errors.filter((error) => error.includes("actions failed"))).toEqual([])
  })
})
