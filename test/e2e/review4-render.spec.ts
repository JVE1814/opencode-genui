import { expect, test, type Locator, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { add, block, element, remove, replace, root, state } from "../../playground/scenarios/build.ts"

// Regression tests for the fourth review's rendering and session findings ([review4 RENDER#n] and friends): list edits
// follow their item, secrets stay out of storage when the spec changes, repeat rows over equal items keep focus,
// remounts keep open sections and their height, a re-sent block's older copy keeps what the user entered, a canvas
// root switch keeps the canvas, the streaming clamp leaves finished code alone, and the canvas panel's narrow view.

declare global {
  interface Window {
    /** The element a test is typing into, to check it is still the same node. */
    __typing?: Element | null
    __frames?: string[]
  }
}

async function boot(page: Page, query = "scenario=empty&speed=instant&persist=0") {
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(async () => {
    await window.__genui.ready
    await window.__genui.scenarioDone
  })
}

const say = (page: Page, text: string) => page.evaluate((reply) => window.__genui.appendAssistant(reply), text)
const canvasView = (page: Page, canvas: string) => page.locator(`[data-gu-chrome="canvas"][data-canvas="${canvas}"]`)
const openLatestCanvas = async (page: Page) =>
  expect(await page.evaluate(() => window.__genui.runCommand("genui.open-canvas"))).toBe(true)

/** A `sendPrompt` message: the text, then the data as a fenced JSON block. */
function parseSent(message: string): { text: string; data?: unknown } {
  const match = /^([\s\S]*?)\n\n```json\n([\s\S]*)\n```$/.exec(message)
  return match ? { text: match[1]!, data: JSON.parse(match[2]!) as unknown } : { text: message }
}

/** Remembers the focused element, so `stillFocused` can tell whether it was replaced. */
const remember = (page: Page) =>
  page.evaluate(() => {
    window.__typing = document.activeElement
  })
const stillFocused = (page: Page) => page.evaluate(() => document.activeElement === window.__typing)

/** Every sessionStorage value of the playground (its session stores), as one string. */
const stored = (page: Page) =>
  page.evaluate(() => {
    const values: string[] = []
    for (let index = 0; index < sessionStorage.length; index++)
      values.push(sessionStorage.getItem(sessionStorage.key(index)!)!)
    return values.join("\n")
  })

test.describe("list edits follow their item [review4 RENDER#1]", () => {
  test("a check stays on its todo and is sent for it when the agent inserts and removes todos before it", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("canvas", { canvas: "todo", title: "Migration" }, [
        root("page"),
        element("page", "Stack", {}, ["list", "send"]),
        element("send", "Button", { label: "Report progress" }, [], {
          on: { press: { action: "sendPrompt", params: { text: "Progress", data: { $state: "/todos" } } } },
        }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/todos", key: "title" } }),
        element("row", "Checkbox", { label: { $item: "title" }, checked: { $bindItem: "done" } }),
        state("/todos", [
          { title: "A", done: false },
          { title: "B", done: false },
          { title: "C", done: false },
        ]),
      ]),
    )
    await openLatestCanvas(page)
    const canvas = canvasView(page, "todo")
    await canvas.locator('[data-gu="checkbox"] label[data-slot="label"]').filter({ hasText: "B" }).click()
    const checks = () =>
      canvas
        .locator('[data-gu="checkbox"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => `${node.textContent?.trim()}=${node.querySelector("input")?.checked}`),
        )
    await expect.poll(checks).toEqual(["A=false", "B=true", "C=false"])

    await say(page, block("canvas", { canvas: "todo" }, [add("/state/todos/0", { title: "N", done: false })]))
    // Before, the check stayed at index 1 and moved to A.
    await expect.poll(checks).toEqual(["N=false", "A=false", "B=true", "C=false"])
    await canvas.getByRole("button", { name: "Report progress" }).click()
    await expect.poll(() => page.evaluate(() => window.__genui.prompts.length)).toBe(1)
    const sent = parseSent(await page.evaluate(() => window.__genui.prompts[0]!.text))
    expect(sent.data).toEqual([
      { title: "N", done: false },
      { title: "A", done: false },
      { title: "B", done: true },
      { title: "C", done: false },
    ])

    await say(page, block("canvas", { canvas: "todo" }, [remove("/state/todos/0"), remove("/state/todos/0")]))
    await expect.poll(checks).toEqual(["B=true", "C=false"])
  })

  test("text typed into an item stays with it, and further typing goes on there, while the agent inserts before it", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("canvas", { canvas: "review", title: "Review" }, [
        root("list"),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/files", key: "path" } }),
        element("row", "Input", { label: { $item: "path" }, value: { $bindItem: "note" } }),
        state("/files", [
          { path: "a.ts", note: "" },
          { path: "b.ts", note: "" },
        ]),
      ]),
    )
    await openLatestCanvas(page)
    const canvas = canvasView(page, "review")
    await canvas.getByLabel("b.ts").click()
    await remember(page)
    await page.keyboard.type("needs tests", { delay: 10 })
    await say(page, block("canvas", { canvas: "review" }, [add("/state/files/0", { path: "README.md", note: "" })]))
    await expect(canvas.getByLabel("README.md")).toBeVisible()
    await page.keyboard.type(" too", { delay: 10 })
    await expect(canvas.getByLabel("b.ts")).toHaveValue("needs tests too")
    await expect(canvas.getByLabel("a.ts")).toHaveValue("")
    expect(await stillFocused(page)).toBe(true)
  })
})

