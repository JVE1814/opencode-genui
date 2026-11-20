import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the fourth review's findings closed at integration: a message a UI sends uses the model picked in
// the composer (FIDELITY#5).

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

const sends = (page: Page) =>
  page.evaluate(() => ({
    prompts: window.__genui.prompts.map((prompt) => prompt.text),
    switches: window.__genui.modelSwitches.map((item) => item.model),
  }))

test("a message a UI sends runs on the model picked in the composer, switched once [review4 FIDELITY#5]", async ({
  page,
}) => {
  await boot(page)
  await page.evaluate(
    (reply) => window.__genui.appendAssistant(reply),
    block("spec", { id: "go", title: "Go" }, [
      root("main"),
      element("main", "Stack", {}, ["one", "two"]),
      element("one", "Button", { label: "First" }, [], {
        on: { press: { action: "sendPrompt", params: { text: "first" } } },
      }),
      element("two", "Button", { label: "Second" }, [], {
        on: { press: { action: "sendPrompt", params: { text: "second" } } },
      }),
      state("/x", 1),
    ]),
  )
  const view = page.locator('[data-genui][data-surface="inline"][aria-label="Go"]')

  // The composer still shows the session's model: nothing to switch.
  await view.getByRole("button", { name: "First" }).click()
  await expect.poll(() => sends(page)).toEqual({ prompts: ["first"], switches: [] })

  // The user picks another model in the composer, then presses the UI's button: the session switches before the prompt.
  await page.evaluate(() =>
    window.__genui.host.app.sessions.screen.composer.setModel({
      providerID: "provider-b",
      modelID: "model-b",
      variant: "high",
    }),
  )
  await page.waitForTimeout(1100)
  await view.getByRole("button", { name: "Second" }).click()
  await expect
    .poll(() => sends(page))
    .toEqual({
      prompts: ["first", "second"],
      switches: [{ id: "model-b", providerID: "provider-b", variant: "high" }],
    })

  // Once the session runs on it, the next message switches nothing.
  await page.waitForTimeout(1100)
  await view.getByRole("button", { name: "First" }).click()
  await expect.poll(async () => (await sends(page)).prompts).toEqual(["first", "second", "first"])
  expect((await sends(page)).switches).toHaveLength(1)
})
