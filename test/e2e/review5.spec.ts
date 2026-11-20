import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the fifth review's findings ([review5#S<n>] security and performance, [review5#F<n>] function):
// watches, modals and repeats that could stall the window, and the choices, quotes and canvases around them.

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

async function boot(page: Page, query = "scenario=empty&speed=instant&persist=0") {
  await page.goto(`/?${query}`)
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

const surfaceByLabel = (page: Page, title: string): Locator =>
  page.locator(`[data-genui][data-surface="inline"][aria-label="${title}"]`)
const untrustedSurfaces = (page: Page) =>
  page.locator('[data-playground-tool-output] [data-genui][data-surface="inline"]')
const promptTexts = (page: Page) => page.evaluate(() => window.__genui.prompts.map((prompt) => prompt.text))

/** How long the page takes to answer: a frozen main thread answers late. */
async function answerTime(page: Page): Promise<number> {
  const started = Date.now()
  await page.evaluate(() => 1 + 1)
  return Date.now() - started
}

const setState = (statePath: string, value: unknown) => ({ action: "setState", params: { statePath, value } })

test.describe("watches", () => {
  test("a key press in a field whose watch runs a long action list costs about one press [review5#S1]", async ({
    page,
  }) => {
    await boot(page)
    // The watch writes the path it watches 200 times. Under a bound of 64 runs per task it ran its list 64 times, with
    // every write re-rendering the 100 rows: one key press stalled the window for seconds.
    const writes = Array.from({ length: 200 }, (_, index) => setState("/q", index % 2 ? "a" : "b"))
    const rows = Array.from({ length: 100 }, (_, index) => `row${index}`)
    await toolOutput(
      page,
      block("spec", { id: "amp" }, [
        root("box"),
        element("box", "Stack", {}, ["search", "w", ...rows]),
        element("search", "Input", { label: "Search", value: { $bindState: "/q" } }),
        element("w", "Text", { text: "watching" }, [], { watch: { "/q": writes } }),
        ...rows.map((key, index) => element(key, "Text", { text: { $template: `row ${index}: \${/q}` } })),
        state("/q", ""),
      ]),
    )
    const surface = untrustedSurfaces(page)
    await surface.getByLabel("Search").click()
    const started = Date.now()
    await page.keyboard.type("x")
    await answerTime(page)
    expect(Date.now() - started).toBeLessThan(2000)
    // The watch ran its list once: the last write wins.
    await expect(surface.getByText("row 0: a")).toBeVisible()
  })

  test("a press with a long list of writes in a UI of many rows answers at once [review5#S1]", async ({ page }) => {
    await boot(page)
    // Every write re-evaluated every element: 400 writes over 400 rows took seconds (1,000 over 1,500, a minute).
    const writes = Array.from({ length: 400 }, (_, index) => setState("/q", `v${index}`))
    const rows = Array.from({ length: 400 }, (_, index) => `row${index}`)
    await toolOutput(
      page,
      block("spec", { id: "press" }, [
        root("box"),
        element("box", "Stack", {}, ["go", ...rows]),
        element("go", "Button", { label: "Go" }, [], { on: { press: writes } }),
        ...rows.map((key, index) => element(key, "Text", { text: { $template: `row ${index}: \${/q}` } })),
        state("/q", ""),
      ]),
    )
    const surface = untrustedSurfaces(page)
    await expect(surface.getByText("row 0:", { exact: true })).toBeVisible()
    const started = Date.now()
    await surface.getByRole("button", { name: "Go" }).click()
    await answerTime(page)
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(surface.getByText("row 0: v399")).toBeVisible()
  })

  test("a watch that adds to the list it watches adds one item per change, not 64 [review5#S1]", async ({ page }) => {
    await boot(page)
    const push = { action: "pushState", params: { statePath: "/items", value: { $state: "/q" } } }
    await toolOutput(
      page,
      block("spec", { id: "grow" }, [
        root("box"),
        element("box", "Stack", {}, ["note", "list"]),
        element("note", "Input", { label: "Note", value: { $bindState: "/q" } }, [], { watch: { "/q": push } }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/items" }, watch: { "/items": push } }),
        element("row", "Text", { text: "item" }),
        state("/q", ""),
        state("/items", []),
      ]),
    )
    const surface = untrustedSurfaces(page)
    await surface.getByLabel("Note").click()
    for (let index = 0; index < 5; index++) await page.keyboard.type("a")
    // Each key press: the field's watch adds one item, and the list's watch, woken by that, one more; the list's watch
    // is not woken by its own push.
    await expect(surface.getByText("item", { exact: true })).toHaveCount(10)
    expect(await answerTime(page)).toBeLessThan(1000)
  })

  test("one change wakes a watch in each of 100 rows, and every row follows a select-all [review5#F4]", async ({
    page,
  }) => {
    await boot(page)
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: `r${index}`, name: `Row ${index}`, checked: false }))
    await say(
      page,
      block("spec", { id: "select-all", title: "Select all" }, [
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
    const surface = surfaceByLabel(page, "Select all")
    await surface.getByText("Select all", { exact: true }).click()
    // Under a bound of 64 runs per task, rows past the 64th stayed unticked.
    await expect(surface.locator('input[type="checkbox"]:checked')).toHaveCount(101)
    await surface.getByText("Select all", { exact: true }).click()
    await expect(surface.locator('input[type="checkbox"]:checked')).toHaveCount(0)
  })
})

test.describe("modals", () => {
  test("a modal opened on a field's focus and closed on its blur does not loop [review5#S2]", async ({ page }) => {
    await boot(page)
    // showModal() moves focus off the field (blur closes the modal) and close() gives it back (focus opens it again):
    // this looped within one task until the stack overflowed, about 18 s of frozen window per click.
    await say(
      page,
      block("spec", { id: "focus-help", title: "Focus help" }, [
        root("box"),
        element("box", "Stack", {}, ["search", "help"]),
        element("search", "Input", { label: "Search", value: { $bindState: "/q" } }, [], {
          on: { focus: setState("/open", true), blur: setState("/open", false) },
        }),
        element("help", "Dialog", { title: "Tip", openPath: "/open" }, ["tip"]),
        element("tip", "Text", { text: "Press Escape to close." }),
        state("/open", false),
        state("/q", ""),
      ]),
    )
    const surface = surfaceByLabel(page, "Focus help")
    const started = Date.now()
    await surface.getByLabel("Search").click()
    await answerTime(page)
    expect(Date.now() - started).toBeLessThan(2000)
    // Focus is no activation: the modal does not open at all.
    await expect(surface.locator('dialog[data-gu="dialog"]')).toHaveJSProperty("open", false)
    await expect(surface.getByLabel("Search")).toBeFocused()
  })

  test("a watch cannot re-open a modal as the user closes it [review5#S2]", async ({ page }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "trap", title: "Trap" }, [
        root("box"),
        element("box", "Stack", {}, ["show", "dlg"]),
        element("show", "Button", { label: "Show" }, [], { on: { press: setState("/open", true) } }),
        element("dlg", "Dialog", { title: "Tip", openPath: "/open" }, ["tip"], {
          watch: { "/open": setState("/open", true) },
        }),
        element("tip", "Text", { text: "Press Escape to close." }),
        state("/open", true),
      ]),
    )
    const surface = surfaceByLabel(page, "Trap")
    const dialog = surface.locator('dialog[data-gu="dialog"]')
    await expect(dialog).toHaveJSProperty("open", true)
    // Escape closes it, and it stays closed: the watch's re-open in the same task is refused.
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveJSProperty("open", false)
    await page.waitForTimeout(300)
    await expect(dialog).toHaveJSProperty("open", false)
    expect(await page.evaluate(() => document.querySelectorAll(":modal").length)).toBe(0)
    // The close button too, after the user's own press opened it again.
    await surface.getByRole("button", { name: "Show" }).click()
    await expect(dialog).toHaveJSProperty("open", true)
    await dialog.getByRole("button", { name: "Close" }).click()
    await page.waitForTimeout(300)
    await expect(dialog).toHaveJSProperty("open", false)
  })

  test("typing while another choice waits for the gap does not open an untrusted modal [review5#S4]", async ({
    page,
  }) => {
    await boot(page)
    await page.evaluate(() => window.__genui.setConfirmAnswer(true))
    const send = (text: string) => ({ action: "sendPrompt", params: { text } })
    await toolOutput(
      page,
      block("spec", { id: "leak" }, [
        root("card"),
        element("card", "Card", { title: "Flags" }, ["a", "b", "notes", "dlg"]),
        element("a", "Switch", { label: "Flag A", checked: { $bindState: "/a" } }, [], { on: { change: send("A") } }),
        element("b", "Switch", { label: "Flag B", checked: { $bindState: "/b" } }, [], { on: { change: send("B") } }),
        element("notes", "Input", { label: "Notes", value: { $bindState: "/q" } }, [], {
          watch: { "/q": setState("/open", true) },
        }),
        element("dlg", "Dialog", { title: "Session expired", openPath: "/open" }, ["t"]),
        element("t", "Text", { text: "Sign in again." }),
        state("/open", false),
      ]),
    )
    const surface = untrustedSurfaces(page)
    await surface.getByRole("switch", { name: "Flag A" }).click({ force: true })
    // B waits for the gap with its intent; typing meanwhile is no activation of the modal.
    await surface.getByRole("switch", { name: "Flag B" }).click({ force: true })
    await surface.getByLabel("Notes").focus()
    await page.keyboard.type("x")
    await expect(surface.locator('dialog[data-gu="dialog"]')).toHaveJSProperty("open", false)
    // B still goes, after the gap.
    await expect.poll(() => promptTexts(page)).toEqual(["A", "B"])
    await expect(surface.locator('dialog[data-gu="dialog"]')).toHaveJSProperty("open", false)
  })
})

