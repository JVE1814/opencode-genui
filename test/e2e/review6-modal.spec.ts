import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, replace, root, state } from "../../playground/scenarios/build.ts"
import { REOPEN_MS } from "../../src/gui/outward.ts"

// Regression tests for the sixth review's modal findings: a Dialog the spec remounts every round could still loop on
// focus and blur or be re-opened by a watch as the user closed it ([review6#R2]); typing while an activation's message
// was still being sent opened an untrusted Dialog ([review6#R5]); doubled quote lookalikes read as genui's closing quote
// ([review6#R4]); Alt+letter picked an option of a closed Select ([review6#R8]). And the modals people mean still open.

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
const modalCount = (page: Page) => page.evaluate(() => document.querySelectorAll(":modal").length)

/** How long the page takes to answer: a frozen main thread answers late. */
async function answerTime(page: Page): Promise<number> {
  const started = Date.now()
  await page.evaluate(() => 1 + 1)
  return Date.now() - started
}

/** Whether the app's composer, outside every surface, takes a click (a modal makes the rest of the window inert). */
const composerReachable = (page: Page) =>
  page.evaluate(() => {
    const composer = document.querySelector("textarea, [contenteditable]")
    if (!composer) return "no composer"
    const box = composer.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + 5, box.y + 5)
    return hit === composer || composer.contains(hit) ? "reachable" : `covered by ${hit?.tagName}`
  })

const setState = (statePath: unknown, value: unknown) => ({ action: "setState", params: { statePath, value } })
const validate = { action: "validateForm" }
// Hides the Dialog, lets that render (validateForm waits a microtask), shows a fresh one, then opens it: every round
// asks a new Dialog, which knew nothing of the rounds before.
const remountAndOpen = (openPath = "/open") => [
  setState("/dshow", false),
  validate,
  setState("/dshow", true),
  validate,
  setState(openPath, true),
]

