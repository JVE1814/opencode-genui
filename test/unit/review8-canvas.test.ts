import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { EDITS_UNMATCHED } from "../../src/gui/issues.ts"
import { createSessionIndex, PARSE_CACHE_CHARS, type SessionIndex } from "../../src/runtime/session-index.ts"
import { MAX_HASHED_ITEMS, MAX_RECONCILE_WORK } from "../../src/runtime/state.ts"

// Regression tests for the eighth review's canvas findings ([review8#R7F2-<n>]). See test/e2e/review8-canvas.spec.ts for
// the tabs in the playground.

interface Message {
  id: string
  type: string
  content: Array<{ type: string; text?: string }>
  time: { created: number; completed?: number }
}

const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n")
const fence = (body: string) => `\`\`\`canvas\n${body}\n\`\`\``
const whole = (canvas: string, text: string) =>
  fence(
    lines(
      { canvas },
      { op: "add", path: "/root", value: "t" },
      { op: "add", path: "/elements/t", value: { type: "Text", props: { text }, children: [] } },
    ),
  )
const close = (canvas: string) => fence(lines({ canvas, close: true }))
const patch = (canvas: string, text: string) =>
  fence(lines({ canvas }, { op: "replace", path: "/elements/t/props/text", value: text }))

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

/** A session with one finished reply; `reply()` starts a live one, and `say` streams a delta into the newest. */
function session() {
  const [store, setStore] = createStore<{ messages: Message[] }>({
    messages: [
      {
        id: "msg_0001",
        type: "assistant",
        content: [{ type: "text", text: "hello" }],
        time: { created: 1, completed: 2 },
      },
    ],
  })
  let index!: SessionIndex
  createRoot((dispose) => {
    disposers.push(dispose)
    index = createSessionIndex({ messages: () => store.messages, snapshots: () => ({}) })
  })
  let next = 2
  const reply = () => {
    const id = `msg_${String(next++).padStart(4, "0")}`
    setStore("messages", (list) => [
      ...list,
      { id: `${id}u`, type: "user", content: [{ type: "text", text: "go" }], time: { created: 1 } },
      { id, type: "assistant", content: [{ type: "text", text: "" }], time: { created: 1 } },
    ])
  }
  const last = () => store.messages.length - 1
  const say = (text: string) => setStore("messages", last(), "content", 0, "text", (old) => `${old ?? ""}\n\n${text}`)
  const finish = () => setStore("messages", last(), "time", "completed", 3)
  /** What auto-open sees now: the fresh canvases, consumed (as setup.tsx's effect does). */
  const take = () => {
    const fresh = [...index.fresh()]
    for (const id of fresh) index.consumeFresh(id)
    return fresh
  }
  const withdraw = () => {
    const withdrawn = [...index.withdrawn()]
    for (const id of withdrawn) index.consumeWithdrawn(id)
    return withdrawn
  }
  return { index, reply, say, finish, take, withdraw }
}

describe("a canvas the agent closes and sends again whole is fresh again [review8#R7F2-1]", () => {
  test("in the reply that started it, in separate deltas: withdrawn, then fresh again", () => {
    // Before: the fresh memo retired the id once it dropped out, so the canvas sent again never got its tab back.
    const { reply, say, take, withdraw } = session()
    reply()
    say(whole("plan", "v1"))
    expect(take()).toEqual(["plan"])
    say(close("plan"))
    expect(take()).toEqual([])
    expect(withdraw()).toEqual(["plan"])
    say(whole("plan", "v2"))
    expect(take()).toEqual(["plan"])
    // Each start once: a patch, or a whole resend without a close, does not start it again.
    say(patch("plan", "v2 patched"))
    say(whole("plan", "v3"))
    expect(take()).toEqual([])
    // Closed again in the same reply: withdrawn again, so the tab opened for v2 closes too.
    say(close("plan"))
    expect(withdraw()).toEqual(["plan"])
    say(whole("plan", "v4"))
    expect(take()).toEqual(["plan"])
  })

  test("while nothing consumes it (a session not shown): the start sent again is fresh, the withdrawn one is not", () => {
    // Before: reported, never consumed, then retired by id when the close removed it, so v2 was never fresh either.
    const { index, reply, say, take } = session()
    reply()
    say(whole("plan", "v1"))
    expect(index.fresh()).toEqual(["plan"])
    say(close("plan"))
    expect(index.fresh()).toEqual([])
    say(whole("plan", "v2"))
    expect(take()).toEqual(["plan"])
  })

  test("closed and sent again in one delta: the new start is reported once", () => {
    const { reply, say, take, withdraw } = session()
    reply()
    say(whole("plan", "v1"))
    expect(take()).toEqual(["plan"])
    say(`${close("plan")}\n\n${whole("plan", "v2")}`)
    // Never gone, so not withdrawn: auto-open leaves the tab it opened as it is (see setup.tsx).
    expect(withdraw()).toEqual([])
    expect(take()).toEqual(["plan"])
    expect(take()).toEqual([])
  })

  test("across replies: a canvas withdrawn in one reply and sent in the next is fresh there", () => {
    const { reply, say, finish, take, withdraw } = session()
    reply()
    say(whole("plan", "v1"))
    expect(take()).toEqual(["plan"])
    say(close("plan"))
    expect(withdraw()).toEqual(["plan"])
    finish()
    reply()
    say(whole("plan", "v2"))
    expect(take()).toEqual(["plan"])
    finish()
    expect(take()).toEqual([])
    // Closed in a later reply than the one that started it: not withdrawn (its tab stays, struck through); sent again
    // in a later reply still, it starts again.
    reply()
    say(close("plan"))
    expect(withdraw()).toEqual([])
    finish()
    reply()
    say(whole("plan", "v3"))
    expect(take()).toEqual(["plan"])
  })

  test("several canvases each start again on their own", () => {
    const { reply, say, take, withdraw } = session()
    reply()
    say(`${whole("a", "a1")}\n\n${whole("b", "b1")}`)
    expect(take()).toEqual(["a", "b"])
    say(close("a"))
    expect(withdraw()).toEqual(["a"])
    say(whole("a", "a2"))
    say(close("b"))
    expect(take()).toEqual(["a"])
    expect(withdraw()).toEqual(["b"])
    say(whole("b", "b2"))
    expect(take()).toEqual(["b"])
  })

  test("a reply that opens and closes one canvas 500 times reports each start once, and nothing once it is over", () => {
    const { index, reply, say, finish, take, withdraw } = session()
    reply()
    for (let round = 0; round < 500; round++) {
      say(whole("plan", `v${round}`))
      expect(take()).toEqual(["plan"])
      say(close("plan"))
      expect(withdraw()).toEqual(["plan"])
    }
    say(whole("plan", "last"))
    finish()
    expect(index.fresh()).toEqual([])
    expect(index.withdrawn()).toEqual([])
  })
})