test.describe("render budget", () => {
  test("nested repeats render at most the surface's budget, quickly, and say so [review5#S3]", async ({ page }) => {
    await boot(page)
    // 300 × 300 items from a 3 KB block made 90,000 elements: 13 s of frozen window, then an error card.
    const items = Array.from({ length: 300 }, (_, index) => index)
    const started = Date.now()
    await toolOutput(
      page,
      block("spec", { id: "nested" }, [
        root("outer"),
        element("outer", "Stack", {}, ["row"], { repeat: { statePath: "/a" } }),
        element("row", "Stack", { direction: "horizontal" }, ["cell"], { repeat: { statePath: "/b" } }),
        element("cell", "Text", { text: "x" }),
        state("/a", items),
        state("/b", items),
      ]),
    )
    await answerTime(page)
    expect(Date.now() - started).toBeLessThan(3000)
    const surface = untrustedSurfaces(page)
    expect(await surface.locator('[data-gu="text"]').count()).toBeLessThan(2000)
    expect(await surface.locator('[data-gu="text"]').count()).toBeGreaterThan(1000)
    await expect(surface.locator('[data-gu-chrome="issues"]')).toContainText("too large")
  })

  test("a long text read in every row counts once per row [review5#S3]", async ({ page }) => {
    await boot(page)
    const doc = "lorem ipsum ".repeat(4000)
    const started = Date.now()
    await toolOutput(
      page,
      block("spec", { id: "rows" }, [
        root("list"),
        element("list", "Stack", {}, ["cell"], { repeat: { statePath: "/rows" } }),
        element("cell", "Markdown", { content: { $state: "/doc" } }),
        state(
          "/rows",
          Array.from({ length: 200 }, (_, index) => index),
        ),
        state("/doc", doc),
      ]),
    )
    await answerTime(page)
    // 200 rows of 48 KB each took seconds; the first rows that fit render, the rest are reported.
    expect(Date.now() - started).toBeLessThan(3000)
    const surface = untrustedSurfaces(page)
    const shown = await surface.locator('[data-gu="markdown"]').count()
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(20)
    await expect(surface.locator('[data-gu-chrome="issues"]')).toContainText("too large")
  })
})

