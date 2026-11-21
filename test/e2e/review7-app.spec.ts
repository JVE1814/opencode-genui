import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { add, block, element, replace, root } from "../../playground/scenarios/build.ts"

// Regression tests for the seventh review's app findings: lists that components draw item by item (R6S3-2), long
// Markdown texts (R6F3-2), and a canvas whose base is in messages not loaded (R6F3-1).

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
  await page.evaluate(() => window.__genui.appendUser("go"))
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
      { type: "tool", id: `call_${Date.now()}`, name: "webfetch", state: { status: "completed", output: text } },
      { type: "text", text: "" },
    ])
    app.server.appendText(session.id, id, "Done.")
    app.server.complete(session.id, id)
  }, output)
}

/**
 * Runs `action`, waits `ms`, and returns the longest task the page ran meanwhile, as its PerformanceObserver reports
 * long tasks: what the page itself measured, so other test workers sharing the CPUs change it far less than a
 * wall-clock round trip.
 */
async function longestTask(page: Page, action: () => Promise<unknown>, ms = 2500): Promise<number> {
  await page.evaluate(() => {
    const record = window as unknown as { __longest: number; __observer?: PerformanceObserver }
    record.__longest = 0
    record.__observer?.disconnect()
    record.__observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record.__longest = Math.max(record.__longest, entry.duration)
    })
    record.__observer.observe({ type: "longtask" })
  })
  await action()
  await page.waitForTimeout(ms)
  return page.evaluate(() => {
    const record = window as unknown as { __longest: number; __observer: PerformanceObserver }
    // Entries of a task that just ended may not have reached the callback yet.
    for (const entry of record.__observer.takeRecords()) record.__longest = Math.max(record.__longest, entry.duration)
    return record.__longest
  })
}

const untrusted = (page: Page) => page.locator('[data-playground-tool-output] [data-genui][data-surface="inline"]')

/** The issues a surface lists in its footer. */
async function issueText(surface: ReturnType<Page["locator"]>): Promise<string> {
  const footer = surface.locator('[data-gu-chrome="issues"]')
  await expect(footer).toBeVisible()
  await footer.locator("summary").click()
  return (await footer.locator('[data-slot="body"]').textContent()) ?? ""
}

/**
 * The longest task a list's mount may take: the bounded mount measured 0 to 60 ms, the base tree 1.2 s (Radio) and
 * 2.8 to 3.5 s (Keybind).
 */
const MOUNT_MS = 300

