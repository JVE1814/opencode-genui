import { expect, test, type Page } from "@playwright/test"
import "../../playground/hooks.ts"
import { add, block, element, root } from "../../playground/scenarios/build.ts"

// Regression tests for the seventh review's rechecks ([R7S1-<n>], [R7F1-<n>]). Timing is measured as the page's own
// long tasks (PerformanceObserver "longtask"), with each message appended in a task of the page's own, as the server's
// would be. See test/unit/review7-fix.test.ts for the same below the renderer.

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

/** The longest task allowed where the code before took seconds: well under the 1 s target, with room for load. */
const BLOCKED_MS = 400

async function boot(page: Page) {
  await page.goto("/?scenario=empty&speed=instant&persist=0")
  await page.waitForFunction(() => !!window.__genui)
  await page.evaluate(() => window.__genui.ready)
  await page.evaluate(() => window.__genui.scenarioDone)
  await page.evaluate(() => window.__genui.appendUser("go"))
}

/** Records the page's long tasks from now on; `longestTask` reads the longest one so far. */
const recordLongTasks = (page: Page) =>
  page.evaluate(() => {
    const record = window as unknown as { __r7f: number[]; __r7fObserver?: PerformanceObserver }
    record.__r7fObserver?.disconnect()
    record.__r7f = []
    record.__r7fObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record.__r7f.push(entry.duration)
    })
    record.__r7fObserver.observe({ type: "longtask" })
  })
const longestTask = (page: Page) =>
  page.evaluate(() => {
    const record = window as unknown as { __r7f: number[]; __r7fObserver?: PerformanceObserver }
    for (const entry of record.__r7fObserver?.takeRecords() ?? []) record.__r7f.push(entry.duration)
    return Math.max(0, ...record.__r7f)
  })

/** Waits until no long task was recorded for `quiet` ms (longer than the 500 ms after which edits are saved). */
async function settle(page: Page, quiet = 1500) {
  let count = -1
  let since = Date.now()
  for (;;) {
    const now = await page.evaluate(() => (window as unknown as { __r7f: number[] }).__r7f.length)
    if (now !== count) {
      count = now
      since = Date.now()
    } else if (Date.now() - since >= quiet) return
    await page.waitForTimeout(100)
  }
}

/** Appends a completed assistant message with `text`, in a task of the page's own. */
const say = (page: Page, text: string) =>
  page.evaluate(
    (reply) =>
      new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          Promise.resolve(window.__genui.appendAssistant(reply)).then(() => resolve(), reject)
        }, 0),
      ),
    text,
  )

/** Appends a completed assistant message whose tool part returned `output` (untrusted), in a task of the page's own. */
const toolOutput = (page: Page, output: string) =>
  page.evaluate(
    (text) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const app = window.__genui.host.app
          const session = app.sessions.current()
          const id = app.server.startAssistant(session.id, [
            { type: "tool", id: `call_${Date.now()}`, name: "webfetch", state: { status: "completed", output: text } },
            { type: "text", text: "" },
          ])
          app.server.complete(session.id, id)
          resolve()
        }, 0),
      ),
    output,
  )

const untrusted = (page: Page) => page.locator('[data-playground-tool-output] [data-genui][data-surface="inline"]')

/**
 * One row holding a list `f` of 1,000 zeros and a list `pad` of `pad` zeros; a repeat over `f` whose rows' watch on
 * /all writes four fields below their entry: a select-all makes 4,000 edits below one row (of 26 KB for a pad of
 * 12,000).
 */
const selectAll = (pad: number): string[] => [
  add("/state", {
    all: false,
    rows: [{ f: Array.from({ length: 1000 }, () => 0), pad: Array.from({ length: pad }, () => 0), c: 0 }],
  }),
  root("card"),
  element("card", "Card", { title: "Rows" }, ["go", "list"]),
  element("go", "Button", { label: "Select all" }, [], {
    on: { press: [{ action: "setState", params: { statePath: "/all", value: true } }] },
  }),
  element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows/0/f" } }),
  element("row", "Text", { text: "." }, [], {
    watch: {
      "/all": ["v", "w", "x", "y"].map((field) => ({
        action: "setState",
        params: { statePath: { $item: field }, value: 1 },
      })),
    },
  }),
]