// on.change logs the choice in state (a UI-only action), then sends it.
const sendOnChange = (path: string) => ({
  change: [
    { action: "setState", params: { statePath: "/log", value: { $state: path } } },
    { action: "sendPrompt", params: { text: { $template: `Use \${${path}}` } } },
  ],
})

test.describe("choices", () => {
  test("arrow keys and letters on a closed Select send nothing; a pick from its list does [review5#F3]", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "env", title: "Env" }, [
        root("main"),
        element("main", "Stack", {}, ["pick", "log"]),
        element("pick", "Select", { label: "Env", options: ["one", "two", "three"], value: { $bindState: "/v" } }, [], {
          on: sendOnChange("/v"),
        }),
        element("log", "Text", { text: { $template: "Logged: ${/log}" } }),
        state("/v", "one"),
        state("/log", ""),
      ]),
    )
    const view = surfaceByLabel(page, "Env")
    const trigger = view.getByRole("combobox", { name: "Env" })
    await trigger.focus()
    // The app's select (Kobalte) picks the next option on ArrowRight, and the next match of a letter, while closed:
    // each pick was a choice that genui sent.
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("t")
    await page.waitForTimeout(300)
    await expect(trigger).toHaveText("one")
    expect(await promptTexts(page)).toEqual([])
    // The list opens as before, and a pick from it is the choice.
    await page.keyboard.press("ArrowDown")
    await page.getByRole("option", { name: "three" }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["Use three"])
  })

  test("browsing away and back, then Enter, sends nothing in a Radio or Tabs [review5#F6]", async ({ page }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "scope", title: "Scope" }, [
        root("main"),
        element("main", "Stack", {}, ["pick", "tabs"]),
        element(
          "pick",
          "Radio",
          { label: "Scope", options: ["one", "two", "three"], value: { $bindState: "/v" } },
          [],
          {
            on: sendOnChange("/v"),
          },
        ),
        element(
          "tabs",
          "Tabs",
          {
            tabs: [
              { label: "first", value: "first" },
              { label: "second", value: "second" },
            ],
            value: { $bindState: "/t" },
          },
          ["p1", "p2"],
          { on: sendOnChange("/t") },
        ),
        element("p1", "Text", { text: "Panel 1" }),
        element("p2", "Text", { text: "Panel 2" }),
        state("/v", "one"),
        state("/t", "first"),
        state("/log", ""),
      ]),
    )
    const view = surfaceByLabel(page, "Scope")
    // Radio: the starting value, away and back, Enter: the agent has it already. Before, it was sent again.
    await view.getByRole("radio", { name: "one" }).focus()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Enter")
    await page.keyboard.press("Space")
    // A chosen value, then away and back.
    await view.getByText("two", { exact: true }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["Use two"])
    await page.waitForTimeout(1100)
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Enter")
    // Tabs, the same.
    await view.getByRole("tab", { name: "first" }).focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(1300)
    expect(await promptTexts(page)).toEqual(["Use two"])
    // A browsed change still goes on Enter.
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Enter")
    await expect.poll(() => promptTexts(page)).toEqual(["Use two", "Use second"])
  })
})
