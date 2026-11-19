import { afterEach, describe, expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { CanvasSnapshot } from "../../src/protocol/fold.ts"
import { parseBlock } from "../../src/protocol/surface.ts"
import { createSessionIndex, type MessageLike, type SessionIndex } from "../../src/runtime/session-index.ts"
import { readCanvasSnapshots, writeCanvasSnapshot } from "../../src/runtime/snapshot.ts"

interface Message {
  id: string
  type: string
  content: Array<{ type: string; text?: string }>
  time: { created: number; completed?: number }
}

const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n")
const fence = (language: string, body: string, closed = true) => `\`\`\`${language}\n${body}${closed ? "\n```" : ""}`
const root = (key = "main") => ({ op: "add", path: "/root", value: key })
const element = (key: string, text: string) => ({
  op: "add",
  path: `/elements/${key}`,
  value: { type: "Text", props: { text } },
})

const assistant = (id: string, text: string, completed = true): Message => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: completed ? { created: 1, completed: 2 } : { created: 1 },
})
const user = (id: string, text = "hello"): Message => ({
  id,
  type: "user",
  content: [{ type: "text", text }],
  time: { created: 1 },
})

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

function setup(
  messages: Message[],
  options: { snapshots?: Record<string, CanvasSnapshot>; loaded?: boolean; withLoaded?: boolean } = {},
) {
  const [store, setStore] = createStore<{ messages: Message[] }>({ messages })
  const [snapshots, setSnapshots] = createSignal<Readonly<Record<string, CanvasSnapshot>>>(options.snapshots ?? {})
  const [extra, setExtra] = createSignal<readonly MessageLike[]>([])
  const [revert, setRevert] = createSignal<string | undefined>()
  const [loaded, setLoaded] = createSignal(options.loaded ?? false)
  let index!: SessionIndex
  createRoot((dispose) => {
    disposers.push(dispose)
    index = createSessionIndex({
      messages: () => store.messages,
      snapshots,
      extra,
      revert,
      ...(options.withLoaded ? { loaded } : {}),
    })
  })
  const append = (position: number, delta: string) =>
    setStore("messages", position, "content", 0, "text", (text) => (text ?? "") + delta)
  const complete = (position: number) => setStore("messages", position, "time", "completed", 3)
  const push = (message: Message) => setStore("messages", (list) => [...list, message])
  return { index, store, setStore, append, complete, push, setSnapshots, setExtra, setRevert, setLoaded }
}

describe("createSessionIndex scanning", () => {
  test("reads canvas blocks from assistant text only and knows their hashes", () => {
    const canvasBody = lines({ canvas: "board", title: "Board" }, root(), element("main", "hi"))
    const specBody = lines(root(), element("main", "inline"))
    const userBody = lines({ canvas: "evil" }, root())
    const { index } = setup([
      user("msg_01", fence("canvas", userBody)),
      {
        ...assistant("msg_02", `Here:\n\n${fence("canvas", canvasBody)}\n\nand\n\n${fence("spec", specBody)}`),
        content: [
          { type: "reasoning", text: fence("canvas", lines({ canvas: "thought" }, root())) },
          { type: "tool", text: fence("canvas", lines({ canvas: "tool" }, root())) },
          { type: "text", text: `Here:\n\n${fence("canvas", canvasBody)}\n\nand\n\n${fence("spec", specBody)}` },
        ],
      },
    ])
    expect(index.ready()).toBe(true)
    expect(index.canvases().map((state) => state.id)).toEqual(["board"])
    const board = index.canvas("board")!
    expect(board.title).toBe("Board")
    expect(board.first).toEqual({ messageID: "msg_02", part: 2, ordinal: 0 })
    expect(index.knows(parseBlock(canvasBody).hash)).toBe(true)
    expect(index.knows(parseBlock(specBody).hash)).toBe(true)
    expect(index.knows(parseBlock(userBody).hash)).toBe(false)
    expect(index.canvas("evil")).toBeUndefined()
  })

  test("a spec block whose header names a canvas is a canvas block", () => {
    const { index } = setup([assistant("msg_01", fence("spec", lines({ canvas: "side" }, root())))])
    expect(index.canvases().map((state) => state.id)).toEqual(["side"])
  })

  test("a canvas block grows while it streams and other canvases keep their state object", () => {
    const { index, append, complete } = setup([
      assistant("msg_01", fence("canvas", lines({ canvas: "other" }, root(), element("main", "o")))),
      assistant("msg_02", "Drawing:\n```canvas\n", false),
    ])
    expect(index.canvases().map((state) => state.id)).toEqual(["other"])
    const other = index.canvas("other")!
    let otherRuns = 0
    let boardRuns = 0
    createRoot((dispose) => {
      disposers.push(dispose)
      createMemo(() => {
        index.canvas("other")
        otherRuns++
      })
      createMemo(() => {
        index.canvas("board")
        boardRuns++
      })
    })

    // The header line is still incomplete: no canvas yet, and certainly not the default one.
    append(1, '{"canvas":"bo')
    expect(index.canvas("main")).toBeUndefined()
    expect(index.canvases()).toHaveLength(1)

    append(1, `ard","title":"Board"}\n${JSON.stringify(root())}\n`)
    const started = index.canvas("board")!
    expect(started.streaming).toBe(true)
    expect(started.spec?.root).toBe("main")

    append(1, `${JSON.stringify(element("main", "one"))}\n{"op":"add","path":"/elements/two","value":{"type":"Te`)
    const grown = index.canvas("board")!
    expect(Object.keys(grown.spec!.elements)).toEqual(["main"])

    append(1, `xt","props":{"text":"2"}}}\n`)
    const more = index.canvas("board")!
    expect(Object.keys(more.spec!.elements)).toEqual(["main", "two"])
    expect(more.spec!.elements.main).toBe(grown.spec!.elements.main!)
    expect(more.settled).toBeUndefined()

    append(1, "```\nDone.")
    complete(1)
    const done = index.canvas("board")!
    expect(done.streaming).toBe(false)
    expect(done.spec).toBe(more.spec)
    expect(done.settled?.after).toEqual({ messageID: "msg_02", part: 0, ordinal: 0 })

    expect(index.canvas("other")).toBe(other)
    expect(otherRuns).toBe(1)
    expect(boardRuns).toBeGreaterThan(1)
    expect(index.canvases().map((state) => state.id)).toEqual(["other", "board"])
  })

  test("text outside canvas blocks does not produce new canvas states", () => {
    const { index, append } = setup([
      assistant("msg_01", fence("canvas", lines(root(), element("main", "a")))),
      assistant("msg_02", "Thinking", false),
    ])
    const before = index.canvas("main")
    const list = index.canvases()
    append(1, " more and more")
    append(1, "\n```ts\nconst x = 1\n```\n")
    expect(index.canvas("main")).toBe(before)
    expect(index.canvases()).toBe(list)
  })

  test("close reports the canvas removed", () => {
    const { index, push } = setup([assistant("msg_01", fence("canvas", lines({ canvas: "a" }, root())))])
    push(assistant("msg_02", fence("canvas", lines({ canvas: "a", close: true }))))
    expect(index.canvases()).toEqual([])
    expect([...index.removed()]).toEqual(["a"])
  })
})