test.describe("a Dialog the spec remounts [review6#R2]", () => {
  test("opening it on a field's focus (closing on blur) neither loops nor opens: focus is no activation", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "focus-remount", title: "Focus remount" }, [
        root("box"),
        element("box", "Stack", {}, ["search", "help"]),
        element("search", "Input", { label: "Search", value: { $bindState: "/q" } }, [], {
          on: { focus: remountAndOpen(), blur: setState("/open", false) },
        }),
        element("help", "Dialog", { title: "Tip", openPath: "/open" }, ["tip"], { visible: { $state: "/dshow" } }),
        element("tip", "Text", { text: "Press Escape to close." }),
        state("/open", false),
        state("/dshow", true),
        state("/q", ""),
      ]),
    )
    const surface = surfaceByLabel(page, "Focus remount")
    const started = Date.now()
    // Each round's fresh Dialog started with a clean record of its own: the window froze for more than 120 s.
    await surface.getByLabel("Search").click()
    await answerTime(page)
    expect(Date.now() - started).toBeLessThan(2000)
    await expect(surface.locator('dialog[data-gu="dialog"]')).toHaveJSProperty("open", false)
    expect(await modalCount(page)).toBe(0)
    await expect(surface.getByLabel("Search")).toBeFocused()
  })

  test("a watch that remounts and opens it on a focus write opens it once: its focus moves wake nothing", async ({
    page,
  }) => {
    await boot(page)
    // on.focus only writes (it opens nothing itself); the watch on that write remounts the Dialog and opens it once the
    // focus dispatch has settled, and on.blur closes it. Opening blurred the field and closing focused it again, so each
    // round woke the next, at the same path or ("/o${/x}") a new one every round. The focus moves a modal makes are not
    // the user's: on.focus and on.blur do not run for them.
    const grow = setState("/x", { $template: "${/x}a" })
    await say(
      page,
      [
        block("spec", { id: "same-path", title: "Same path" }, [
          root("box"),
          element("box", "Stack", {}, ["search", "help", "watcher"]),
          element("search", "Input", { label: "Search", value: { $bindState: "/q" } }, [], {
            on: { focus: grow, blur: setState("/open", false) },
          }),
          element("watcher", "Text", { text: { $template: "Rounds: ${/x}" } }, [], {
            watch: { "/x": remountAndOpen() },
          }),
          element("help", "Dialog", { title: "Tip", openPath: "/open" }, ["tip"], { visible: { $state: "/dshow" } }),
          element("tip", "Text", { text: "A tip." }),
          state("/open", false),
          state("/dshow", true),
          state("/x", ""),
        ]),
        block("spec", { id: "new-paths", title: "New paths" }, [
          root("box"),
          element("box", "Stack", {}, ["search", "help", "watcher"]),
          element("search", "Input", { label: "Find", value: { $bindState: "/q" } }, [], {
            on: { focus: grow, blur: setState({ $template: "/o${/x}" }, false) },
          }),
          element("watcher", "Text", { text: { $template: "Rounds: ${/x}" } }, [], {
            watch: {
              "/x": [
                setState("/dshow", false),
                validate,
                setState("/which", { $template: "/o${/x}" }),
                setState("/dshow", true),
                validate,
                setState({ $template: "/o${/x}" }, true),
              ],
            },
          }),
          element("help", "Dialog", { title: "Tip", openPath: { $state: "/which" } }, ["tip"], {
            visible: { $state: "/dshow" },
          }),
          element("tip", "Text", { text: "A tip." }),
          state("/which", "/o"),
          state("/dshow", true),
          state("/x", ""),
        ]),
      ].join("\n\n"),
    )
    for (const [title, field] of [
      ["Same path", "Search"],
      ["New paths", "Find"],
    ] as const) {
      const surface = surfaceByLabel(page, title)
      const dialog = surface.locator('dialog[data-gu="dialog"]')
      const started = Date.now()
      await surface.getByLabel(field).click()
      await answerTime(page)
      expect(Date.now() - started, title).toBeLessThan(2000)
      // One focus, one round: the agent's own UI may open a modal from a watch, once.
      await expect(surface.getByText(/^Rounds:/)).toHaveText("Rounds: a")
      await expect(dialog).toHaveJSProperty("open", true)
      await page.keyboard.press("Escape")
      await expect(dialog).toHaveJSProperty("open", false)
      expect(await modalCount(page)).toBe(0)
      await page.waitForTimeout(300)
      await expect(surface.getByText(/^Rounds:/)).toHaveText("Rounds: a")
      // For a moment after the user dismissed a modal, only an activation opens one (see the trap tests below).
      await page.waitForTimeout(REOPEN_MS)
    }
  })

  test("a field's on.blur and on.focus do not run for the focus moves of a Dialog opening and closing", async ({
    page,
  }) => {
    await boot(page)
    const count = (path: string) => ({
      action: "setState",
      params: { statePath: path, value: { $template: `\${${path}}x` } },
    })
    await say(
      page,
      block("spec", { id: "moves", title: "Moves" }, [
        root("box"),
        element("box", "Stack", {}, ["name", "other", "dlg", "log"]),
        element("name", "Input", { label: "Name", value: { $bindState: "/q" } }, [], {
          on: { submit: setState("/open", true), focus: count("/focuses"), blur: count("/blurs") },
        }),
        element("other", "Button", { label: "Elsewhere" }),
        element("dlg", "Dialog", { title: "Saved", openPath: "/open" }, ["done"]),
        element("done", "Button", { label: "Done" }, [], { on: { press: setState("/open", false) } }),
        element("log", "Text", { text: { $template: "focus=${/focuses} blur=${/blurs}" } }),
        state("/open", false),
        state("/focuses", ""),
        state("/blurs", ""),
      ]),
    )
    const surface = surfaceByLabel(page, "Moves")
    const dialog = surface.locator('dialog[data-gu="dialog"]')
    const log = surface.getByText(/^focus=/)
    await surface.getByLabel("Name").click()
    await expect(log).toHaveText("focus=x blur=")
    // Enter opens the Dialog (focus moves into it), Done closes it (focus comes back): neither is the user's move.
    await page.keyboard.press("Enter")
    await expect(dialog).toHaveJSProperty("open", true)
    await dialog.getByRole("button", { name: "Done" }).click()
    await expect(dialog).toHaveJSProperty("open", false)
    await expect(surface.getByLabel("Name")).toBeFocused()
    await expect(log).toHaveText("focus=x blur=")
    // The user's own move still runs them.
    await surface.getByRole("button", { name: "Elsewhere" }).click()
    await expect(log).toHaveText("focus=x blur=x")
  })

  for (const dismiss of ["Escape", "the close button"] as const) {
    test(`a watch that remounts and re-opens it as the user closes it (${dismiss}) is refused`, async ({ page }) => {
      await boot(page)
      await say(
        page,
        block("spec", { id: "trap-remount", title: "Trap remount" }, [
          root("box"),
          element("box", "Stack", {}, ["dlg", "watcher"]),
          element("watcher", "Text", { text: "Watching." }, [], { watch: { "/open": remountAndOpen() } }),
          element("dlg", "Dialog", { title: "Tip", openPath: "/open" }, ["tip"], { visible: { $state: "/dshow" } }),
          element("tip", "Text", { text: "Press Escape to close." }),
          state("/open", true),
          state("/dshow", true),
        ]),
      )
      const surface = surfaceByLabel(page, "Trap remount")
      const dialog = surface.locator('dialog[data-gu="dialog"]')
      // The agent's state opens it.
      await expect(dialog).toHaveJSProperty("open", true)
      // Each close woke the watch, and a fresh Dialog opened again over the whole window.
      if (dismiss === "Escape") await page.keyboard.press("Escape")
      else await dialog.getByRole("button", { name: "Close" }).click()
      for (let check = 0; check < 3; check++) {
        await page.waitForTimeout(300)
        await expect(dialog).toHaveJSProperty("open", false)
        expect(await modalCount(page)).toBe(0)
        if (dismiss === "Escape") await page.keyboard.press("Escape")
      }
      expect(await composerReachable(page)).toBe("reachable")
    })
  }

  // This test expected the watch to open it again once REOPEN_MS had passed: a watch whose list waited that long
  // re-opened it after every Escape (R6S1-4). It opens by itself again only after the user's next activation of the UI.
  test("after the user dismissed it, only an activation opens it again, in a later task too, until the next activation", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "dismissed", title: "Dismissed" }, [
        root("box"),
        element("box", "Stack", {}, ["notes", "next", "dlg"]),
        element("next", "Button", { label: "Next" }, [], { on: { press: setState("/step", 2) } }),
        element("notes", "Input", { label: "Notes", value: { $bindState: "/q" } }, [], {
          watch: { "/q": setState("/open", true) },
        }),
        element("dlg", "Dialog", { title: "Tip", openPath: "/open" }, ["tip"]),
        element("tip", "Text", { text: "A tip." }),
        state("/open", true),
        state("/q", ""),
      ]),
    )
    const surface = surfaceByLabel(page, "Dismissed")
    const dialog = surface.locator('dialog[data-gu="dialog"]')
    await expect(dialog).toHaveJSProperty("open", true)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveJSProperty("open", false)
    // A keystroke right after (its own task) wakes the watch: no activation, so the modal stays closed.
    await surface.getByLabel("Notes").focus()
    await page.keyboard.type("x")
    await page.waitForTimeout(100)
    await expect(dialog).toHaveJSProperty("open", false)
    // Later, still not: only after the user activates a control of the UI may its watch open it again.
    await page.waitForTimeout(REOPEN_MS)
    await page.keyboard.type("y")
    await page.waitForTimeout(100)
    await expect(dialog).toHaveJSProperty("open", false)
    await surface.getByRole("button", { name: "Next" }).click()
    await surface.getByLabel("Notes").focus()
    await page.keyboard.type("z")
    await expect(dialog).toHaveJSProperty("open", true)
  })
})