test.describe("what the user's edits cost does not grow with the size of their item [R7S1]", () => {
  test("after a select-all below one large row, an agent patch to the row stays short [R7S1-1]", async ({ page }) => {
    test.setTimeout(60_000)
    // Before: each of the 4,000 edits hashed and compared the whole row on the agent's patch (one task of 3.0 s here;
    // 21 s for 7,600 edits below a row of 85 KB).
    await boot(page)
    await say(page, block("canvas", { canvas: "r", title: "Rows" }, selectAll(12_000)))
    const canvas = page.locator('[data-genui][data-surface="canvas"]')
    await expect.poll(() => canvas.locator('[data-gu="text"]').count(), { timeout: 20_000 }).toBe(1000)
    await canvas.getByRole("button", { name: "Select all" }).click()
    await recordLongTasks(page)
    await settle(page)
    await page.evaluate(() => window.__genui.appendUser("again"))
    await recordLongTasks(page)
    await say(
      page,
      block("canvas", { canvas: "r" }, [JSON.stringify({ op: "replace", path: "/state/rows/0/c", value: 1 })]),
    )
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
  })

  test("saving the edits of a select-all below one large row stays short [R7S1-2]", async ({ page }) => {
    test.setTimeout(60_000)
    // Before: 500 ms after the click, saving checked and wrote out the whole row for each of the 4,000 edits (one task
    // of 1.6 s here, 74 KB; 3.6 s for 7,600 edits below a row of 85 KB), in an untrusted block.
    await boot(page)
    await toolOutput(page, `Here:\n\n${block("spec", undefined, selectAll(36_000))}\n`)
    const surface = untrusted(page)
    await expect.poll(() => surface.locator('[data-gu="text"]').count(), { timeout: 20_000 }).toBe(1000)
    await recordLongTasks(page)
    await surface.getByRole("button", { name: "Select all" }).click()
    await settle(page)
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })

  test("edits a bound leaves unmatched after the agent's change are reported [R7S1-1]", async ({ page }) => {
    test.setTimeout(60_000)
    // Each of 1,000 rows writes a field of its own, so each edit asks for a way of comparing the rows of its own; after
    // a row is inserted at the front, the lookups stop at 200,000 rows hashed, and the rest of the edits go.
    await boot(page)
    const rows = Array.from({ length: 1000 }, (_, index) => ({ id: index, f: {} }))
    await say(
      page,
      block("canvas", { canvas: "u", title: "Rows" }, [
        add("/state", { all: false, rows }),
        root("card"),
        element("card", "Card", { title: "Rows" }, ["go", "list"]),
        element("go", "Button", { label: "Select all" }, [], {
          on: { press: [{ action: "setState", params: { statePath: "/all", value: true } }] },
        }),
        element("list", "Stack", {}, ["row"], { repeat: { statePath: "/rows" } }),
        element("row", "Text", { text: "." }, [], {
          watch: {
            "/all": {
              action: "setState",
              params: { statePath: { $concat: ["/rows/", { $index: true }, "/f/k", { $index: true }] }, value: 1 },
            },
          },
        }),
      ]),
    )
    const canvas = page.locator('[data-genui][data-surface="canvas"]')
    await expect.poll(() => canvas.locator('[data-gu="text"]').count(), { timeout: 20_000 }).toBe(1000)
    await canvas.getByRole("button", { name: "Select all" }).click()
    await page.waitForTimeout(1000)
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
    await page.evaluate(() => window.__genui.appendUser("again"))
    await say(page, block("canvas", { canvas: "u" }, [add("/state/rows/0", { id: -1, f: {} })]))
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toContainText("were not matched to their items")
  })
})

/** The page's JS heap after a full garbage collection, in MB. */
async function heapMB(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  const { usedSize } = await cdp.send("Runtime.getHeapUsage")
  await cdp.detach()
  return usedSize / 1e6
}

