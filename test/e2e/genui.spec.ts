import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, root, state } from "../../playground/scenarios/build.ts"
import { formScenario } from "../../playground/scenarios/form.ts"

// End-to-end tests of the real plugin (src/gui.tsx) in the playground's fake desktop host: inline forms, persistence,
// the streaming canvas, the error card, link safety, untrusted surfaces, the outward-action gate (user gesture, rate
// limit, confirm), canvases whose base is outside the loaded window, and the built bundle.

interface Sample {
  readonly t: number
  /** The canvas tab is in the side strip. */
  readonly tab: boolean
  /** Rendered catalog elements inside the canvas surface. */
  readonly elements: number
  readonly assistants: number
  readonly streaming: number
}

declare global {
  interface Window {
    __samples?: Sample[]
    /** Whether the page had transient user activation when the no-gesture test's timer made its change. */
    __trigger?: { active: boolean }
  }
}

const CANVAS_TAB = '[data-playground-tab="genui:canvas.deploy"]'
const DEPLOY_DEFAULTS = { service: "api", env: "staging", replicas: 3, migrate: true, notify: false }

async function boot(page: Page, query: string, options: { scenario?: boolean } = {}) {
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(() => window.__genui.ready)
  if (options.scenario !== false) await page.evaluate(() => window.__genui.scenarioDone)
}

const promptTexts = (page: Page) => page.evaluate(() => window.__genui.prompts.map((prompt) => prompt.text))

/** A `sendPrompt` message (src/shared/message.ts): the text, then the data as a fenced JSON block. */
function parseSent(message: string): { text: string; data?: unknown } {
  const match = /^([\s\S]*?)\n\n```json\n([\s\S]*)\n```$/.exec(message)
  return match ? { text: match[1]!, data: JSON.parse(match[2]!) as unknown } : { text: message }
}

/** Writes an assistant message holding one block, as the agent's reply. */
async function say(page: Page, text: string) {
  await page.evaluate((reply) => window.__genui.appendAssistant(reply), text)
}

const surfaceByLabel = (page: Page, title: string): Locator =>
  page.locator(`[data-genui][data-surface="inline"][aria-label="${title}"]`)

/** Ticks a Checkbox the way a user does: its drawn box covers the native input, so click the visible label. */
async function tick(surface: Locator, label: string) {
  const checkbox = surface.getByRole("checkbox", { name: label })
  await surface.locator('[data-gu="checkbox"] label[data-slot="label"]').filter({ hasText: label }).click()
  await expect(checkbox).toBeChecked()
}

// Every test ends without plugin errors recorded by the host and without uncaught page errors.
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

