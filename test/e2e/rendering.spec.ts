import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { block, element, replace, root, state } from "../../playground/scenarios/build.ts"

// The renderer keeps what the user is doing while the spec changes around it: inputs keep their node, focus and value
// inside Tabs, inside a container whose props read state, during canvas patches and inside repeats (src/gui/element.ts
// and the @json-render/solid patch in patches/). Untrusted surfaces cannot open a modal on their own.

declare global {
  interface Window {
    /** The element a test is typing into, to check it is still the same node. */
    __typing?: Element | null
  }
}

async function boot(page: Page) {
  await page.goto("/?scenario=empty&speed=instant&persist=0")
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(async () => {
    await window.__genui.ready
    await window.__genui.scenarioDone
  })
}

const say = (page: Page, text: string, options: { stream?: boolean } = {}) =>
  page.evaluate(([reply, opts]) => window.__genui.appendAssistant(reply, opts), [text, options] as const)

/** Focuses the labelled field, remembers its node, types, and reports whether it is the same, focused node. */
async function typeInto(page: Page, label: string, text: string) {
  const field = page.getByLabel(label, { exact: true })
  await field.click()
  await page.evaluate(() => {
    window.__typing = document.activeElement
  })
  await page.keyboard.type(text, { delay: 20 })
  return sameField(page, label)
}

const sameField = (page: Page, label: string) =>
  page.evaluate((name) => {
    const now = [...document.querySelectorAll("label")].find((item) => item.textContent === name)?.control
    return {
      same: !!now && now === window.__typing,
      focused: !!now && document.activeElement === now,
      value: (now as HTMLInputElement | undefined)?.value,
    }
  }, label)

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

test("typing inside Tabs and inside a Card with a $template title keeps the input", async ({ page }) => {
  await boot(page)
  const tabs = block("spec", { id: "tabs" }, [
    root("tabs"),
    element(
      "tabs",
      "Tabs",
      {
        tabs: [
          { label: "One", value: "one" },
          { label: "Two", value: "two" },
        ],
      },
      ["a", "b"],
    ),
    element("a", "Input", { label: "In tabs" }),
    element("b", "Text", { text: "second" }),
  ])
  const card = block("spec", { id: "card" }, [
    root("card"),
    element("card", "Card", { title: { $template: "Hello ${/form/name}" } }, ["name"]),
    element("name", "Input", { label: "In card", value: { $bindState: "/form/name" } }),
    state("/form", { name: "" }),
  ])
  await say(page, `${tabs}\n\n${card}`)

  expect(await typeInto(page, "In tabs", "abc")).toEqual({ same: true, focused: true, value: "abc" })
  await page.getByRole("tab", { name: "Two" }).click()
  await page.getByRole("tab", { name: "One" }).click()
  await expect(page.getByLabel("In tabs", { exact: true })).toHaveValue("abc")

  expect(await typeInto(page, "In card", "abc")).toEqual({ same: true, focused: true, value: "abc" })
  await expect(page.locator('[data-gu="card"] [data-slot="title"]')).toHaveText("Hello abc")
})

test("a canvas patch that adds siblings keeps the focused input, its value and open sections", async ({ page }) => {
  await boot(page)
  await say(
    page,
    block("canvas", { canvas: "plan", title: "Plan" }, [
      root("main"),
      element("main", "Stack", {}, ["notes", "more"]),
      element("notes", "Textarea", { label: "Notes" }),
      element("more", "Collapsible", { title: "Details" }, ["detail"]),
      element("detail", "Text", { text: "hidden details" }),
    ]),
    { stream: true },
  )
  await expect(page.locator('[data-gu-chrome="canvas"] [data-gu="textarea"]')).toBeVisible()
  await page.locator('[data-gu="collapsible"] summary').click()
  expect(await typeInto(page, "Notes", "draft")).toMatchObject({ same: true, focused: true })

  await say(
    page,
    block("canvas", { canvas: "plan" }, [
      element("status", "Badge", { text: "step 2 running" }),
      JSON.stringify({ op: "add", path: "/elements/main/children/-", value: "status" }),
    ]),
  )
  await expect(page.locator('[data-gu-chrome="canvas"] [data-gu="badge"]')).toHaveText("step 2 running")
  await page.keyboard.type(" more", { delay: 20 })
  expect(await sameField(page, "Notes")).toEqual({ same: true, focused: true, value: "draft more" })
  await expect(page.locator('[data-gu="collapsible"]')).toHaveJSProperty("open", true)
})