test.describe("an element is charged its size for every instance, where the instance is built [R7S1-3]", () => {
  // One prop holding a list of 40,000 numbers and one expression: json-render resolves it into a list of its own for
  // each instance, and kept them all, before genui refused most instances.
  const data = [{ $state: "/a" }, ...Array.from({ length: 40_000 }, () => 0)]
  const shapes = {
    // Before: 4,000 entries of it (96 KB) kept 700 MB, in 15 s of long tasks.
    entries: [
      add("/state", { a: 1 }),
      root("s"),
      element(
        "s",
        "Stack",
        {},
        Array.from({ length: 4000 }, () => "w"),
      ),
      element("w", "Text", { text: "x", data }),
    ],
    // Before: 1,999 rows of it (84 KB) kept 360 MB.
    rows: [
      add("/state", { a: 1, rows: Array.from({ length: 1999 }, () => 0) }),
      root("s"),
      element("s", "Stack", {}, ["w"], { repeat: { statePath: "/rows" } }),
      element("w", "Text", { text: "x", data }),
    ],
  }
  for (const [name, lines] of Object.entries(shapes))
    test(`${name} of a large element keep no copy per instance`, async ({ page }) => {
      test.setTimeout(90_000)
      await boot(page)
      const before = await heapMB(page)
      await recordLongTasks(page)
      await toolOutput(page, `Here:\n\n${block("spec", undefined, lines)}\n`)
      await expect(untrusted(page).locator('[data-gu-chrome="issues"]')).toContainText("the UI is too large")
      await settle(page)
      expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
      expect((await heapMB(page)) - before).toBeLessThan(100)
    })
})

/** Streams `text` as one assistant message in `chunks` deltas, `every` ms apart, from tasks of the page's own. */
const stream = (page: Page, text: string, chunks: number, every = 50) =>
  page.evaluate(
    ([reply, parts, gap]) =>
      new Promise<void>((resolve) => {
        const app = window.__genui.host.app
        const session = app.sessions.current().id
        const id = app.server.startAssistant(session)
        const size = Math.ceil(reply.length / parts)
        let at = 0
        const step = () => {
          if (at < reply.length) {
            app.server.appendText(session, id, reply.slice(at, at + size))
            at += size
            setTimeout(step, gap)
          } else {
            app.server.complete(session, id)
            resolve()
          }
        }
        setTimeout(step, 0)
      }),
    [text, chunks, every] as const,
  )

/** The genui canvas tabs open in the side strip. */
const canvasTabs = (page: Page) =>
  page.evaluate(() => [...new Set(JSON.stringify(window.__genui.layout()).match(/canvas\.[a-z]\d+/g) ?? [])])

const opening = (id: string) =>
  block("canvas", { canvas: id }, [
    JSON.stringify({ root: "t", elements: { t: { type: "Text", props: { text: id }, children: [] } } }),
  ])
const closing = (id: string) => block("canvas", { canvas: id, close: true }, [])

test.describe("the tabs auto-open opens are bounded [R7S1-4]", () => {
  test("canvases a reply opens and closes again take their tabs with them", async ({ page }) => {
    test.setTimeout(90_000)
    // Before: 650 open/close pairs streamed in 1,300 deltas left 394 tabs, all for removed canvases, and the work of
    // each delta grew with them (87 s of long tasks). Here 120 pairs in 240 deltas left 120 tabs.
    await boot(page)
    const pairs = Array.from({ length: 120 }, (_, index) => `${opening(`c${index}`)}\n\n${closing(`c${index}`)}`)
    await recordLongTasks(page)
    await stream(page, pairs.join("\n\n"), 240)
    await settle(page)
    expect(await canvasTabs(page)).toEqual([])
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })

  test("at most 32 auto-opened tabs stay open in a session; a live canvas takes the place of a closed one", async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await boot(page)
    await stream(page, Array.from({ length: 32 }, (_, index) => opening(`d${index}`)).join("\n\n"), 64)
    await expect.poll(() => canvasTabs(page).then((tabs) => tabs.length)).toBe(32)
    // The next reply closes them (their tabs stay, struck through: the agent closed them after their reply) and opens
    // ten more: the strip keeps 32 auto-opened tabs. This expected the ten not to open, the strip holding only the 32
    // dead tabs [review8#R7F2-4]: now each new canvas takes the place of the oldest tab of a canvas the agent closed (at
    // most 32 canvases are live, so one of 32 tabs always holds a closed one).
    await page.evaluate(() => window.__genui.appendUser("next"))
    const next = [
      ...Array.from({ length: 32 }, (_, index) => closing(`d${index}`)),
      ...Array.from({ length: 10 }, (_, index) => opening(`e${index}`)),
    ]
    await recordLongTasks(page)
    await stream(page, next.join("\n\n"), 42)
    await settle(page)
    const tabs = await canvasTabs(page)
    expect(tabs).toHaveLength(32)
    expect(tabs.filter((tab) => tab.startsWith("canvas.e")).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `canvas.e${index}`).sort(),
    )
    expect(tabs.filter((tab) => /^canvas\.d[0-9]$/.test(tab))).toEqual([])
    await expect(page.locator('[data-genui][data-surface="canvas"]').getByText("e9", { exact: true })).toBeVisible()
    expect(await longestTask(page)).toBeLessThan(BLOCKED_MS)
  })
})