describe("createSessionIndex snapshots", () => {
  const saved: CanvasSnapshot = {
    title: "Saved",
    spec: { root: "main", elements: { main: { type: "Text", props: { text: "saved" }, children: [] } } },
    after: { messageID: "msg_01", part: 0, ordinal: 0 },
    generation: 2,
  }

  test("folds newer blocks onto a snapshot whose message is out of the window", () => {
    const { index } = setup([user("msg_04"), assistant("msg_05", fence("canvas", lines(element("x", "new"))))], {
      snapshots: { main: saved },
    })
    const state = index.canvas("main")!
    expect(state.missingBase).toBe(false)
    expect(state.generation).toBe(2)
    expect(state.title).toBe("Saved")
    expect(Object.keys(state.spec!.elements)).toEqual(["main", "x"])
    expect(index.needsBackfill()).toBe(false)
  })

  test("a missing base asks for a backfill, and older messages supply it", () => {
    const { index, setExtra } = setup([
      user("msg_04"),
      assistant("msg_05", fence("canvas", lines(element("x", "new")))),
    ])
    expect(index.canvas("main")!.missingBase).toBe(true)
    expect(index.needsBackfill()).toBe(true)
    setExtra([
      assistant("msg_02", fence("canvas", lines(root(), element("main", "base")))),
      assistant("msg_05", "stale copy"),
    ])
    const state = index.canvas("main")!
    expect(state.missingBase).toBe(false)
    expect(Object.keys(state.spec!.elements)).toEqual(["main", "x"])
    expect(index.needsBackfill()).toBe(false)
  })

  test("a snapshot newer than the newest message (a revert) is ignored and asks for a backfill", () => {
    const reverted: CanvasSnapshot = { ...saved, after: { messageID: "msg_09", part: 0, ordinal: 0 } }
    const { index } = setup([assistant("msg_03", fence("canvas", lines(root("w"), element("w", "window"))))], {
      snapshots: { main: reverted },
    })
    expect(index.needsBackfill()).toBe(true)
    expect(index.canvas("main")!.spec?.root).toBe("w")
  })

  test("a staged revert hides later messages", () => {
    const { index, setRevert } = setup([
      assistant("msg_01", fence("canvas", lines(root(), element("main", "one")))),
      user("msg_02"),
      assistant("msg_03", fence("canvas", lines(element("later", "two")))),
    ])
    expect(Object.keys(index.canvas("main")!.spec!.elements)).toEqual(["main", "later"])
    setRevert("msg_02")
    expect(Object.keys(index.canvas("main")!.spec!.elements)).toEqual(["main"])
    setRevert(undefined)
    expect(Object.keys(index.canvas("main")!.spec!.elements)).toEqual(["main", "later"])
  })

  test("persisting and reading back a settled snapshot keeps the canvas state object", () => {
    const { index, setSnapshots, push } = setup([
      assistant("msg_01", fence("canvas", lines(root(), element("main", "one")))),
      assistant("msg_02", fence("canvas", lines(element("b", "two")))),
    ])
    const before = index.canvas("main")!
    const persisted = writeCanvasSnapshot(undefined, "main", before.settled)
    setSnapshots(readCanvasSnapshots(persisted))
    expect(index.canvas("main")).toBe(before)

    push(assistant("msg_03", fence("canvas", lines(element("c", "three")))))
    const after = index.canvas("main")!
    expect(after.spec!.elements.b).toBe(before.spec!.elements.b!)
    expect(after.first).toEqual(before.first)
  })

  test("a settled snapshot that comes back late still resumes without a rebuild", () => {
    const { index, setSnapshots, push } = setup([
      assistant("msg_01", fence("canvas", lines(root(), element("main", "one")))),
    ])
    const early = index.canvas("main")!.settled!
    push(assistant("msg_02", fence("canvas", lines(element("b", "two")))))
    const current = index.canvas("main")!
    expect(current.settled).not.toBe(early)

    setSnapshots(readCanvasSnapshots(writeCanvasSnapshot(undefined, "main", early)))
    expect(index.canvas("main")).toBe(current)
    setSnapshots(readCanvasSnapshots(writeCanvasSnapshot(undefined, "main", current.settled)))
    expect(index.canvas("main")).toBe(current)
  })

  test("a snapshot read again as a new object with the same position keeps the canvas state", () => {
    const { index, setSnapshots } = setup([assistant("msg_05", fence("canvas", lines(element("x", "new"))))], {
      snapshots: { main: saved },
    })
    const before = index.canvas("main")!
    setSnapshots({ main: JSON.parse(JSON.stringify(saved)) as CanvasSnapshot })
    expect(index.canvas("main")).toBe(before)
    setSnapshots({ main: { ...saved, after: { messageID: "msg_02", part: 0, ordinal: 0 } } })
    expect(index.canvas("main")).not.toBe(before)
  })

  test("a snapshot from elsewhere is used as a plain base", () => {
    const { index, setSnapshots } = setup([assistant("msg_05", fence("canvas", lines(element("x", "new"))))])
    expect(index.canvas("main")!.missingBase).toBe(true)
    setSnapshots({ main: { ...saved } })
    const state = index.canvas("main")!
    expect(state.missingBase).toBe(false)
    expect(Object.keys(state.spec!.elements)).toEqual(["main", "x"])
  })
})