test.describe("inline spec blocks", () => {
  test("a form renders once its fence closes and Deploy sends exactly one prompt with its values", async ({ page }) => {
    await boot(page, "scenario=empty&speed=instant&persist=0")
    const [ask, answer] = formScenario.steps
    if (!ask || !("user" in ask) || !answer || !("assistant" in answer)) throw new Error("unexpected form scenario")
    const closing = answer.assistant.lastIndexOf("\n```")
    const head = answer.assistant.slice(0, closing)
    const tail = answer.assistant.slice(closing)

    await page.evaluate((text) => window.__genui.appendUser(text), ask.user)
    await page.evaluate((text) => window.__genui.appendAssistant(text, { complete: false }), head)
    const code = page.locator('[data-component="markdown-code"][data-language="spec"]')
    await expect(code).toHaveAttribute("data-playground-code", "streaming")
    await expect(page.locator("[data-genui]")).toHaveCount(0)

    await page.evaluate((text) => window.__genui.appendText(text), tail)
    const surface = surfaceByLabel(page, "Deploy settings")
    await expect(surface).toBeVisible()
    await expect(code).toHaveAttribute("data-playground-code", "content")
    await expect(surface).toHaveAttribute("data-trusted", "")
    await page.evaluate(() => window.__genui.completeMessage())

    await surface.getByLabel("Service").fill("billing")
    await surface.getByRole("combobox", { name: "Environment" }).click()
    await page.getByRole("option", { name: "Production" }).click()
    await expect(surface.getByRole("combobox", { name: "Environment" })).toHaveText("Production")
    const replicas = surface.getByLabel("Replicas")
    await replicas.focus()
    await replicas.press("ArrowRight")
    await replicas.press("ArrowRight")
    await expect(replicas).toHaveValue("5")
    const migrate = surface.getByRole("switch", { name: "Run database migrations" })
    await expect(migrate).toBeChecked()
    await surface.locator('[data-component="switch"] [data-slot="switch-control"]').click()
    await expect(migrate).not.toBeChecked()
    await tick(surface, "Post to #deploys")

    expect(await promptTexts(page)).toEqual([])
    await surface.getByRole("button", { name: "Deploy" }).click()
    await expect.poll(() => promptTexts(page)).toHaveLength(1)
    // Nothing else is sent afterwards.
    await page.waitForTimeout(1200)
    const prompts = await page.evaluate(() => window.__genui.prompts.map((p) => ({ ...p })))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.sessionID).toBe("ses_playground_a")
    expect(parseSent(prompts[0]!.text)).toEqual({
      text: "Deploy with these settings",
      data: { service: "billing", env: "production", replicas: 5, migrate: false, notify: true },
    })
    // A trusted block's action needs no confirm with the default settings.
    expect(await page.evaluate(() => window.__genui.confirms)).toEqual([])
  })

  test("typing survives virtualized remounts and a page reload", async ({ page }) => {
    await boot(page, "scenario=form&speed=instant")
    const surface = surfaceByLabel(page, "Deploy settings")
    const service = surface.getByLabel("Service")
    const notify = surface.getByRole("checkbox", { name: "Post to #deploys" })
    await service.fill("billing")
    await tick(surface, "Post to #deploys")

    await page.evaluate(() => window.__genui.virtualize(true))
    await expect(page.locator("[data-genui]")).toHaveCount(0)
    await page.evaluate(() => window.__genui.virtualize(false))
    await expect(service).toHaveValue("billing")
    await expect(notify).toBeChecked()

    // Typed right before the reload: the pending (debounced) write must not be lost. (Playwright's pressSequentially on
    // an unfocused field puts the caret at the start, so focus it and go to the end first.)
    await service.click()
    await service.press("End")
    await page.keyboard.type("-eu")
    await expect(service).toHaveValue("billing-eu")
    // The playground keeps the transcript in sessionStorage (written 200 ms after a change); wait for that copy.
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("genui-playground:transcript") !== null))
      .toBe(true)
    await page.reload()
    await page.waitForFunction(() => !!window.__genui)
    await page.evaluate(async () => {
      await window.__genui.ready
      await window.__genui.scenarioDone
    })
    await expect(service).toHaveValue("billing-eu")
    await expect(notify).toBeChecked()
    await expect(surface.getByLabel("Replicas")).toHaveValue(String(DEPLOY_DEFAULTS.replicas))

    await surface.getByRole("button", { name: "Deploy" }).click()
    await expect.poll(() => promptTexts(page)).toHaveLength(1)
    expect(parseSent((await promptTexts(page))[0]!).data).toEqual({
      ...DEPLOY_DEFAULTS,
      service: "billing-eu",
      notify: true,
    })
  })
})