test.describe("a component that draws a list item by item draws at most its maximum, and says so [R6S3-2]", () => {
  test("a 96 KB Keybind of 'a+a+…' from a tool mounts without a long task, shows 16 keys and reports the rest", async ({
    page,
  }) => {
    // 48,000 keys built 96,000 nodes in one element: the window froze for 3 to 3.5 s on mount, with no click.
    test.slow()
    await boot(page)
    const keys = Array.from({ length: 48_000 }, () => "a").join("+")
    const spec = block("spec", undefined, [
      root("card"),
      element("card", "Card", { title: "Keys" }, ["k"]),
      element("k", "Keybind", { keys }),
    ])
    expect(spec.length).toBeGreaterThan(96_000)
    const longest = await longestTask(page, () => toolOutput(page, `Here:\n\n${spec}\n`))
    expect(longest).toBeLessThan(MOUNT_MS)
    const surface = untrusted(page)
    await expect(surface.locator('[data-component="keybind-v2"] [data-slot="keybind-v2-key"]')).toHaveCount(16)
    await expect(surface.locator("[data-gu-cut]")).toHaveText("Showing 16 of 48,000 keys")
    expect(await issueText(surface)).toContain("shows only its first 16 of 48,000 keys: a Keybind shows at most 16")
  })

  test("a Radio of 10,000 options mounts without a long task, shows 200 and reports the rest", async ({ page }) => {
    // 79 KB: 60,000 nodes in one element, 1.2 s.
    test.slow()
    await boot(page)
    const options = Array.from({ length: 10_000 }, (_, index) => `o${index}`)
    const spec = block("spec", undefined, [
      root("card"),
      element("card", "Card", { title: "Pick" }, ["r"]),
      element("r", "Radio", { label: "Option", options }),
    ])
    const longest = await longestTask(page, () => toolOutput(page, `Here:\n\n${spec}\n`))
    expect(longest).toBeLessThan(MOUNT_MS)
    const surface = untrusted(page)
    await expect(surface.locator('input[type="radio"]')).toHaveCount(200)
    await expect(surface.locator("[data-gu-cut]")).toHaveText("Showing 200 of 10,000 options")
    expect(await issueText(surface)).toContain("shows only its first 200 of 10,000 options: a Radio shows at most 200")
    // What is drawn still works: picking an option.
    await surface.getByText("o199", { exact: true }).click()
    await expect(surface.locator('input[type="radio"]:checked')).toHaveCount(1)
  })

  test("ordinary lists show whole, with no note and no issue; a long Table and Chart say what they leave out", async ({
    page,
  }) => {
    await boot(page)
    await say(
      page,
      block("spec", undefined, [
        root("card"),
        element("card", "Card", { title: "Lists" }, ["k", "r", "s", "t", "g", "b", "a", "c"]),
        element("k", "Keybind", { keys: ["Mod", "Shift", "K"] }),
        element("r", "Radio", { label: "Size", options: ["S", "M", "L"] }),
        element("s", "Select", { label: "Env", options: ["dev", "prod"] }),
        element("t", "Tabs", { tabs: [{ label: "One", value: "1" }] }, ["p"]),
        element("p", "Text", { text: "panel" }),
        element("g", "ToggleGroup", { items: [{ label: "A", value: "a" }] }),
        element("b", "ButtonGroup", { buttons: [{ label: "X", value: "x" }] }),
        element("a", "Accordion", { items: [{ title: "Q", content: "**A**" }] }),
        element("c", "Carousel", { items: [{ title: "Card" }] }),
      ]),
    )
    const surface = page.locator('[data-genui][data-surface="inline"]').last()
    await expect(surface.locator('input[type="radio"]')).toHaveCount(3)
    await expect(surface.locator('[data-slot="keybind-v2-key"]')).toHaveCount(3)
    await expect(surface.getByRole("tab")).toHaveCount(1)
    await expect(surface.locator("[data-gu-cut]")).toHaveCount(0)
    await expect(surface.locator('[data-gu-chrome="issues"]')).toHaveCount(0)

    // A Table's cut was shown, but never reported to the agent.
    await say(
      page,
      block("spec", undefined, [
        root("t"),
        element("t", "Table", { columns: ["n"], rows: Array.from({ length: 600 }, (_, index) => [index]) }),
      ]),
    )
    const table = page.locator('[data-genui][data-surface="inline"]').last()
    await expect(table.locator("tbody tr")).toHaveCount(500)
    expect(await issueText(table)).toContain("shows 500 of its 600 rows and 1 of its 1 columns")
    // A Chart drew its first 500 labels and 6 series without a word.
    await say(
      page,
      block("spec", undefined, [
        root("c"),
        element("c", "Chart", {
          labels: Array.from({ length: 600 }, (_, index) => `l${index}`),
          series: Array.from({ length: 7 }, (_, index) => ({ name: `s${index}`, values: [1, 2, 3] })),
        }),
      ]),
    )
    const chart = page.locator('[data-genui][data-surface="inline"]').last()
    await expect(chart.locator("[data-gu-cut]")).toHaveText("Showing 500 of 600 labels and 6 of 7 series")
    expect(await issueText(chart)).toContain("draws 500 of its 600 labels and 6 of its 7 series")
  })
})

test.describe("a long Markdown text shows whole unless a paragraph is too long for the renderer [R6F3-2]", () => {
  test("a 100 KB document in a canvas shows all its sections, with no note and no issue", async ({ page }) => {
    // It was cut to its first 40,000 characters with a bare "…": 284 of its 704 sections showed, and nothing said so.
    await boot(page)
    let doc = ""
    for (let index = 1; doc.length < 100_000; index++)
      doc += `## Section ${index}\n\nThis section explains **step ${index}** of the rollout, with \`config_${index}.yaml\` and _notes_.\n\n- item one for ${index}\n- item two for ${index}\n\n`
    doc += "The end: FINAL LINE"
    const longest = await longestTask(page, () =>
      say(
        page,
        block("canvas", { canvas: "doc", title: "Design doc" }, [
          root("md"),
          element("md", "Markdown", { content: doc }),
        ]),
      ),
    )
    expect(longest).toBeLessThan(500)
    const canvas = page.locator('[data-gu-chrome="canvas"][data-canvas="doc"]')
    await expect(canvas.getByText("FINAL LINE")).toBeVisible()
    await expect(canvas.getByRole("heading", { name: "Section 704", exact: true })).toHaveCount(1)
    await expect(canvas.locator("[data-gu-cut]")).toHaveCount(0)
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
  })

  test("a paragraph past 20,000 characters cuts the text there, says so under it, and reports it", async ({ page }) => {
    await boot(page)
    const text = `Intro.\n\n${"a<b ".repeat(10_000)}\n\nAfter the long paragraph.`
    await toolOutput(
      page,
      `Here:\n\n${block("spec", undefined, [root("md"), element("md", "Markdown", { content: text })])}\n`,
    )
    const surface = untrusted(page)
    await expect(surface.locator("[data-gu-cut]")).toHaveText(
      `Showing the first 20,008 of ${text.length.toLocaleString("en-US")} characters`,
    )
    await expect(surface.getByText("After the long paragraph.")).toHaveCount(0)
    expect(await issueText(surface)).toContain(
      "a paragraph (or a list item, or a table row) runs past 20,000 characters there: split it into shorter ones",
    )
  })
})