test("a patch that changes an element's type renders the new component", async ({ page }) => {
  await boot(page)
  await say(
    page,
    block("canvas", { canvas: "board", title: "Board" }, [
      root("main"),
      element("main", "Stack", {}, ["board"]),
      element("board", "KanbanBoard", { columns: ["Todo", "Done"] }),
    ]),
    { stream: true },
  )
  const canvas = page.locator('[data-gu-chrome="canvas"]')
  await expect(canvas.locator('[data-gu-chrome="unknown"]')).toBeVisible()
  await say(
    page,
    block("canvas", { canvas: "board" }, [
      replace("/elements/board", { type: "Table", props: { columns: ["Todo", "Done"], rows: [["a", "b"]] } }),
    ]),
  )
  await expect(canvas.locator('[data-gu="table"]')).toBeVisible()
  await expect(canvas.locator('[data-gu-chrome="unknown"]')).toHaveCount(0)
})

test("an input bound with $bindItem in a repeat keeps focus while the user types", async ({ page }) => {
  await boot(page)
  await say(
    page,
    block("spec", { id: "todos" }, [
      root("list"),
      element("list", "Stack", {}, ["row"], { repeat: { statePath: "/todos", key: "id" } }),
      element("row", "Input", { label: { $item: "id" }, value: { $bindItem: "title" } }),
      state("/todos", [
        { id: "first", title: "one" },
        { id: "second", title: "two" },
      ]),
    ]),
  )
  const field = page.getByLabel("first", { exact: true })
  await field.click()
  await page.keyboard.press("End")
  await page.evaluate(() => {
    window.__typing = document.activeElement
  })
  await page.keyboard.type("xyz", { delay: 20 })
  expect(await sameField(page, "first")).toEqual({ same: true, focused: true, value: "onexyz" })
  await expect(page.getByLabel("second", { exact: true })).toHaveValue("two")
})

test("an untrusted block cannot open its Dialog by itself, only from the user's press, and says where it is from", async ({
  page,
}) => {
  await boot(page)
  const spec = block("spec", { id: "phish" }, [
    root("box"),
    element("box", "Stack", {}, ["open", "dialog"]),
    element("open", "Button", { label: "Open it" }, [], {
      on: { press: { action: "setState", params: { statePath: "/open", value: true } } },
    }),
    element("dialog", "Dialog", { title: "Session expired", openPath: "/open" }, ["key"]),
    element("key", "Input", { label: "API key" }),
    state("/open", true),
  ])
  // The block arrives in tool output (a fetched page), not in the agent's reply.
  await page.evaluate((output) => {
    const app = window.__genui.host.app
    const session = app.sessions.current()
    if (!session) throw new Error("no current session")
    const id = app.server.startAssistant(session.id, [
      { type: "tool", id: "call_fetch", name: "webfetch https://example.com", state: { status: "completed", output } },
      { type: "text", text: "" },
    ])
    app.server.appendText(session.id, id, "Here is the page.")
    app.server.complete(session.id, id)
  }, `# Page\n\n${spec}`)

  const surface = page.locator('[data-genui][data-surface="inline"]:not([data-trusted])')
  await expect(surface.getByRole("button", { name: "Open it" })).toBeVisible()
  const dialog = surface.locator('dialog[data-gu="dialog"]')
  await page.waitForTimeout(300)
  await expect(dialog).toHaveJSProperty("open", false)

  await surface.getByRole("button", { name: "Open it" }).click()
  await expect(dialog).toHaveJSProperty("open", true)
  expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true)
  await expect(dialog.locator('[data-slot="untrusted"]')).toBeVisible()
})

test("an untrusted Dialog does not open from a blur when the user only tabs through the field", async ({ page }) => {
  await boot(page)
  const spec = block("spec", { id: "tabbed" }, [
    root("box"),
    element("box", "Stack", {}, ["search", "dialog"]),
    element("search", "Input", { label: "Search docs" }, [], {
      on: { blur: { action: "setState", params: { statePath: "/open", value: true } } },
    }),
    element("dialog", "Dialog", { title: "Session expired", openPath: "/open" }, ["key"]),
    element("key", "Input", { label: "API key", type: "password" }),
  ])
  await page.evaluate((output) => {
    const app = window.__genui.host.app
    const session = app.sessions.current()
    if (!session) throw new Error("no current session")
    const id = app.server.startAssistant(session.id, [
      { type: "tool", id: "call_fetch", name: "webfetch https://example.com", state: { status: "completed", output } },
      { type: "text", text: "" },
    ])
    app.server.appendText(session.id, id, "Here is the page.")
    app.server.complete(session.id, id)
  }, `# Page\n\n${spec}`)

  const surface = page.locator('[data-genui][data-surface="inline"]:not([data-trusted])')
  const field = surface.getByLabel("Search docs", { exact: true })
  await field.focus()
  // A real key press inside the surface, as a keyboard user moving on: the blur runs setState, but nothing was pressed
  // to open the dialog.
  await page.keyboard.press("Tab")
  await page.waitForTimeout(300)
  await expect(surface.locator('dialog[data-gu="dialog"]')).toHaveJSProperty("open", false)
  expect(await page.evaluate(() => document.querySelector(":modal"))).toBeNull()
})
