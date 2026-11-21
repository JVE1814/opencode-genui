import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, remove, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the seventh review's findings in the json-render patches (patches/@json-render%2Fsolid):
// [R6S3-1] repeat rows matched in quadratic time over the whole list, [R6S3-3] an untrusted Dialog opened by typing
// while a press's actions waited for later tasks, [R6F3-3] a select-all within its counts cut on a slower CPU. See
// test/unit/review7-patch.test.ts for the same against json-render alone.

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
const setState = (statePath: unknown, value: unknown) => ({ action: "setState", params: { statePath, value } })

/** Records the page's long tasks (over 50 ms) from now on; `longestTask` reads the longest one so far. */
const recordLongTasks = (page: Page) =>
  page.evaluate(() => {
    const record = window as unknown as { __r7tasks: number[]; __r7observer?: PerformanceObserver }
    record.__r7observer?.disconnect()
    record.__r7tasks = []
    record.__r7observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record.__r7tasks.push(entry.duration)
    })
    record.__r7observer.observe({ type: "longtask" })
  })
const longestTask = (page: Page) =>
  page.evaluate(() => Math.max(0, ...(window as unknown as { __r7tasks: number[] }).__r7tasks))

/** The texts "0" and "1" a repeat of alternating primitives shows, in order. */
const digits = (scope: Locator) =>
  scope.evaluate((node) =>
    [...node.querySelectorAll('[data-gu="text"]')]
      .map((element) => element.textContent?.trim() ?? "")
      .filter((text) => text === "0" || text === "1"),
  )

const alternating = (count: number) => Array.from({ length: count }, (_, index) => index % 2)