test("a typed password stays out of storage once the agent's patch removes its Input [review4 SECURITY#3]", async ({
  page,
}) => {
  await boot(page, "scenario=empty&speed=instant")
  await say(
    page,
    block("canvas", { canvas: "db", title: "Database" }, [
      state("/form", { user: "admin", pw: "" }),
      root("card"),
      element("card", "Card", { title: "Connect" }, ["user", "pw"]),
      element("user", "Input", { label: "User", value: { $bindState: "/form/user" } }),
      element("pw", "Input", { label: "Database password", type: "password", value: { $bindState: "/form/pw" } }),
    ]),
  )
  await openLatestCanvas(page)
  const canvas = canvasView(page, "db")
  await canvas.getByLabel("Database password").fill("hunter2-S3cret!")
  await canvas.getByLabel("User").fill("root")
  await expect.poll(() => stored(page)).toContain("root")
  await say(
    page,
    block("canvas", { canvas: "db" }, [remove("/elements/pw"), replace("/elements/card/children", ["user"])]),
  )
  await expect(canvas.getByLabel("Database password")).toHaveCount(0)
  // A later edit writes the surface's entry again.
  await canvas.getByLabel("User").fill("admin2")
  await expect.poll(() => stored(page)).toContain("admin2")
  // Before, the password became an ordinary edit once nothing declared it secret, and was written to the session store.
  expect(await stored(page)).not.toContain("hunter2")
})

test.describe("repeat rows over equal items [review4 RENDER#3]", () => {
  test("typing into one of several empty fields, or toggling one of several equal switches, keeps the control", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "emails" }, [
        root("list"),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/emails" } }),
        element("row", "Input", { label: "Email", value: { $bindItem: "" } }),
        state("/emails", ["", "", ""]),
      ]),
    )
    const inputs = page.locator('[data-genui] [data-gu="input"] input')
    await expect(inputs).toHaveCount(3)
    await inputs.nth(1).click()
    await remember(page)
    await page.keyboard.type("abc", { delay: 20 })
    // Before, the row lost its id to an equal row and remounted after the first key.
    expect(await stillFocused(page)).toBe(true)
    expect(await inputs.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))).toEqual([
      "",
      "abc",
      "",
    ])
  })

  test("a row the agent copied keeps focus while the user edits the original", async ({ page }) => {
    await boot(page)
    await say(
      page,
      block("canvas", { canvas: "todos", title: "Todos" }, [
        root("list"),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/todos" } }),
        element("row", "Input", { label: "Todo", value: { $bindItem: "title" } }),
        state("/todos", [{ title: "Write tests" }, { title: "Ship" }]),
      ]),
    )
    await openLatestCanvas(page)
    const canvas = canvasView(page, "todos")
    await say(
      page,
      block("canvas", { canvas: "todos" }, [
        JSON.stringify({ op: "copy", from: "/state/todos/0", path: "/state/todos/-" }),
      ]),
    )
    const inputs = canvas.locator('[data-gu="input"] input')
    await expect(inputs).toHaveCount(3)
    await inputs.nth(0).click()
    await page.keyboard.press("End")
    await remember(page)
    await page.keyboard.type("!!!", { delay: 20 })
    expect(await stillFocused(page)).toBe(true)
    expect(await inputs.evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))).toEqual([
      "Write tests!!!",
      "Ship",
      "Write tests",
    ])
  })
})