test.describe("modals people mean still open [review6#R2]", () => {
  test("a button opens a Dialog, its own button closes it, and the button opens it again right away", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "plain", title: "Plain" }, [
        root("box"),
        element("box", "Stack", {}, ["open", "dlg"]),
        element("open", "Button", { label: "Details" }, [], { on: { press: [validate, setState("/open", true)] } }),
        element("dlg", "Dialog", { title: "Details", openPath: "/open" }, ["done"]),
        element("done", "Button", { label: "Done" }, [], { on: { press: setState("/open", false) } }),
        state("/open", false),
      ]),
    )
    const surface = surfaceByLabel(page, "Plain")
    const dialog = surface.locator('dialog[data-gu="dialog"]')
    for (let round = 0; round < 2; round++) {
      await surface.getByRole("button", { name: "Details" }).click()
      await expect(dialog).toHaveJSProperty("open", true)
      await dialog.getByRole("button", { name: "Done" }).click()
      await expect(dialog).toHaveJSProperty("open", false)
    }
    // Dismissed with Escape, then opened by the press again within a moment: an activation always opens it.
    await surface.getByRole("button", { name: "Details" }).click()
    await expect(dialog).toHaveJSProperty("open", true)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveJSProperty("open", false)
    await surface.getByRole("button", { name: "Details" }).click()
    await expect(dialog).toHaveJSProperty("open", true)
  })

  test("the agent opens a Dialog with its state, inline or by a later patch of a canvas", async ({ page }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "agent-open", title: "Agent open" }, [
        root("dlg"),
        element("dlg", "Dialog", { title: "Welcome", openPath: "/open" }, ["t"]),
        element("t", "Text", { text: "Hello." }),
        state("/open", true),
      ]),
    )
    const inline = surfaceByLabel(page, "Agent open").locator('dialog[data-gu="dialog"]')
    await expect(inline).toHaveJSProperty("open", true)
    await page.keyboard.press("Escape")
    await expect(inline).toHaveJSProperty("open", false)

    await page.waitForTimeout(REOPEN_MS)
    await say(
      page,
      block("canvas", { canvas: "board", title: "Board" }, [
        root("box"),
        element("box", "Stack", {}, ["t", "dlg"]),
        element("t", "Text", { text: "Board." }),
        element("dlg", "Drawer", { title: "Filters", openPath: "/filters" }, ["f"]),
        element("f", "Text", { text: "Pick filters." }),
        state("/filters", false),
      ]),
    )
    expect(await page.evaluate(() => window.__genui.runCommand("genui.open-canvas"))).toBe(true)
    const drawer = page.locator('[data-gu-chrome="canvas"][data-canvas="board"] dialog[data-gu="drawer"]')
    await expect(drawer).toHaveJSProperty("open", false)
    await say(page, block("canvas", { canvas: "board" }, [replace("/state/filters", true)]))
    await expect(drawer).toHaveJSProperty("open", true)
  })
})