describe("createSessionIndex fresh", () => {
  test("only canvases that start in a live message after loading are fresh, once each", () => {
    const { index, push, append, complete, setExtra } = setup([
      assistant("msg_01", fence("canvas", lines({ canvas: "old" }, root()))),
    ])
    expect(index.fresh()).toEqual([])

    push(user("msg_02"))
    push(assistant("msg_03", fence("canvas", lines({ canvas: "live" }, root()), false), false))
    expect(index.fresh()).toEqual(["live"])
    index.consumeFresh("live")
    expect(index.fresh()).toEqual([])

    append(1, `\n\`\`\`\n${fence("canvas", lines({ canvas: "second" }, root()))}`)
    // position 1 is msg_02 (user); the live message is at 2
    expect(index.fresh()).toEqual([])
    append(2, `\n\`\`\`\n${fence("canvas", lines({ canvas: "second" }, root()))}`)
    expect(index.fresh()).toEqual(["second"])

    complete(2)
    expect(index.fresh()).toEqual([])

    // A later live message that closes and recreates it does not report it again.
    push(
      assistant(
        "msg_04",
        `${fence("canvas", lines({ canvas: "second", close: true }))}\n${fence("canvas", lines({ canvas: "second" }, root()))}`,
        false,
      ),
    )
    expect(index.fresh()).toEqual([])

    // History never produces fresh canvases.
    setExtra([assistant("msg_00", fence("canvas", lines({ canvas: "ancient" }, root())))])
    expect(index.canvas("ancient")).toBeDefined()
    expect(index.fresh()).toEqual([])
  })

  test("a canvas already streaming when the session loads is not fresh", () => {
    const { index } = setup([assistant("msg_05", fence("canvas", lines({ canvas: "c" }, root()), false), false)])
    expect(index.canvas("c")?.streaming).toBe(true)
    expect(index.fresh()).toEqual([])
  })

  test("nothing is fresh or ready before the window loads; an empty loaded session counts every reply as live", () => {
    const { index, push, setLoaded } = setup([], { withLoaded: true })
    expect(index.ready()).toBe(false)
    expect(index.needsBackfill()).toBe(false)
    setLoaded(true)
    expect(index.ready()).toBe(true)
    push(user("msg_01"))
    push(assistant("msg_02", fence("canvas", lines({ canvas: "first" }, root()), false), false))
    expect(index.fresh()).toEqual(["first"])
  })

  test("by default the index is ready once messages arrive", () => {
    const { index, setStore } = setup([])
    expect(index.ready()).toBe(false)
    setStore("messages", [assistant("msg_01", "hi")])
    expect(index.ready()).toBe(true)
    setStore("messages", [])
    expect(index.ready()).toBe(true)
  })
})