test.describe("remounts keep open sections and the height [review4 RENDER#4]", () => {
  test("an inline Accordion section stays open across a timeline remount, and the height holds while it settles", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("spec", { id: "stats", title: "Stats" }, [
        root("card"),
        element("card", "Card", { title: "Weekly" }, ["chart", "acc"]),
        element("chart", "Chart", {
          type: "bar",
          title: "Deploys",
          data: [
            { label: "Mon", value: 3 },
            { label: "Tue", value: 5 },
          ],
        }),
        element("acc", "Accordion", { items: [{ title: "Details", content: "One\n\nTwo\n\nThree\n\nFour" }] }),
      ]),
    )
    const surface = page.locator('[data-genui][data-surface="inline"]').first()
    await surface.locator('[data-gu="accordion"] summary').click()
    await expect(surface.locator('[data-gu="accordion"] details')).toHaveAttribute("open", "")
    const height = await surface.evaluate((node) => Math.round(node.getBoundingClientRect().height))

    await page.evaluate(() => window.__genui.virtualize(true))
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          window.__frames = []
          const sample = () => {
            const node = document.querySelector('[data-genui][data-surface="inline"]')
            window.__frames!.push(node ? String(Math.round(node.getBoundingClientRect().height)) : "none")
            if (window.__frames!.length < 20) requestAnimationFrame(sample)
            else resolve()
          }
          window.__genui.virtualize(false)
          requestAnimationFrame(sample)
        }),
    )
    // Before, the section closed on remount and the reservation lasted two frames, so the height dropped.
    await expect(surface.locator('[data-gu="accordion"] details')).toHaveAttribute("open", "")
    const frames = (await page.evaluate(() => window.__frames!)).filter((frame) => frame !== "none").map(Number)
    expect(Math.min(...frames)).toBeGreaterThanOrEqual(height - 1)
  })

  test("a Collapsible the user opened in a canvas is still open after switching tabs", async ({ page }) => {
    await boot(page)
    const canvas = (id: string, title: string) =>
      block("canvas", { canvas: id, title }, [
        root("main"),
        element("main", "Stack", {}, ["name", "more"]),
        element("name", "Input", { label: "Name" }),
        element("more", "Collapsible", { title: "Advanced" }, ["note"]),
        element("note", "Text", { text: "hidden details" }),
      ])
    await say(page, `A:\n\n${canvas("a", "Alpha")}\n\nB:\n\n${canvas("b", "Beta")}`)
    await page.getByRole("button", { name: "Open" }).first().click()
    const alpha = canvasView(page, "a")
    await alpha.locator('[data-gu="collapsible"] summary').click()
    await expect(alpha.locator('details[data-gu="collapsible"]')).toHaveAttribute("open", "")
    await page.getByRole("button", { name: "Open" }).nth(1).click()
    await expect(canvasView(page, "b")).toBeVisible()
    await page.locator('[data-playground-tab="genui:canvas.a"]').click()
    await expect(alpha.locator('details[data-gu="collapsible"]')).toHaveAttribute("open", "")
  })
})

test("the older copy of a re-sent block keeps what the user entered and sent [review4 USE#4]", async ({ page }) => {
  await boot(page)
  const form = (extra: string[], children: string[]) =>
    block("spec", { id: "create-service", title: "Create service" }, [
      root("card"),
      element("card", "Card", { title: "Create service" }, children),
      element("name", "Input", { label: "Name", value: { $bindState: "/form/name" } }),
      ...extra,
      state("/form", { name: "" }),
    ])
  await say(page, form([], ["name"]))
  const surfaces = page.locator('[data-genui][data-surface="inline"]')
  await surfaces.first().getByLabel("Name").fill("billing")
  await say(page, form([element("err", "Alert", { title: "Name taken", type: "error" })], ["err", "name"]))
  await expect(surfaces).toHaveCount(2)
  await expect(surfaces.nth(1).getByLabel("Name")).toHaveValue("billing")
  await surfaces.nth(1).getByLabel("Name").fill("billing-2")
  // Before, the older copy got an empty store of its own and showed the agent's original (blank) value.
  await expect(surfaces.nth(0).getByLabel("Name")).toHaveValue("billing")
  await expect(surfaces.nth(1).getByLabel("Name")).toHaveValue("billing-2")
})

test("a canvas patch that switches /root to an element the canvas has keeps the canvas and the user's edits [review4 USE#2]", async ({
  page,
}) => {
  await boot(page)
  await say(
    page,
    block("canvas", { canvas: "deploy", title: "Deploy" }, [
      root("running"),
      element("running", "Stack", {}, ["status", "note"]),
      element("status", "Text", { text: "Deploying…" }),
      element("note", "Input", { label: "Release note", value: { $bindState: "/note" } }),
      element("done", "Stack", {}, ["finished", "note"]),
      element("finished", "Text", { text: "Deployed." }),
      state("/note", ""),
    ]),
  )
  await openLatestCanvas(page)
  const canvas = canvasView(page, "deploy")
  await canvas.getByLabel("Release note").fill("ships the new billing flow")
  await say(page, block("canvas", { canvas: "deploy" }, [replace("/root", "done")]))
  // Before, the block counted as a whole new canvas: no elements, an error card, and the note was gone.
  await expect(canvas.getByText("Deployed.")).toBeVisible()
  await expect(canvas.getByLabel("Release note")).toHaveValue("ships the new billing flow")
  await expect(canvas.getByText("couldn't be shown")).toHaveCount(0)
})