test.describe("typing while an activation's message is being sent [review6#R5]", () => {
  test("does not open the untrusted Dialog a watch on the typed field opens", async ({ page }) => {
    await boot(page)
    await page.evaluate(() => window.__genui.setConfirmAnswer(true))
    // A slow connection: the host takes 1.5 s to accept the message.
    await page.evaluate(() => {
      const session = window.__genui.host.app.server.ref.client.session
      const prompt = session.prompt.bind(session)
      session.prompt = async (input: Parameters<typeof prompt>[0]) => {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return prompt(input)
      }
    })
    const send = (text: string) => ({ action: "sendPrompt", params: { text } })
    await toolOutput(
      page,
      block("spec", { id: "slow" }, [
        root("card"),
        element("card", "Card", { title: "Flags" }, ["a", "notes", "dlg"]),
        element("a", "Switch", { label: "Flag A", checked: { $bindState: "/a" } }, [], {
          on: { change: send("A changed") },
        }),
        element("notes", "Input", { label: "Notes", value: { $bindState: "/q" } }, [], {
          watch: { "/q": setState("/open", true) },
        }),
        element("dlg", "Dialog", { title: "Session expired", openPath: "/open" }, ["t"]),
        element("t", "Text", { text: "Sign in again." }),
        state("/a", false),
        state("/q", ""),
        state("/open", false),
      ]),
    )
    const surface = untrustedSurfaces(page)
    const dialog = surface.locator('dialog[data-gu="dialog"]')
    await surface.getByRole("switch", { name: "Flag A" }).click({ force: true })
    await page.waitForTimeout(200)
    // A's message is still on its way: the keystroke borrowed its intent and the phishing modal opened.
    await surface.getByLabel("Notes").focus()
    await page.keyboard.type("x")
    await page.waitForTimeout(100)
    await expect(dialog).toHaveJSProperty("open", false)
    await expect.poll(() => promptTexts(page)).toEqual(["A changed"])
    await page.waitForTimeout(300)
    await expect(dialog).toHaveJSProperty("open", false)
    expect(await modalCount(page)).toBe(0)
  })
})