test.describe("canvas", () => {
  test("auto-opens once while streaming, grows progressively, patches in place and stays closed", async ({ page }) => {
    test.setTimeout(60_000)
    // Samples the page every 20 ms from the start, so the assertions see what happened during the stream.
    await page.addInitScript(() => {
      const samples: Sample[] = []
      window.__samples = samples
      setInterval(() => {
        samples.push({
          t: performance.now(),
          tab: !!document.querySelector('[data-playground-tab="genui:canvas.deploy"]'),
          elements: document.querySelectorAll('[data-gu-chrome="canvas"] [data-genui][data-surface="canvas"] [data-gu]')
            .length,
          assistants: document.querySelectorAll('[data-playground-message="assistant"]').length,
          streaming: document.querySelectorAll('[data-playground-message="assistant"][data-streaming]').length,
        })
      }, 20)
    })
    await boot(page, "scenario=canvas&speed=normal&persist=0", { scenario: false })
    const samples = () => page.evaluate(() => window.__samples ?? [])

    const tab = page.locator(CANVAS_TAB)
    const canvas = page.locator('[data-gu-chrome="canvas"][data-canvas="deploy"]')
    await expect(tab).toBeVisible({ timeout: 15_000 })
    const opened = (await samples()).find((sample) => sample.tab)!
    // It opened during the agent's first reply, while that reply was still being written.
    expect(opened).toMatchObject({ assistants: 1, streaming: 1 })

    // The canvas grows while the reply streams.
    await expect
      .poll(async () =>
        (await samples()).some(
          (sample) => sample.assistants === 1 && sample.streaming === 1 && sample.elements > opened.elements,
        ),
      )
      .toBe(true)
    const first = page.locator('[data-playground-message="assistant"]').first()
    await expect(first).not.toHaveAttribute("data-streaming", "", { timeout: 20_000 })
    const badge = canvas.locator('[data-gu="badge"]')
    await expect(badge).toHaveText("building")
    const duringStream = (await samples()).filter((sample) => sample.assistants === 1 && sample.streaming === 1)
    const finalCount = await canvas.locator('[data-genui][data-surface="canvas"] [data-gu]').count()
    expect(Math.min(...duringStream.filter((sample) => sample.tab).map((sample) => sample.elements))).toBeLessThan(
      finalCount,
    )

    // The patch block in the next reply updates the same rendered canvas.
    await canvas
      .locator('[data-genui][data-surface="canvas"]')
      .evaluate((node) => node.setAttribute("data-e2e-mark", ""))
    await expect(badge).toHaveText("switching traffic", { timeout: 15_000 })
    await expect(canvas.getByRole("cell", { name: "Run migrations" }).locator("xpath=..")).toContainText("done")
    await expect(canvas.locator('[data-genui][data-surface="canvas"][data-e2e-mark]')).toHaveCount(1)
    await expect(page.locator('[data-playground-tab^="genui:"]')).toHaveCount(1)

    // Once the user closes it, more streaming does not bring it back.
    await tab.locator("[data-playground-tab-close]").click()
    await expect(tab).toHaveCount(0)
    await page.evaluate(() => window.__genui.scenarioDone)
    await page.waitForTimeout(500)
    await expect(tab).toHaveCount(0)
    expect(await page.evaluate(() => window.__genui.layout())).toMatchObject({ keys: [] })

    const all = await samples()
    const appearances = all.filter((sample, index) => sample.tab && !all[index - 1]?.tab).length
    expect(appearances).toBe(1)
    expect(all.at(-1)).toMatchObject({ assistants: 3, streaming: 0, tab: false })

    // The last block still applied while the tab was closed.
    await page.locator('[data-gu-chrome="chip"]').last().getByRole("button", { name: "Open" }).click()
    await expect(canvas.locator('[data-gu="badge"]')).toHaveText("live")
    await expect(canvas.locator('[data-gu="alert"]')).toContainText("Deployed")
  })

  test("a canvas whose first block is outside the loaded window opens with its full content", async ({ page }) => {
    await boot(page, "scenario=history&speed=instant&persist=0")
    const messages = await page.evaluate(() => window.__genui.messages())
    const base = messages.find(
      (message) =>
        message.type === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text.includes('"op":"add","path":"/root"')),
    )
    expect(base).toBeDefined()
    // The base block's message is not in the client's loaded window (the timeline shows the window).
    await expect(page.locator(`[data-message-id="${base!.id}"]`)).toHaveCount(0)
    expect(await page.locator("[data-playground-message]").count()).toBeLessThan(messages.length)
    // A history load and a live patch are not new canvases: nothing opens by itself.
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.__genui.layout())).toMatchObject({ keys: [] })

    const chip = page.locator('[data-gu-chrome="chip"]')
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText("Migration checklist")
    await chip.getByRole("button", { name: "Open" }).click()

    const canvas = page.locator('[data-gu-chrome="canvas"][data-canvas="migration"]')
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('header [data-slot="title"]')).toHaveText("Migration checklist")
    await expect(canvas.locator('[data-gu="card"]')).toContainText("Postgres 16 migration")
    const rows = canvas.locator("tbody tr")
    await expect(rows).toHaveCount(3)
    // The base's rows, with the live patch applied on top.
    await expect(rows.nth(0).locator("td")).toHaveText(["Snapshot the database", "yes"])
    await expect(rows.nth(1).locator("td")).toHaveText(["Upgrade staging", "yes"])
    await expect(rows.nth(2).locator("td")).toHaveText(["Upgrade production", "no"])
    await expect(canvas.locator('[data-gu-chrome="notice"]')).toHaveCount(0)
  })
})

