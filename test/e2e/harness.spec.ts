import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"

// Tests of the playground's fake desktop host itself, with the stub plugin (playground/stub/gui.tsx): code blocks mount
// only once their fence closes and remount after scrolling away, panel tabs open through ctx.layout.open, and a built
// bundle loads through the same require shim the app uses.

interface StubCounters {
  renders: number
  disposals: number
  panelRenders: number
  panelDisposals: number
  setups: number
}

declare global {
  interface Window {
    __stub?: StubCounters
  }
}

async function boot(page: Page, query: string) {
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(async () => {
    await window.__genui.ready
    await window.__genui.scenarioDone
  })
}

const counters = (page: Page) => page.evaluate(() => ({ ...window.__stub! }))

test.describe("fake host with the stub plugin", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page, "plugin=stub&speed=instant")
  })

  test("loads the plugin and injects its Style contribution", async ({ page }) => {
    expect(await page.evaluate(() => window.__genui.mode)).toBe("stub")
    expect((await counters(page)).setups).toBe(1)
    await expect(page.locator('head style[data-plugin="stub"]')).toHaveCount(1)
    expect(await page.evaluate(() => window.__genui.errors)).toEqual([])
  })

  test("mounts a code block only after its closing fence arrives", async ({ page }) => {
    await page.evaluate(() => window.__genui.appendAssistant("Intro text.\n\n```stubtest\nhello", { complete: false }))
    const code = page.locator('[data-component="markdown-code"][data-language="stubtest"]')
    await expect(code).toHaveAttribute("data-playground-code", "streaming")
    await expect(code.locator("pre")).toHaveText("hello")
    await expect(page.locator("[data-stub-block]")).toHaveCount(0)
    expect((await counters(page)).renders).toBe(0)

    await page.evaluate(() => window.__genui.appendText(" world\n```\n\nMore text"))
    const content = code.locator('[data-slot="markdown-code-content"] [data-stub-block]')
    await expect(content).toHaveText("hello world")
    await expect(content).toHaveAttribute("data-plugin-id", "stub")
    await expect(code).toHaveAttribute("data-code-content", "")
    await expect(code.locator("pre")).toBeHidden()

    // Later deltas and completion do not render the block again.
    await page.evaluate(() => window.__genui.appendText(" and the rest of the reply."))
    await page.evaluate(() => window.__genui.completeMessage())
    await expect(page.locator('[data-playground-message="assistant"][data-streaming]')).toHaveCount(0)
    expect((await counters(page)).renders).toBe(1)
  })

  test("a block streamed in deltas mounts once", async ({ page }) => {
    await page.evaluate(() =>
      window.__genui.appendAssistant("Streaming:\n\n```stubtest\nline one\nline two\n```\n\nDone.", { stream: true }),
    )
    await expect(page.locator("[data-stub-block]")).toHaveText("line one\nline two")
    expect((await counters(page)).renders).toBe(1)
  })

  test("remounts code blocks after they scroll off screen", async ({ page }) => {
    await page.evaluate(() => window.__genui.appendAssistant("```stubtest\nkept\n```"))
    await expect(page.locator("[data-stub-block]")).toHaveText("kept")

    await page.evaluate(() => window.__genui.virtualize(true))
    await expect(page.locator("[data-stub-block]")).toHaveCount(0)
    expect(await counters(page)).toMatchObject({ renders: 1, disposals: 1 })

    await page.evaluate(() => window.__genui.virtualize(false))
    await expect(page.locator("[data-stub-block]")).toHaveText("kept")
    expect(await counters(page)).toMatchObject({ renders: 2, disposals: 1 })
  })

  test("shows the code when a render throws or declines, and records the error", async ({ page }) => {
    await page.evaluate(() =>
      window.__genui.appendAssistant("```stubthrow\nboom\n```\n\n```stubnull\nplain\n```\n\n```text\nnobody\n```"),
    )
    await expect(page.locator('[data-language="stubthrow"]')).toHaveAttribute("data-playground-code", "failed")
    await expect(page.locator('[data-language="stubthrow"] pre')).toHaveText("boom")
    await expect(page.locator('[data-language="stubnull"]')).toHaveAttribute("data-playground-code", "failed")
    await expect(page.locator('[data-language="stubnull"] pre')).toBeVisible()
    await expect(page.locator('[data-language="text"]')).toHaveAttribute("data-playground-code", "code")
    const errors = await page.evaluate(() => window.__genui.errors)
    expect(errors).toEqual([{ plugin: "stub", where: "CodeBlock render", message: "stub render failed" }])
  })

  test("opens a panel tab through ctx.layout.open and closes it", async ({ page }) => {
    await expect(page.locator("[data-playground-side]")).toHaveCount(0)
    expect(await page.evaluate(() => window.__genui.runCommand("stub.open"))).toBe(true)

    const tab = page.locator('[data-playground-tab="stub:main"]')
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await expect(page.locator("[data-stub-panel-title]")).toHaveText("Stub panel")
    await expect(page.locator("[data-stub-panel-session]")).toHaveText("ses_playground_a")
    await expect(page.locator("[data-stub-panel]")).toHaveAttribute("data-visible", "")
    expect(await page.evaluate(() => window.__genui.layout())).toMatchObject({
      keys: ["stub:main"],
      active: "stub:main",
      open: true,
    })

    // The panel reads and writes a global store; ctx.plural formats the count.
    await page.locator("[data-stub-panel] button").click()
    await expect(page.locator("[data-stub-panel] button")).toHaveText("1 click")

    await tab.locator("[data-playground-tab-close]").click()
    await expect(tab).toHaveCount(0)
    expect(await counters(page)).toMatchObject({ panelRenders: 1, panelDisposals: 1 })
    expect(await page.evaluate(() => window.__genui.layout())).toMatchObject({ keys: [] })
  })

  test("runs commands from the palette and menu items from the + menu", async ({ page }) => {
    await page.getByRole("button", { name: "Commands" }).click()
    const command = page.locator('[data-playground-command="stub.open"]')
    await expect(command).toContainText("Open the stub panel")
    await expect(command.locator('[data-component="keybind-v2"]')).toHaveText("CtrlShiftU")
    await command.getByRole("button", { name: "Run" }).click()
    await expect(page.locator("[data-stub-panel]")).toBeVisible()

    await page.locator('[data-playground-tab="stub:main"] [data-playground-tab-close]').click()
    await page.getByRole("button", { name: "Toggle side panel" }).click()
    await page.locator("[data-playground-new-tab]").getByRole("button", { name: "Stub panel" }).click()
    await expect(page.locator("[data-stub-panel]")).toBeVisible()
  })

  test("confirm dialogs can be answered by clicking or scripted", async ({ page }) => {
    await page.evaluate(() => window.__genui.runCommand("stub.confirm"))
    const dialog = page.locator('[data-playground-dialog="host"] [role="dialog"]')
    await expect(dialog).toContainText("Proceed?")
    await dialog.getByRole("button", { name: "Yes" }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-playground-toast="success"]')).toContainText("Confirmed")

    await page.evaluate(() => window.__genui.setConfirmAnswer(false))
    await page.evaluate(() => window.__genui.runCommand("stub.confirm"))
    await expect(page.locator("[data-playground-toast]").filter({ hasText: "Cancelled" })).toBeVisible()
    await expect(dialog).toHaveCount(0)
    const confirms = await page.evaluate(() => window.__genui.confirms)
    expect(confirms).toMatchObject([
      { title: "Proceed?", answer: true },
      { title: "Proceed?", answer: false },
    ])
  })

  test("the side strip belongs to the routed session", async ({ page }) => {
    await page.evaluate(() => window.__genui.runCommand("stub.open"))
    await expect(page.locator("[data-stub-panel]")).toBeVisible()
    await page.evaluate(() => window.__genui.routeSession(1))
    await expect(page.locator("[data-playground-side]")).toHaveCount(0)
    await page.evaluate(() => window.__genui.runCommand("stub.open"))
    await expect(page.locator("[data-stub-panel-session]")).toHaveText("ses_playground_b")
  })
})