/** The heap after a full collection, in MB. */
function heapMB() {
  Bun.gc(true)
  return process.memoryUsage().heapUsed / 1e6
}

/** An index over a store that keeps only the newest `window` messages (so what stays is what the index keeps). */
function windowed(window: number) {
  const [store, setStore] = createStore<{ messages: Message[] }>({ messages: [] })
  let index!: SessionIndex
  createRoot((dispose) => {
    disposers.push(dispose)
    index = createSessionIndex({ messages: () => store.messages, snapshots: () => ({}), loaded: () => true })
  })
  const push = (message: Message) => setStore("messages", (list) => [...list.slice(1 - window), message])
  const write = (text: string) => setStore("messages", store.messages.length - 1, "content", 0, "text", text)
  return { index, push, write, setStore, store }
}

describe("what the session index keeps is bounded by its size, not by the session's history", () => {
  test("a canvas block of 100 KB streamed in 500 deltas leaves no partial body of each delta behind", () => {
    // Before: the parse cache kept the last 512 bodies whatever their size, so each delta's partial body stayed with
    // its parse: 173 MB in all for 1,000 deltas, 116 MB in the window (see test/e2e/review8-canvas.spec.ts).
    const { index, push, write, setStore, store } = windowed(4)
    const lines = [JSON.stringify({ canvas: "big" }), JSON.stringify({ op: "add", path: "/root", value: "list" })]
    const children: string[] = []
    for (let row = 0; lines.join("\n").length < 100_000; row++) {
      children.push(`r${row}`)
      lines.push(
        JSON.stringify({
          op: "add",
          path: `/elements/r${row}`,
          value: { type: "Text", props: { text: `row ${row} `.repeat(8) }, children: [] },
        }),
      )
    }
    lines.push(JSON.stringify({ op: "add", path: "/elements/list", value: { type: "Stack", props: {}, children } }))
    const text = `\`\`\`canvas\n${lines.join("\n")}\n\`\`\``
    const before = heapMB()
    push({ id: "msg_0001", type: "assistant", content: [{ type: "text", text: "" }], time: { created: 1 } })
    const step = Math.ceil(text.length / 500)
    for (let at = step; at < text.length + step; at += step) {
      write(text.slice(0, at))
      index.canvases()
    }
    setStore("messages", store.messages.length - 1, "time", "completed", 2)
    expect(Object.keys(index.canvas("big")?.spec?.elements ?? {})).toHaveLength(children.length + 1)
    // The parse cache holds PARSE_CACHE_CHARS characters of bodies; the canvas itself is about 100 KB.
    expect(heapMB() - before).toBeLessThan(PARSE_CACHE_CHARS / 1e6 + 25)
  })

  test("120 canvases of 200 KB, each closed in the next reply, leave nothing of theirs behind", () => {
    // Before: the settled snapshots the index recognizes when they come back from the store were kept for every
    // canvas that ever settled, each with its whole spec: 23 MB here, for as long as the session stays open.
    const { index, push } = windowed(4)
    const before = heapMB()
    for (let reply = 0; reply < 120; reply++) {
      const text = [
        reply > 0 ? close(`k${reply - 1}`) : "",
        whole(`k${reply}`, String.fromCharCode(97 + (reply % 26)).repeat(200_000) + reply),
      ].join("\n\n")
      push({
        id: `msg_${String(reply).padStart(4, "0")}`,
        type: "assistant",
        content: [{ type: "text", text }],
        time: { created: 1, completed: 2 },
      })
      index.canvases()
    }
    expect(index.canvasIds()).toEqual(["k119"])
    expect(heapMB() - before).toBeLessThan(10)
  })
})

describe("the issue for unmatched edits names both bounds that cut the lookups [review8#R7F2-5]", () => {
  test("200,000 list items hashed and 4,000,000 values visited", () => {
    // Before: it named only the 200,000 items, though the work bound cuts the lookups too (see Matcher in state.ts).
    expect(EDITS_UNMATCHED.message).toContain(MAX_HASHED_ITEMS.toLocaleString("en-US"))
    expect(EDITS_UNMATCHED.message).toContain(MAX_RECONCILE_WORK.toLocaleString("en-US"))
  })
})
