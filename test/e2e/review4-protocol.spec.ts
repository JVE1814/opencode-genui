import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the fourth review's protocol findings: choice controls that send on change (USE#1) and what the
// normalizer removes reaching the issues footer (CORRECTNESS#3).

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

const promptTexts = (page: Page) => page.evaluate(() => window.__genui.prompts.map((prompt) => prompt.text))
const surface = (page: Page, title: string): Locator =>
  page.locator(`[data-genui][data-surface="inline"][aria-label="${title}"]`)

// on.change logs the choice in state (a UI-only action), then sends it.
const sendOnChange = (path: string) => ({
  change: [
    { action: "setState", params: { statePath: "/log", value: { $state: path } } },
    { action: "sendPrompt", params: { text: { $template: `Use \${${path}}` } } },
  ],
})

async function radio(page: Page) {
  await say(
    page,
    block("spec", { id: "scope", title: "Scope" }, [
      root("main"),
      element("main", "Stack", {}, ["pick", "log"]),
      element("pick", "Radio", { label: "Scope", options: ["one", "two", "three"], value: { $bindState: "/v" } }, [], {
        on: sendOnChange("/v"),
      }),
      element("log", "Text", { text: { $template: "Logged: ${/log}" } }),
      state("/v", "one"),
      state("/log", ""),
    ]),
  )
  const view = surface(page, "Scope")
  await expect(view.getByRole("radio", { name: "one" })).toBeChecked()
  return view
}