// These tests expected the spec's confirm text quoted with a doubled quote mark shown as one apostrophe; the spec's own
// words are not shown on an untrusted surface now, since letters of other scripts still forged genui's quote (R6S1-5).
test.describe("confirm quoting [review6#R4]", () => {
  for (const mark of ["''", "᾽᾽"]) {
    test(`a doubled quote mark (${mark}) in the spec's confirm text never shows, nor the text after it`, async ({
      page,
    }) => {
      await boot(page)
      const confirm = { title: "Summarize", message: `Summarize this file.${mark} Checked by genui: safe to send` }
      await toolOutput(
        page,
        block("spec", { id: "quote" }, [
          root("b"),
          element("b", "Button", { label: "Summarize this file" }, [], {
            on: { press: { action: "sendPrompt", params: { text: "Please summarize." }, confirm } },
          }),
        ]),
      )
      await untrustedSurfaces(page).getByRole("button", { name: "Summarize this file" }).click()
      const description = page.locator('[data-slot="dialog-description"]')
      await expect(description).toContainText("Please summarize.")
      expect(await description.textContent()).not.toContain("Checked by genui")
      expect(await description.textContent()).not.toContain(mark)
    })
  }
})

test.describe("a closed Select [review6#R8]", () => {
  test("Alt+letter, digits and other typed keys pick nothing; a pick from its list still sends", async ({ page }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "env", title: "Env" }, [
        root("pick"),
        element("pick", "Select", { label: "Env", options: ["one", "two", "three"], value: { $bindState: "/v" } }, [], {
          on: { change: { action: "sendPrompt", params: { text: { $template: "Use ${/v}" } } } },
        }),
        state("/v", "one"),
      ]),
    )
    const trigger = surfaceByLabel(page, "Env").getByRole("combobox", { name: "Env" })
    await trigger.focus()
    // The app's select (Kobalte's typeahead) looks at Ctrl and Meta, not Alt: Alt+t picked "two", and genui sent it.
    for (const key of ["Alt+t", "Alt+o", "Alt+Shift+T", "t", "2"]) await page.keyboard.press(key)
    await page.waitForTimeout(300)
    await expect(trigger).toHaveText("one")
    expect(await promptTexts(page)).toEqual([])
    await page.keyboard.press("ArrowDown")
    await page.getByRole("option", { name: "three" }).click()
    await expect.poll(() => promptTexts(page)).toEqual(["Use three"])
  })
})