/** Loads a session of `messages` (user and assistant texts, oldest first) into the playground's server. */
async function loadSession(page: Page, texts: readonly (readonly ["user" | "assistant", string])[]) {
  await page.evaluate((entries) => {
    const app = window.__genui.host.app
    const sessionID = app.sessions.current().id
    let time = Date.now() - 3_600_000
    let count = 0
    const id = () => `msg_hist_${String(++count).padStart(4, "0")}`
    const messages = entries.map(([role, text]) => {
      const created = (time += 60_000)
      return role === "user"
        ? { id: id(), type: "user", time: { created }, text }
        : {
            id: id(),
            type: "assistant",
            time: { created, completed: created + 1000 },
            agent: "build",
            model: { id: "m", providerID: "p" },
            content: [{ type: "text", text }],
            finish: "stop",
          }
    })
    app.server.load(sessionID, messages as never)
  }, texts)
}

const filler = Array.from({ length: 6 }, (_, index) => [
  ["user", `question ${index}`] as const,
  ["assistant", `answer ${index}`] as const,
]).flat()

const stored = (page: Page) =>
  page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.includes("plugin.genui.session"))
      .map((key) => sessionStorage.getItem(key) ?? "")
      .join("\n"),
  )

test.describe("a canvas whose base is in messages not loaded keeps looking for it while it renders [R6F3-1]", () => {
  test("an old canvas's view switch, then its switched-to element rewritten whole: the backfill finds the base", async ({
    page,
  }) => {
    // The window holds the 4 newest messages. The canvas rendered from the patches alone, without its title and state
    // ("deploy Success: Deployed"), and was saved so.
    await boot(page, "scenario=empty&speed=instant&persist=1&window=4")
    const base = block("canvas", { canvas: "deploy", title: "Deploy" }, [
      root("running"),
      element("running", "Card", { title: "Deploying" }),
      element("done", "Alert", { title: "Deployed", type: "success" }),
      add("/state/version", "v2.4"),
    ])
    const switched = block("canvas", { canvas: "deploy" }, [replace("/root", "done")])
    const rewritten = block("canvas", { canvas: "deploy" }, [
      replace("/elements/done", {
        type: "Alert",
        props: { title: { $template: "Deployed ${/version}" }, type: "success" },
        children: [],
      }),
    ])
    await loadSession(page, [
      ["user", "deploy"],
      ["assistant", `Deploying:\n\n${base}\n`],
      ...filler,
      ["user", "done?"],
      ["assistant", `Switching:\n\n${switched}\n`],
      ["user", "version?"],
      ["assistant", `With version:\n\n${rewritten}\n`],
    ])
    await page.locator('[data-gu-chrome="chip"]').last().getByRole("button", { name: "Open" }).click()
    const canvas = page.locator('[data-gu-chrome="canvas"][data-canvas="deploy"]')
    await expect(canvas).toContainText("Deployed v2.4")
    await expect(canvas).toContainText("Deploy")
    await expect.poll(() => stored(page)).toContain('\\"version\\":\\"v2.4\\"')
  })

  test("a new canvas started with a switch renders once its root element arrives, and is saved once the history is searched [review6#R9]", async ({
    page,
  }) => {
    await boot(page, "scenario=empty&speed=instant&persist=1&window=4")
    const started = block("canvas", { canvas: "fresh", title: "Fresh" }, [replace("/root", "main"), add("/state/x", 1)])
    const body = block("canvas", { canvas: "fresh" }, [element("main", "Text", { text: "hello fresh" })])
    await loadSession(page, [
      ...filler,
      ["user", "new?"],
      ["assistant", `New:\n\n${started}\n`],
      ["user", "more"],
      ["assistant", `Body:\n\n${body}\n`],
    ])
    await page.locator('[data-gu-chrome="chip"]').last().getByRole("button", { name: "Open" }).click()
    const canvas = page.locator('[data-gu-chrome="canvas"][data-canvas="fresh"]')
    await expect(canvas).toContainText("hello fresh")
    await expect(canvas).not.toContainText("Part of this canvas is missing")
    await expect.poll(() => stored(page)).toContain('\\"text\\":\\"hello fresh\\"')
  })
})
