import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, root, state } from "../../playground/scenarios/build.ts"

// Where the sixth review's fixes meet: json-render's time slice and the render budget's task slices send an activation's
// work to later tasks, and genui's untrusted modals need that activation (src/gui/outward.ts). See
// test/unit/review6-integration.test.ts.

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
const dialogsOpen = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLDialogElement>("dialog[data-gu]")].map((dialog) => dialog.open))

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

/** A form of `fields` required fields in a repeat, with `before` elements ahead of it. */
const requiredFields = (fields: number) => [
  element("list", "Stack", {}, ["field"], { repeat: { statePath: "/rows" } }),
  element("field", "Input", {
    label: "Field",
    value: { $bindItem: "v" },
    checks: [{ type: "required", message: "Required" }],
  }),
  state(
    "/rows",
    Array.from({ length: fields }, () => ({ v: "" })),
  ),
]

test.describe("an untrusted activation whose work goes on in later tasks [review6 integration]", () => {
  test("typing while its actions wait for a later task opens no Dialog with its activation", async ({ page }) => {
    await boot(page)
    // Each validateForm over 400 fields runs about one time slice, so the press's 40 of them go on over many tasks,
    // and the window answers in between. A keystroke then woke a watch that opened the untrusted Dialog: the press's
    // activation was still on the surface, waiting for its next task.
    await toolOutput(
      page,
      block("spec", { id: "slow-press" }, [
        root("card"),
        element("card", "Card", { title: "Form" }, ["notes", "go", "status", "dialog", "list"]),
        element("notes", "Input", { label: "Notes", value: { $bindState: "/q" } }, [], {
          watch: { "/q": setState("/open", true) },
        }),
        element("go", "Button", { label: "Check all" }, [], {
          on: { press: [...Array.from({ length: 40 }, () => ({ action: "validateForm" })), setState("/done", true)] },
        }),
        element("status", "Text", { text: { $cond: { $state: "/done" }, $then: "finished", $else: "checking" } }),
        element("dialog", "Dialog", { title: "Session expired", openPath: "/open" }, ["sign"]),
        element("sign", "Text", { text: "Sign in again." }),
        ...requiredFields(400),
        state("/q", ""),
        state("/open", false),
        state("/done", false),
      ]),
    )
    const surface = untrustedSurface(page)
    await expect(surface.getByLabel("Field")).toHaveCount(400)
    // The press, the move back to Notes and the key are three keyboard events, each one task of the page between the
    // press's slices. Clicking Notes took a dozen round trips of actionability checks, each waiting for a slice, and
    // under load the press had finished before the key went in [review8#R6F2-4].
    await surface.getByRole("button", { name: "Check all" }).focus()
    await page.keyboard.press("Enter")
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.type("x")
    // The press was still at work when the key went in.
    await expect(surface.getByText("checking", { exact: true })).toBeVisible()
    expect(await dialogsOpen(page)).toEqual([false])
    await expect(surface.getByLabel("Notes")).toHaveValue("x")
    // It goes on to the end, and the key opened nothing meanwhile.
    await expect(surface.getByText("finished", { exact: true })).toBeVisible({ timeout: 20_000 })
    expect(await dialogsOpen(page)).toEqual([false])
  })

  test("a press that shows a long list and opens a Dialog after it opens the Dialog", async ({ page }) => {
    await boot(page)
    // The render budget's task slice mounts the 1,500 rows over a few tasks, and the Dialog after them in the last one,
    // when the press's dispatch had long settled: the untrusted Dialog refused to open without its activation.
    await toolOutput(
      page,
      block("spec", { id: "reveal" }, [
        root("card"),
        element("card", "Card", { title: "Reveal" }, ["go", "section"]),
        element("go", "Button", { label: "Show all" }, [], {
          on: { press: [setState("/show", true), setState("/open", true)] },
        }),
        element("section", "Stack", {}, ["rows", "dialog"], { visible: { $state: "/show" } }),
        element("rows", "Stack", {}, ["row"], { repeat: { statePath: "/rows" } }),
        element("row", "Text", { text: "row" }),
        element("dialog", "Dialog", { title: "Details", openPath: "/open" }, ["details"]),
        element("details", "Text", { text: "Here are the details." }),
        state("/show", false),
        state("/open", false),
        state(
          "/rows",
          Array.from({ length: 1500 }, (_, index) => index),
        ),
      ]),
    )
    const surface = untrustedSurface(page)
    await surface.getByRole("button", { name: "Show all" }).click()
    await expect(surface.getByText("row", { exact: true })).toHaveCount(1500)
    await expect(page.getByRole("dialog", { name: "Details" })).toBeVisible()
    expect(await dialogsOpen(page)).toEqual([true])
  })
})

test.describe("validateForm over many fields [review6 integration]", () => {
  test("one press over 1,000 required fields marks them all and answers within a second", async ({ page }) => {
    await boot(page)
    // validateForm wrote each field's result on its own, and each write re-ran every field's check display: 1,000
    // fields cost a million runs, about 15 s of frozen window for one press.
    await toolOutput(
      page,
      block("spec", { id: "form" }, [
        root("card"),
        element("card", "Card", { title: "Form" }, ["go", "list"]),
        element("go", "Button", { label: "Check all" }, [], { on: { press: { action: "validateForm" } } }),
        ...requiredFields(1000),
      ]),
    )
    const surface = untrustedSurface(page)
    await expect(surface.getByLabel("Field")).toHaveCount(1000)
    await recordLongTasks(page)
    const started = Date.now()
    await surface.getByRole("button", { name: "Check all" }).click()
    await page.evaluate(() => 1 + 1)
    expect(Date.now() - started).toBeLessThan(1500)
    await expect(surface.getByText("Required", { exact: true })).toHaveCount(1000)
    expect(Math.max(0, ...(await longTasks(page)))).toBeLessThan(1000)
  })
})

test.describe("a large static prop in every row of a repeat [review6 integration]", () => {
  test("a block of 90 KB whose 2,000 rows each carry an object of 9,000 entries renders at once", async ({ page }) => {
    await boot(page)
    // Every row resolved its own copy of the object, and genui sized each copy, all in one task: 9 s of frozen window
    // (and hundreds of megabytes) for one block of tool output. A value without expressions is now shared by the rows.
    const data = Object.fromEntries(Array.from({ length: 9000 }, (_, index) => [`k${index}`, 1]))
    await recordLongTasks(page)
    const started = Date.now()
    await toolOutput(
      page,
      block("spec", { id: "static-rows" }, [
        root("card"),
        element("card", "Card", { title: "Static" }, ["ok", "list"]),
        element("ok", "Text", { text: "the rest renders" }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows" } }),
        element("row", "Text", { text: "row", data }),
        state(
          "/rows",
          Array.from({ length: 2000 }, () => 0),
        ),
      ]),
    )
    await page.evaluate(() => 1 + 1)
    expect(Date.now() - started).toBeLessThan(1500)
    const surface = untrustedSurface(page)
    await expect(surface.getByText("the rest renders")).toBeVisible()
    // As many rows as the render budget holds (each row's units count its object).
    await expect(surface.getByText("row", { exact: true }).first()).toBeVisible()
    expect(Math.max(0, ...(await longTasks(page)))).toBeLessThan(1000)
  })
})