test("plays a scenario and switches the theme", async ({ page }) => {
  await boot(page, "plugin=stub&scenario=form&speed=instant&theme=dark")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  const messages = await page.evaluate(() => window.__genui.messages())
  expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
  // Without a plugin that claims ```spec, the block shows as code.
  await expect(page.locator('[data-component="markdown-code"][data-language="spec"]')).toHaveAttribute(
    "data-playground-code",
    "code",
  )
  await page.getByRole("button", { name: "Light" }).click()
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
})

test("loads a built bundle through the app's require shim", async ({ page }) => {
  await boot(page, "bundle=stub&speed=instant")
  const hooks = await page.evaluate(() => ({ mode: window.__genui.mode, bundle: window.__genui.bundle }))
  expect(hooks).toEqual({ mode: "bundle", bundle: "/__genui/stub-bundle.cjs" })
  expect(await page.evaluate(() => window.__genui.errors)).toEqual([])
  expect((await counters(page)).setups).toBe(1)

  await page.evaluate(() => window.__genui.appendAssistant("```stubtest\nfrom the bundle\n```"))
  await expect(page.locator("[data-stub-block]")).toHaveText("from the bundle")

  await page.evaluate(() => window.__genui.runCommand("stub.open"))
  await page.locator("[data-stub-panel] button").click()
  await expect(page.locator("[data-stub-panel] button")).toHaveText("1 click")
})