test("an invalid spec shows the error card, whose Ask agent to fix sends the issues", async ({ page }) => {
  await boot(page, "scenario=invalid&speed=instant&persist=0")
  const card = page.locator('[data-gu-chrome="error"]')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("KanbanBoard")
  await card.getByRole("button", { name: "Ask agent to fix" }).click()
  await expect.poll(() => promptTexts(page)).toHaveLength(1)
  const [message] = await promptTexts(page)
  expect(message).toMatch(/^The UI "Release board" \(inline spec `release-board`\) has problems:\n- /)
  expect(message).toContain("KanbanBoard")
  expect(message).toMatch(/Please resend the corrected ```spec block\.$/)
  expect(await page.evaluate(() => window.__genui.confirms)).toEqual([])
})

test("javascript: links in a Link, in Markdown and in an openLink action do nothing", async ({ page }) => {
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`)
    void dialog.dismiss()
  })
  const popups: string[] = []
  page.on("popup", (popup) => popups.push(popup.url()))
  await boot(page, "scenario=empty&speed=instant&persist=0")
  const url = page.url()
  await say(
    page,
    block("spec", { id: "links", title: "Links" }, [
      root("main"),
      element("main", "Stack", { gap: "sm" }, ["bad", "shouty", "markdown", "action", "good", "safe-markdown"]),
      element("bad", "Link", { label: "Bad link", href: "javascript:alert(1)" }),
      element("shouty", "Link", { label: "Shouty link", href: "  JavaScript:alert(document.domain)" }),
      element("markdown", "Markdown", { content: "Read [the docs](javascript:alert(1)) first." }),
      element("action", "Button", { label: "Open via action" }, [], {
        on: { press: { action: "openLink", params: { url: "javascript:alert(1)" } } },
      }),
      element("good", "Link", { label: "Good link", href: "https://example.com/docs" }),
      element("safe-markdown", "Markdown", { content: "Or see [the changelog](https://example.com/changelog)." }),
    ]),
  )
  const surface = surfaceByLabel(page, "Links")
  await expect(surface).toBeVisible()
  await expect(page.locator('a[href^="javascript:" i], a[href*="script:" i]')).toHaveCount(0)

  await surface.getByText("Bad link").click()
  await surface.getByText("Shouty link").click()
  await surface.locator('[data-gu="markdown"]').getByText("the docs").click()
  await surface.getByRole("button", { name: "Open via action" }).click()
  await page.waitForTimeout(300)

  expect(dialogs).toEqual([])
  expect(page.url()).toBe(url)
  const records = await page.evaluate(() => ({
    opened: [...window.__genui.opened],
    links: [...window.__genui.links],
    confirms: [...window.__genui.confirms],
    alerts: [...window.__genui.alerts],
  }))
  expect(records).toEqual({ opened: [], links: [], confirms: [], alerts: [] })
  await expect(page.locator('[data-playground-dialog] [role="dialog"]')).toHaveCount(0)

  // The same surface's safe links do open, through the plugin (so the clicks above were live): a Link, and a Markdown
  // link after the one-second limit between outward actions.
  await surface.getByRole("link", { name: "Good link" }).click()
  await expect.poll(() => page.evaluate(() => [...window.__genui.opened])).toEqual(["https://example.com/docs"])
  await page.waitForTimeout(1100)
  await surface.getByRole("link", { name: "the changelog" }).click()
  await expect
    .poll(() => page.evaluate(() => [...window.__genui.opened]))
    .toEqual(["https://example.com/docs", "https://example.com/changelog"])
  expect(dialogs).toEqual([])
  expect(popups).toEqual([])
  expect(page.url()).toBe(url)
})