test.describe("choice controls that send on change [review4-protocol USE#1]", () => {
  test.beforeEach(async ({ page }) => boot(page))

  test("arrow keys in a Radio move the choice without sending it; Space then sends the choice it shows", async ({
    page,
  }) => {
    const view = await radio(page)
    await view.getByRole("radio", { name: "one" }).focus()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    await expect(view.getByRole("radio", { name: "three" })).toBeChecked()
    // The UI-only action ran for each step; nothing reached the agent.
    await expect(view.getByText("Logged: three")).toBeVisible()
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual([])

    await page.keyboard.press("Space")
    await expect.poll(() => promptTexts(page)).toEqual(["Use three"])
    // Pressing it again sends nothing more: the choice was already sent.
    await page.waitForTimeout(1100)
    await page.keyboard.press("Space")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual(["Use three"])
  })

  test("Enter sends a choice made with the arrow keys", async ({ page }) => {
    const view = await radio(page)
    await view.getByRole("radio", { name: "one" }).focus()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    await expect(view.getByRole("radio", { name: "two" })).toBeChecked()
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual([])
    await page.keyboard.press("Enter")
    await expect.poll(() => promptTexts(page)).toEqual(["Use two"])
  })

  test("a click on a Radio option sends it at once", async ({ page }) => {
    const view = await radio(page)
    await view.getByText("three", { exact: true }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["Use three"])
    await expect(view.getByText("Logged: three")).toBeVisible()
  })

  test("arrow keys in Tabs move the tab without sending it; Enter sends it", async ({ page }) => {
    await say(
      page,
      block("spec", { id: "tabs", title: "Tabs" }, [
        root("tabs"),
        element(
          "tabs",
          "Tabs",
          {
            tabs: [
              { label: "one", value: "one" },
              { label: "two", value: "two" },
              { label: "three", value: "three" },
            ],
            value: { $bindState: "/v" },
          },
          ["p1", "p2", "p3"],
          { on: sendOnChange("/v") },
        ),
        element("p1", "Text", { text: "Panel 1" }),
        element("p2", "Text", { text: "Panel 2" }),
        element("p3", "Text", { text: "Panel 3" }),
        state("/v", "one"),
      ]),
    )
    const view = surface(page, "Tabs")
    await view.getByRole("tab", { name: "one" }).focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    await expect(view.getByRole("tab", { name: "three" })).toHaveAttribute("aria-selected", "true")
    await expect(view.getByText("Panel 3")).toBeVisible()
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual([])
    await page.keyboard.press("Enter")
    await expect.poll(() => promptTexts(page)).toEqual(["Use three"])
    await view.getByRole("tab", { name: "one" }).click()
    await page.waitForTimeout(1100)
    await view.getByRole("tab", { name: "two" }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["Use three", "Use one", "Use two"])
  })

  test("a choice made within a second of the last one is sent once the gap has passed, not dropped", async ({
    page,
  }) => {
    await say(
      page,
      block("spec", { id: "flags", title: "Flags" }, [
        root("main"),
        element("main", "Stack", {}, ["a", "b", "pages"]),
        element("a", "Switch", { label: "A", checked: { $bindState: "/a" } }, [], {
          on: { change: { action: "sendPrompt", params: { text: { $template: "A is ${/a}" } } } },
        }),
        element("b", "Switch", { label: "B", checked: { $bindState: "/b" } }, [], {
          on: { change: { action: "sendPrompt", params: { text: { $template: "B is ${/b}" } } } },
        }),
        element("pages", "Pagination", { totalPages: 5, page: { $bindState: "/page" } }, [], {
          on: { change: { action: "sendPrompt", params: { text: { $template: "Page ${/page}" } } } },
        }),
        state("/a", false),
        state("/b", false),
        state("/page", 1),
      ]),
    )
    const view = surface(page, "Flags")
    const toggles = view.locator('[data-component="switch"] [data-slot="switch-control"]')
    await toggles.nth(0).click()
    await toggles.nth(1).click()
    await expect(view.getByRole("switch", { name: "B" })).toBeChecked()
    await expect.poll(() => promptTexts(page), { timeout: 3000 }).toEqual(["A is true", "B is true"])

    // Next, Next, Next within a second: page 2 at once, then only the page the control shows.
    await page.waitForTimeout(1100)
    const next = view.getByRole("button", { name: /next/i })
    await next.click()
    await next.click()
    await next.click()
    await expect(view.locator('[aria-current="page"]')).toHaveText("4")
    await expect
      .poll(() => promptTexts(page), { timeout: 3000 })
      .toEqual(["A is true", "B is true", "Page 2", "Page 4"])
  })

  test("arrow keys send nothing while another choice of the same UI waits for the gap [recheck#3]", async ({
    page,
  }) => {
    await say(
      page,
      block("spec", { id: "mixed", title: "Mixed" }, [
        root("main"),
        element("main", "Stack", {}, ["a", "b", "pick"]),
        element("a", "Switch", { label: "A", checked: { $bindState: "/a" } }, [], {
          on: { change: { action: "sendPrompt", params: { text: "A changed" } } },
        }),
        element("b", "Switch", { label: "B", checked: { $bindState: "/b" } }, [], {
          on: { change: { action: "sendPrompt", params: { text: "B changed" } } },
        }),
        element(
          "pick",
          "Radio",
          { label: "Scope", options: ["one", "two", "three"], value: { $bindState: "/v" } },
          [],
          {
            on: sendOnChange("/v"),
          },
        ),
        state("/a", false),
        state("/b", false),
        state("/v", "one"),
        state("/log", ""),
      ]),
    )
    const view = surface(page, "Mixed")
    const toggles = view.locator('[data-component="switch"] [data-slot="switch-control"]')
    await toggles.nth(0).click()
    await toggles.nth(1).click()
    // B waits for the gap with its intent open; the arrow key's change used to take it, and was sent after B.
    await view.getByRole("radio", { name: "one" }).focus()
    await page.keyboard.press("ArrowDown")
    await expect(view.getByRole("radio", { name: "two" })).toBeChecked()
    await expect.poll(() => promptTexts(page), { timeout: 3000 }).toEqual(["A changed", "B changed"])
    await page.waitForTimeout(1500)
    expect(await promptTexts(page)).toEqual(["A changed", "B changed"])
    await page.keyboard.press("Space")
    await expect.poll(() => promptTexts(page), { timeout: 3000 }).toEqual(["A changed", "B changed", "Use two"])
  })

  test("a click on the option the arrow keys moved to sends it, in a Radio and in Tabs [recheck#4]", async ({
    page,
  }) => {
    const view = await radio(page)
    await view.getByRole("radio", { name: "one" }).focus()
    await page.keyboard.press("ArrowDown")
    await expect(view.getByRole("radio", { name: "two" })).toBeChecked()
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual([])
    // The option is already checked, so the browser fires no change for the click.
    await view.getByText("two", { exact: true }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["Use two"])
    // A second click on it sends nothing more: the choice was already sent.
    await page.waitForTimeout(1100)
    await view.getByText("two", { exact: true }).click()
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual(["Use two"])

    await say(
      page,
      block("spec", { id: "tabs", title: "Tabs" }, [
        root("tabs"),
        element(
          "tabs",
          "Tabs",
          {
            tabs: [
              { label: "one", value: "one" },
              { label: "two", value: "two" },
            ],
            value: { $bindState: "/t" },
          },
          ["p1", "p2"],
          { on: sendOnChange("/t") },
        ),
        element("p1", "Text", { text: "Panel 1" }),
        element("p2", "Text", { text: "Panel 2" }),
        state("/t", "one"),
      ]),
    )
    const tabs = surface(page, "Tabs")
    await tabs.getByRole("tab", { name: "one" }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(tabs.getByRole("tab", { name: "two" })).toHaveAttribute("aria-selected", "true")
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual(["Use two"])
    await tabs.getByRole("tab", { name: "two" }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["Use two", "Use two"])
  })
})

test.describe("what the normalizer removes reaches the issues footer [review4-protocol CORRECTNESS#3]", () => {
  test.beforeEach(async ({ page }) => boot(page))

  test("an element without a type and a binding written as a string are listed, and Ask agent to fix sends them", async ({
    page,
  }) => {
    await say(
      page,
      block("spec", { id: "slips", title: "Slips" }, [
        root("main"),
        element("main", "Stack", {}, ["card", "go"]),
        JSON.stringify({ op: "add", path: "/elements/card", value: { props: { title: "Settings" }, children: [] } }),
        element("go", "Button", { label: "Go" }, [], { on: { press: "sendPrompt" } }),
      ]),
    )
    const view = surface(page, "Slips")
    await expect(view.getByRole("button", { name: "Go" })).toBeVisible()
    const footer = view.locator('[data-gu-chrome="issues"]')
    await expect(footer).toHaveCount(1)
    await footer.locator("summary").click()
    await expect(footer).toContainText("has no component type")
    await expect(footer).toContainText("on.press is not an action binding")
    await footer.getByRole("button", { name: /ask/i }).click()
    await expect.poll(async () => (await promptTexts(page)).at(-1) ?? "").toContain("has no component type")
  })
})