// Each change of a repeat's list matched every item of it, before the rows that render were cut from it, and two of the
// passes were quadratic: one click, agent patch or streamed line blocked the window for about 10 s.
test.describe("a repeat's rows are matched in linear time, over the rows that render [R6S3-1]", () => {
  test("one click that removes the first of 32,000 alternating primitives", async ({ page }) => {
    await boot(page)
    await toolOutput(
      page,
      block("spec", { id: "rows" }, [
        state("/rows", alternating(32000)),
        root("card"),
        element("card", "Card", { title: "Rows" }, ["go", "list"]),
        element("go", "Button", { label: "Remove first" }, [], {
          on: { press: [{ action: "removeState", params: { statePath: "/rows", index: 0 } }] },
        }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows" } }),
        element("row", "Text", { text: { $item: "" } }),
      ]),
    )
    const surface = untrustedSurface(page)
    await expect.poll(async () => (await digits(surface)).length, { timeout: 20_000 }).toBeGreaterThan(1000)
    expect((await digits(surface)).slice(0, 2)).toEqual(["0", "1"])
    await page.waitForTimeout(500)
    await recordLongTasks(page)
    await surface.getByRole("button", { name: "Remove first" }).click()
    await expect.poll(async () => (await digits(surface)).slice(0, 2)).toEqual(["1", "0"])
    await page.waitForTimeout(1000)
    // About 10 s in one task before.
    expect(await longestTask(page)).toBeLessThan(400)
  })

  test("an agent patch that removes the first of 32,000 alternating primitives", async ({ page }) => {
    await boot(page)
    const canvas = page.locator('[data-gu-chrome="canvas"][data-canvas="plan"]')
    await say(
      page,
      block("canvas", { canvas: "plan", title: "Plan" }, [
        state("/rows", alternating(32000)),
        root("card"),
        element("card", "Card", { title: "Rows" }, ["list"]),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows" } }),
        element("row", "Text", { text: { $item: "" } }),
      ]),
    )
    await expect.poll(async () => (await digits(canvas)).length, { timeout: 20_000 }).toBeGreaterThan(1000)
    await page.waitForTimeout(500)
    await recordLongTasks(page)
    // A one-line patch in the next message, no click.
    await say(page, block("canvas", { canvas: "plan" }, [remove("/state/rows/0")]))
    await expect.poll(async () => (await digits(canvas)).slice(0, 2)).toEqual(["1", "0"])
    await page.waitForTimeout(1000)
    expect(await longestTask(page)).toBeLessThan(400)
  })

  test("one click that swaps 16,000 keyed items for fresh ones", async ({ page }) => {
    await boot(page)
    const empty = Array.from({ length: 16000 }, () => [])
    await toolOutput(
      page,
      block("spec", { id: "keyed" }, [
        state("/rows", empty),
        state("/fresh", empty),
        root("card"),
        element("card", "Card", { title: "Keyed" }, ["go", "list"]),
        element("go", "Button", { label: "Swap" }, [], { on: { press: [setState("/rows", { $state: "/fresh" })] } }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows", key: "length" } }),
        element("row", "Text", { text: "." }),
      ]),
    )
    const surface = untrustedSurface(page)
    await expect.poll(() => surface.getByText(".", { exact: true }).count(), { timeout: 20_000 }).toBeGreaterThan(1000)
    await page.waitForTimeout(500)
    await recordLongTasks(page)
    await surface.getByRole("button", { name: "Swap" }).click()
    await page.waitForTimeout(1500)
    // 2.5 s in one task before (each fresh item looked for its key through every previous item).
    expect(await longestTask(page)).toBeLessThan(400)
  })
})

/**
 * An untrusted block with `fields` required fields (each validateForm uses up the task's slice), a Notes field whose
 * watch opens a Dialog, a press `go` whose list is `press`, and the press's progress (/x).
 */
async function modalRace(page: Page, press: unknown[], fields = 1500) {
  await toolOutput(
    page,
    block("spec", { id: "race" }, [
      state("/q", ""),
      state("/open", false),
      state("/x", 0),
      state(
        "/rows",
        Array.from({ length: fields }, () => ({ v: "" })),
      ),
      root("card"),
      element("card", "Card", { title: "Form" }, ["go", "step", "notes", "dlg", "list"]),
      element("go", "Button", { label: "Go" }, [], { on: { press } }),
      element("step", "Text", { text: { $template: "Step ${/x}" } }),
      element("notes", "Input", { label: "Notes", value: { $bindState: "/q" } }, [], {
        watch: { "/q": [setState("/open", true)] },
      }),
      element("dlg", "Dialog", { title: "Session expired", openPath: "/open" }, ["msg"]),
      element("msg", "Text", { text: "Enter your password again" }),
      element("list", "Stack", {}, ["f"], { repeat: { statePath: "/rows" } }),
      element("f", "Input", {
        label: "F",
        value: { $bindItem: "v" },
        checks: [{ type: "required", message: "Required" }],
      }),
    ]),
  )
  const surface = untrustedSurface(page)
  await expect(surface.getByLabel("F", { exact: true })).toHaveCount(fields, { timeout: 20_000 })
  // Notes whether a dialog of the surface opened at any time from now on.
  await surface.evaluate((node) => {
    const record = window as unknown as { __r7opened: boolean }
    record.__r7opened = false
    new MutationObserver(() => {
      if (node.querySelector("dialog[open]")) record.__r7opened = true
    }).observe(node, { attributes: true, attributeFilter: ["open"], subtree: true })
  })
  return surface
}
const dialogOpened = (page: Page) => page.evaluate(() => (window as unknown as { __r7opened: boolean }).__r7opened)

test.describe("an untrusted Dialog and a press whose actions wait for later tasks [R6S3-3]", () => {
  test("typing while the press's list waits does not open the Dialog with the press's activation", async ({ page }) => {
    test.setTimeout(90_000)
    await boot(page)
    const press = Array.from({ length: 30 }, (_, index) => [
      { action: "validateForm" },
      setState("/x", index + 1),
    ]).flat()
    const surface = await modalRace(page, press)
    await surface.getByRole("button", { name: "Go" }).click()
    const notes = surface.getByLabel("Notes")
    await notes.focus()
    // A keystroke handled before the long task's timer finds the slice spent, so its watch's setState waited too, and
    // ran in one batch with the press's: the Dialog opened with the press's activation, and took the next keystrokes.
    let typed = 0
    const started = Date.now()
    while (Date.now() - started < 30_000 && !(await surface.getByText("Step 30").isVisible())) {
      await page.keyboard.type("xxxxx", { delay: 3 })
      typed += 5
    }
    await expect(surface.getByText("Step 30")).toBeVisible()
    expect(await dialogOpened(page)).toBe(false)
    await expect(surface.locator('dialog[data-gu="dialog"]')).toHaveJSProperty("open", false)
    await expect(notes).toHaveValue("x".repeat(typed))
  })

  test("a press whose own setState waits for a later task still opens the Dialog", async ({ page }) => {
    await boot(page)
    const deferred: string[] = []
    page.on("console", (message) => {
      if (message.text().includes("Deferred watches and actions to the next task")) deferred.push(message.text())
    })
    const surface = await modalRace(page, [{ action: "validateForm" }, setState("/open", true)])
    await surface.getByRole("button", { name: "Go" }).click()
    await expect(surface.locator('dialog[data-gu="dialog"]')).toHaveJSProperty("open", true, { timeout: 15_000 })
    // validateForm over 1,500 fields used up the slice: the setState ran in a later task, with the press's activation.
    expect(deferred.length).toBeGreaterThan(0)
  })
})

test.describe("a select-all within its counts goes on, however slow the CPU [R6F3-3]", () => {
  test("1,990 rows whose watch writes four times are all ticked at a 6x slower CPU", async ({ page }) => {
    test.setTimeout(300_000)
    await boot(page)
    const rows = Array.from({ length: 1990 }, (_, index) => ({
      id: `r${index}`,
      name: `Row ${index}`,
      checked: false,
      a: false,
      b: false,
      c: false,
    }))
    const write = (field: string) => setState({ $item: field }, { $state: "/all" })
    await say(
      page,
      block("spec", { id: "all" }, [
        state("/all", false),
        state("/rows", rows),
        root("card"),
        element("card", "Card", { title: "Select all 1990" }, ["all", "list"]),
        element("all", "Checkbox", { label: "Select all", checked: { $bindState: "/all" } }),
        element("list", "Stack", { direction: "vertical", gap: "xs" }, ["row"], {
          repeat: { statePath: "/rows", key: "id" },
        }),
        element("row", "Checkbox", { label: { $item: "name" }, checked: { $bindItem: "checked" } }, [], {
          watch: { "/all": [write("checked"), write("a"), write("b"), write("c")] },
        }),
      ]),
    )
    const surface = page.locator('[data-genui][data-surface="inline"]').last()
    const boxes = surface.locator('input[type="checkbox"]')
    await expect(boxes).toHaveCount(1991, { timeout: 60_000 })
    await page.waitForTimeout(1000)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 })
    try {
      await surface.getByText("Select all", { exact: true }).click()
      // 7,960 state actions, within the 8,000 one change may make: lists were skipped once lists had waited 40 tasks
      // in a row (about 2 s of action time), which a 6x slower CPU passes at about 1,400 rows.
      await expect(surface.locator('input[type="checkbox"]:checked')).toHaveCount(1991, { timeout: 240_000 })
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    }
    await page.waitForTimeout(1000)
    expect(await surface.innerText()).not.toMatch(/\d+ issues?/)
  })
})