test("a spec block in tool output is untrusted and asks before it sends", async ({ page }) => {
  await boot(page, "scenario=untrusted&speed=instant&persist=0")
  const surface = page.locator("[data-playground-tool-output]").locator('[data-genui][data-surface="inline"]').first()
  await expect(surface).toBeVisible()
  await expect(surface).not.toHaveAttribute("data-trusted", "")
  await expect(surface.locator('[data-gu-chrome="untrusted"]')).toBeVisible()

  await surface.getByLabel("Version").fill("1.2.0")
  await surface.getByRole("button", { name: "Send to agent" }).click()
  const dialog = page.locator('[data-playground-dialog="host"] [role="dialog"]')
  await expect(dialog).toContainText("Send this message to the agent?")
  await expect(dialog).toContainText("not from the agent's reply")
  await expect(dialog).toContainText('"version": "1.2.0"')
  expect(await promptTexts(page)).toEqual([])
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(await promptTexts(page)).toEqual([])

  // Past the one-second limit, confirming sends it.
  await page.waitForTimeout(1000)
  await surface.getByRole("button", { name: "Send to agent" }).click()
  await dialog.getByRole("button", { name: "Send" }).click()
  await expect.poll(() => promptTexts(page)).toHaveLength(1)
  expect(parseSent((await promptTexts(page))[0]!)).toEqual({ text: "Release", data: { version: "1.2.0" } })
  expect(await page.evaluate(() => window.__genui.confirms.map((c) => (c as { answer: boolean }).answer))).toEqual([
    false,
    true,
  ])
})