test.describe("Markdown is cut by paragraphs as marked lexes them [R7F1-1]", () => {
  test("release notes with a nested list and a table of 30 KB show whole", async ({ page }) => {
    // Before: a nested list (4-space indent) or a table counted as one paragraph, and was cut at 20,000 characters.
    await boot(page)
    const fix = (index: number) => `Fixed issue #${1000 + index}: the scheduler no longer drops jobs whose retry window`
    const notes = [
      "# Release notes",
      "- **Backend**",
      ...Array.from({ length: 250 }, (_, index) => `    - ${fix(index)}`),
      "",
      "| Package | Version | Notes |",
      "|---|---|---|",
      ...Array.from({ length: 250 }, (_, index) => `| package-${index} | ${index}.2.0 | ${fix(index)} |`),
      "",
      "FINAL LINE",
    ].join("\n")
    expect(notes.length).toBeGreaterThan(40_000)
    await say(
      page,
      block("canvas", { canvas: "doc", title: "Notes" }, [root("md"), element("md", "Markdown", { content: notes })]),
    )
    const canvas = page.locator('[data-genui][data-surface="canvas"]')
    await expect(canvas.getByText("FINAL LINE")).toBeVisible()
    await expect(canvas.locator("[data-gu-cut]")).toHaveCount(0)
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
  })
})

test.describe("the canvas cap judges each block where it is [R7F1-2]", () => {
  test("after a canvas closes, a patch to a refused canvas is refused too, and its resend leaves no false issue", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    // Before: the chip claimed "32 canvases are open" after one closed, the patch showed "Part of this canvas is
    // missing" with a rescan that could not help, and after the resend (once older messages were loaded again) the
    // newest canvas said a canvas was not opened.
    await boot(page)
    const whole = (index: number) =>
      block("canvas", { canvas: `task${index}`, title: `Task ${index}` }, [
        root("t"),
        element("t", "Text", { text: `body ${index}` }),
      ])
    for (let index = 1; index <= 33; index++) {
      await page.evaluate((task) => window.__genui.appendUser(`task ${task}`), index)
      await say(page, `Here is task ${index}:\n\n${whole(index)}\n`)
    }
    const chips = page.locator('[data-surface="chip"]')
    await expect(chips.filter({ hasText: "Task 33" })).toContainText("Not opened: 32 canvases were open")
    await page.evaluate(() => window.__genui.appendUser("close task 1"))
    await say(page, `Closed:\n\n${block("canvas", { canvas: "task1", close: true }, [])}\n`)
    await page.evaluate(() => window.__genui.appendUser("update task 33"))
    await say(
      page,
      `Update:\n\n${block("canvas", { canvas: "task33" }, [JSON.stringify({ op: "replace", path: "/elements/t/props/text", value: "updated" })])}\n`,
    )
    await expect(chips.last()).toContainText("Not opened: 32 canvases were open")
    await expect(chips.last().getByRole("button", { name: "Open" })).toHaveCount(0)
    await page.evaluate(() => window.__genui.appendUser("resend task 33"))
    await say(page, `Again:\n\n${whole(33)}\n`)
    await chips.last().getByRole("button", { name: "Open" }).click()
    const canvas = page.locator('[data-genui][data-surface="canvas"]')
    await expect(canvas.getByText("body 33")).toBeVisible()
    await expect(canvas.getByText("Part of this canvas is missing")).toHaveCount(0)
    await expect(canvas.locator('[data-gu-chrome="issues"]')).toHaveCount(0)
    await expect(chips.filter({ hasText: "Not opened" })).toHaveCount(0)
  })
})