test("the streaming clamp applies only to a block the app marks as still being written [review4 FIDELITY#4]", async ({
  page,
}) => {
  await boot(page)
  // The app's markup (session-ui markdown.tsx): the block's wrapper sits in a `display: contents` div that says whether
  // the block is complete. Built here, since the playground does not write that attribute.
  const clamp = await page.evaluate(() => {
    const body = Array.from({ length: 40 }, (_, index) => `{"op":"add","path":"/state/n${index}","value":${index}}`)
    const make = (complete: string, inside: boolean) => {
      const outer = document.createElement("div")
      if (inside) outer.setAttribute("data-genui", "")
      const holder = document.createElement("div")
      holder.setAttribute("data-markdown-block", "")
      holder.setAttribute("data-markdown-complete", complete)
      holder.style.display = "contents"
      const wrapper = document.createElement("div")
      wrapper.setAttribute("data-component", "markdown-code")
      wrapper.setAttribute("data-language", "spec")
      const pre = document.createElement("pre")
      pre.textContent = body.join("\n")
      wrapper.append(pre)
      holder.append(wrapper)
      outer.append(holder)
      document.body.append(outer)
      return pre
    }
    const shown = (pre: HTMLElement) => getComputedStyle(pre).maxHeight
    return {
      streaming: shown(make("false", false)),
      complete: shown(make("true", false)),
      insideGenui: shown(make("false", true)),
    }
  })
  expect(clamp).toEqual({ streaming: "128px", complete: "none", insideGenui: "none" })
})

test("narrow windows show the session's canvases in the panel's mobile view [review4 FIDELITY#6]", async ({ page }) => {
  await boot(page)
  await say(
    page,
    [
      block("canvas", { canvas: "plan", title: "Plan" }, [root("main"), element("main", "Text", { text: "The plan" })]),
      block("canvas", { canvas: "board", title: "Board" }, [
        root("main"),
        element("main", "Text", { text: "The board" }),
      ]),
    ].join("\n\n"),
  )
  // The playground only has the side placement: render the plugin's panel as the app's narrow screens do, with the
  // same module instances the plugin uses (Solid from the dev server's optimized deps, the SDK runtime's PanelContext).
  const result = await page.evaluate(async () => {
    const webUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /solid-js_web\.js/.test(name))!
    const web = (await import(webUrl)) as typeof import("solid-js/web")
    const { PanelContext } = (await import("/fake-sdk/internal.ts" as string)) as {
      PanelContext: import("solid-js").Context<unknown>
    }
    const sdk = (await import("/fake-sdk/index.ts" as string)) as typeof import("@opencode/plugin/gui")
    const app = window.__genui.host.app as unknown as {
      contributions: { items(registry: unknown): Array<{ plugin: string; value: unknown }> }
      sessions: { current(): unknown }
    }
    const item = app.contributions.items(sdk.Panel).find((entry) => entry.plugin === "genui")!
    const panel = (typeof item.value === "function" ? (item.value as () => unknown)() : item.value) as {
      mobile?: unknown
      render(props: unknown): import("solid-js").JSX.Element
    }
    const container = document.createElement("div")
    container.setAttribute("data-e2e-mobile", "")
    container.style.cssText = "position:fixed;inset:0;z-index:50;height:100vh"
    document.body.append(container)
    const frame = {
      visible: () => true,
      present: () => true,
      placement: () => "mobile",
      reserve: () => false,
      animate: () => true,
      sidebar: { opened: () => true, width: () => 240, transition: () => true, resize() {}, toggle() {} },
      open: () => [],
    }
    const session = app.sessions.current()
    web.render(
      () =>
        web.createComponent(PanelContext.Provider, {
          value: frame,
          get children() {
            return panel.render({ tab: { id: "canvas", title: "Canvas" }, session, screen: undefined })
          },
        }),
      container,
    )
    return { mobile: panel.mobile }
  })
  expect(result.mobile).toMatchObject({ kind: "menu", title: "Canvas" })
  const view = page.locator("[data-e2e-mobile]")
  // The canvas the agent updated last, with a picker for the other.
  await expect(view.getByText("The board")).toBeVisible()
  await expect(view.locator('[data-slot="picker"]')).toBeVisible()
  // Opening a canvas (the chip's Open, under the view here) shows it there.
  await page.getByRole("button", { name: "Open" }).first().dispatchEvent("click")
  await expect(view.getByText("The plan")).toBeVisible()
})