test.describe("outward action gate", () => {
  // An Input whose watch first shows a toast (so the test can see the watch ran) and then tries to send a prompt.
  const watched = block("spec", { id: "watched", title: "Watched" }, [
    root("main"),
    element("main", "Stack", {}, ["query"]),
    element("query", "Input", { label: "Query", value: { $bindState: "/query" } }, [], {
      watch: {
        "/query": [
          { action: "showToast", params: { title: "watch ran" } },
          { action: "sendPrompt", params: { text: "sent from watch", data: { $state: "/query" } } },
        ],
      },
    }),
    state("/query", ""),
  ])

  const toastTitles = (page: Page) =>
    page.evaluate(() => window.__genui.toasts.map((toast) => (toast as { title: string }).title))

  test("a watch-triggered sendPrompt without a user gesture does not send", async ({ page }) => {
    await boot(page, "scenario=empty&speed=instant&persist=0")
    await say(page, watched)
    const surface = surfaceByLabel(page, "Watched")
    await expect(surface).toBeVisible()

    // Playwright runs page.evaluate as a user gesture, and Chromium's transient activation lasts about 5 s. So a timer
    // makes the change (an untrusted input event, as a script would) once that has expired, and nothing touches the
    // page in between; the timer records whether the page still had activation.
    await page.evaluate(() => {
      setTimeout(() => {
        // Looked up now, in case the surface remounted while the timer waited.
        const input = document.querySelector<HTMLInputElement>('[aria-label="Watched"] input[data-slot="input"]')!
        window.__trigger = { active: navigator.userActivation.isActive }
        input.value = "from script"
        input.dispatchEvent(new InputEvent("input", { bubbles: true }))
      }, 6_500)
    })
    await page.waitForTimeout(7_500)
    expect(await page.evaluate(() => window.__trigger)).toEqual({ active: false })
    await expect.poll(() => toastTitles(page)).toEqual(["watch ran"])
    await page.waitForTimeout(500)
    expect(await promptTexts(page)).toEqual([])
    expect(await page.evaluate(() => window.__genui.confirms)).toEqual([])
  })

  test("a watch-triggered sendPrompt does not send while the user types into the watched field", async ({ page }) => {
    await boot(page, "scenario=empty&speed=instant&persist=0")
    await say(page, watched)
    const surface = surfaceByLabel(page, "Watched")
    const query = surface.getByLabel("Query")
    await expect(query).toBeVisible()
    // Past the activation the test's own page.evaluate calls give (see above), so the only gesture is the typing.
    await page.waitForTimeout(6_000)
    await query.click()
    await query.pressSequentially("abc")
    await expect(query).toHaveValue("abc")
    // The watch ran (its toast is not an outward action), but outward actions never run from watch.
    await expect.poll(async () => (await toastTitles(page)).length).toBeGreaterThan(0)
    await page.waitForTimeout(500)
    expect(await promptTexts(page)).toEqual([])
  })

  test("two quick presses of Deploy send one prompt", async ({ page }) => {
    await boot(page, "scenario=form&speed=instant&persist=0")
    const deploy = surfaceByLabel(page, "Deploy settings").getByRole("button", { name: "Deploy" })
    await deploy.click()
    await deploy.click()
    await page.waitForTimeout(1200)
    const texts = await promptTexts(page)
    expect(texts).toHaveLength(1)
    expect(parseSent(texts[0]!)).toEqual({ text: "Deploy with these settings", data: DEPLOY_DEFAULTS })
  })

  test("the limit holds across buttons of one surface and lifts after a second", async ({ page }) => {
    await boot(page, "scenario=empty&speed=instant&persist=0")
    await say(
      page,
      block("spec", { id: "two-buttons", title: "Two buttons" }, [
        root("main"),
        element("main", "Stack", { direction: "horizontal" }, ["first", "second"]),
        element("first", "Button", { label: "First" }, [], {
          on: { press: { action: "sendPrompt", params: { text: "first" } } },
        }),
        element("second", "Button", { label: "Second" }, [], {
          on: { press: { action: "sendPrompt", params: { text: "second" } } },
        }),
      ]),
    )
    const surface = surfaceByLabel(page, "Two buttons")
    await surface.getByRole("button", { name: "First" }).click()
    await surface.getByRole("button", { name: "Second" }).click()
    await page.waitForTimeout(300)
    expect(await promptTexts(page)).toEqual(["first"])

    await page.waitForTimeout(1000)
    await surface.getByRole("button", { name: "Second" }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["first", "second"])
  })
})

test("the built bundle renders the form scenario", async ({ page }) => {
  expect(
    existsSync(fileURLToPath(new URL("../../dist/gui-experimental.cjs", import.meta.url))),
    "dist/gui-experimental.cjs is missing: run `bun run build` first",
  ).toBe(true)
  await boot(page, "scenario=form&speed=instant&persist=0&bundle=1")
  expect(await page.evaluate(() => ({ mode: window.__genui.mode, bundle: window.__genui.bundle }))).toEqual({
    mode: "bundle",
    bundle: "/dist/gui-experimental.cjs",
  })
  const surface = surfaceByLabel(page, "Deploy settings")
  await expect(surface).toBeVisible()
  await expect(surface).toHaveAttribute("data-trusted", "")
  await expect(page.locator('head style[data-plugin="genui"]')).toHaveCount(1)
  await surface.getByLabel("Service").fill("billing")
  await surface.getByRole("button", { name: "Deploy" }).click()
  await expect.poll(() => promptTexts(page)).toHaveLength(1)
  expect(parseSent((await promptTexts(page))[0]!)).toEqual({
    text: "Deploy with these settings",
    data: { ...DEPLOY_DEFAULTS, service: "billing" },
  })
})
