import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { SessionRef } from "@opencode/plugin/gui"
import type { SessionStore } from "../../src/gui/persist.ts"
import { createSessionRegistry, SNAPSHOT_SAVE_DELAY_MS, VERIFY_RETRY_MS } from "../../src/gui/sessions.ts"
import {
  EMPTY_PERSISTED,
  readCanvasSnapshots,
  writeCanvasSnapshot,
  writeSurfaceOverrides,
  type PersistedSession,
} from "../../src/runtime/snapshot.ts"
import type { CanvasSnapshot } from "../../src/protocol/fold.ts"

// The session layer drops what a committed revert removed, and the stored edits of canvas generations nobody shows
// any more [review4 RENDER#2, RENDER#6]. Drives the real registry with a store and a server that behave like the app's.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => sleep(SNAPSHOT_SAVE_DELAY_MS + 150)
const lines = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n")
const fence = (language: string, body: string) => "```" + language + "\n" + body + "\n```"

interface Message {
  readonly id: string
  readonly type: string
  readonly content: readonly { readonly type: string; readonly text: string }[]
  readonly time: { readonly created: number; readonly completed?: number }
}
const user = (id: string): Message => ({
  id,
  type: "user",
  content: [{ type: "text", text: "hi" }],
  time: { created: 1 },
})
const assistant = (id: string, text: string): Message => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: { created: 1, completed: 2 },
})

const create = (title: string) =>
  fence(
    "canvas",
    lines(
      { canvas: "plan", title: "Plan" },
      { op: "add", path: "/root", value: "main" },
      { op: "add", path: "/elements/main", value: { type: "Text", props: { text: title } } },
    ),
  )
const patch = fence(
  "canvas",
  lines(
    { canvas: "plan" },
    { op: "add", path: "/elements/extra", value: { type: "Text", props: { text: "reverted patch" } } },
    { op: "add", path: "/elements/main/children", value: ["extra"] },
  ),
)
const close = fence("canvas", lines({ canvas: "plan", close: true }))

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

function setup(
  history: Message[],
  initial: PersistedSession = EMPTY_PERSISTED,
  server: {
    /** Messages the server has besides the client's window (older ones the window has not loaded). */
    readonly older?: readonly Message[]
    /** How `session.message.get` fails for a message the server has not got. */
    readonly failure?: unknown
  } = {},
) {
  const [messages, setMessages] = createSignal<Message[]>(history)
  const [revert, setRevert] = createSignal<string | undefined>()
  let failure = server.failure
  const gets: string[] = []
  const lists: number[] = []
  const [value, setValue] = createSignal<PersistedSession | undefined>(initial)
  const store: SessionStore = {
    get value() {
      return value()
    },
    ready: () => true,
    set: (next) => setValue(next),
    update: (mutate) => {
      const draft = structuredClone(value()!) as Parameters<typeof mutate>[0]
      mutate(draft)
      setValue(draft)
    },
  }
  const session = {
    key: "srv\nses_1",
    id: "ses_1",
    tab: "tab",
    pending: false,
    location: undefined,
    server: {
      id: "srv",
      connected: true,
      // The server lists every message it still has: a staged revert keeps them until it is committed.
      client: {
        message: {
          list: async () => {
            lists.push(1)
            return {
              data: [...(server.older ?? []), ...messages()]
                .filter((message) => message.type === "assistant")
                .toReversed(),
              cursor: { next: null },
            }
          },
        },
        session: {
          message: {
            get: async (input: { sessionID: string; messageID: string }) => {
              gets.push(input.messageID)
              if (failure) throw failure
              const found = [...(server.older ?? []), ...messages()].find((message) => message.id === input.messageID)
              if (found) return found
              throw {
                _tag: "MessageNotFoundError",
                sessionID: input.sessionID,
                messageID: input.messageID,
                message: "Message not found",
              }
            },
          },
        },
      },
      data: {
        session: {
          message: { list: () => messages() },
          get: () => (revert() ? { revert: { messageID: revert() } } : {}),
        },
      },
    },
  } as unknown as SessionRef
  let registry!: ReturnType<typeof createSessionRegistry>
  createRoot((dispose) => {
    disposers.push(dispose)
    registry = createSessionRegistry(() => store, { graceMs: 50 })
  })
  disposers.push(() => registry.dispose())
  const entry = registry.get(session)
  return {
    entry,
    gets,
    lists,
    /** The server answers again. */
    heal: () => (failure = undefined),
    /** The app reconnects: the same session through a new server connection. */
    reconnect: () => registry.get({ ...session, server: { ...(session.server as object) } } as unknown as SessionRef),
    canvases: () =>
      entry.index.canvases().map((state) => `${state.id}:${Object.keys(state.spec?.elements ?? {}).join("+")}`),
    snapshots: () =>
      Object.entries(readCanvasSnapshots(value())).map(([id, snapshot]) => `${id}@${snapshot.after.messageID}`),
    surfaces: () => Object.keys(value()?.surfaces ?? {}).sort(),
    stage: (cut: string) => setRevert(cut),
    // As the app commits a revert (the user's next prompt): it clears the staged revert, then deletes the messages from
    // the revert point on; the new message comes after.
    commit: (cut: string, next: Message[]) => {
      setRevert(undefined)
      setMessages((list) => list.filter((message) => message.id < cut))
      setMessages((list) => [...list, ...next])
    },
    restore: () => setRevert(undefined),
    setMessages,
  }
}

describe("a committed revert stays reverted [review4 RENDER#2]", () => {
  test("a canvas created by the reverted reply, its snapshot and its stored edits stay gone", async () => {
    const edited = writeSurfaceOverrides(EMPTY_PERSISTED, "canvas/plan@1", [["/note", "typed", {}]])
    const run = setup([user("msg_01"), assistant("msg_02", create("the plan"))], edited)
    await settle()
    expect(run.canvases()).toEqual(["plan:main"])
    expect(run.snapshots()).toEqual(["plan@msg_02"])
    run.stage("msg_01")
    await settle()
    expect(run.canvases()).toEqual([])
    run.commit("msg_01", [user("msg_05")])
    await settle()
    // Before, the snapshot came back once the new message was newer than it, with the canvas and its edits.
    expect(run.canvases()).toEqual([])
    expect(run.snapshots()).toEqual([])
    expect(run.surfaces()).toEqual([])
    // A canvas of the same name made later starts clean.
    run.setMessages((list) => [...list, assistant("msg_06", create("a new plan"))])
    await settle()
    expect(run.canvases()).toEqual(["plan:main"])
    expect(run.surfaces()).toEqual([])
  })

  test("a patch from the reverted reply stays gone, also when a backfill loaded it while the revert was staged", async () => {
    const run = setup([
      user("msg_01"),
      assistant("msg_02", create("the plan")),
      user("msg_03"),
      assistant("msg_04", patch),
    ])
    await settle()
    expect(run.canvases()).toEqual(["plan:main+extra"])
    run.stage("msg_03")
    // (The staged revert makes the stored snapshot count as reverted, which starts a backfill from the server.)
    await settle()
    expect(run.canvases()).toEqual(["plan:main"])
    run.commit("msg_03", [user("msg_05")])
    await settle()
    expect(run.canvases()).toEqual(["plan:main"])
    expect(run.snapshots()).toEqual(["plan@msg_02"])
  })

  test("restoring the reverted messages brings their canvas back, snapshot and edits included", async () => {
    const edited = writeSurfaceOverrides(EMPTY_PERSISTED, "canvas/plan@1", [["/note", "typed", {}]])
    const run = setup([user("msg_01"), assistant("msg_02", create("the plan"))], edited)
    await settle()
    run.stage("msg_01")
    await settle()
    expect(run.canvases()).toEqual([])
    run.restore()
    await settle()
    expect(run.canvases()).toEqual(["plan:main"])
    expect(run.snapshots()).toEqual(["plan@msg_02"])
    expect(run.surfaces()).toEqual(["canvas/plan@1"])
  })

  test("a snapshot of a message that is gone from inside the loaded range is deleted (a revert committed elsewhere)", async () => {
    const snapshot: CanvasSnapshot = {
      title: "Plan",
      spec: { root: "main", elements: { main: { type: "Text", props: { text: "reverted" }, children: [] } } },
      after: { messageID: "msg_04", part: 0, ordinal: 0 },
      generation: 1,
    }
    const stored = writeSurfaceOverrides(writeCanvasSnapshot(EMPTY_PERSISTED, "plan", snapshot), "canvas/plan@1", [
      ["/note", "typed", {}],
    ])
    const run = setup([user("msg_01"), assistant("msg_02", "Hello."), user("msg_05")], stored)
    await settle()
    expect(run.canvases()).toEqual([])
    expect(run.snapshots()).toEqual([])
    expect(run.surfaces()).toEqual([])

    // An empty transcript says nothing: the snapshot stands.
    const empty = setup([], writeCanvasSnapshot(EMPTY_PERSISTED, "plan", snapshot))
    await settle()
    expect(empty.canvases()).toEqual(["plan:main"])
    expect(empty.snapshots()).toEqual(["plan@msg_04"])
  })
})

describe("a revert committed while no window had the session open [recheck#6]", () => {
  const snapshotAt = (messageID: string): CanvasSnapshot => ({
    title: "Plan",
    spec: { root: "main", elements: { main: { type: "Text", props: { text: "the plan" }, children: [] } } },
    after: { messageID, part: 0, ordinal: 0 },
    generation: 1,
  })
  const stored = (messageID: string) =>
    writeSurfaceOverrides(writeCanvasSnapshot(EMPTY_PERSISTED, "plan", snapshotAt(messageID)), "canvas/plan@1", [
      ["/note", "typed", {}],
    ])

  test("a canvas whose message is older than every loaded one stays gone when the server no longer has it", async () => {
    // The user reverted to the first message, and the next prompt committed it from elsewhere: only newer messages are
    // left, so the loaded ones cannot tell that msg_02 is gone.
    const run = setup([user("msg_05")], stored("msg_02"))
    await settle()
    // Before, the snapshot was older than the loaded range, so it was kept, and the reverted canvas came back.
    expect(run.canvases()).toEqual([])
    expect(run.snapshots()).toEqual([])
    expect(run.surfaces()).toEqual([])
  })

  test("a canvas from before the loaded messages stays when the server still has its message, or cannot be asked", async () => {
    const kept = setup([user("msg_10"), assistant("msg_11", "Hello.")], stored("msg_02"), {
      older: [user("msg_01"), assistant("msg_02", create("the plan"))],
    })
    await settle()
    expect(kept.canvases()).toEqual(["plan:main"])
    expect(kept.snapshots()).toEqual(["plan@msg_02"])
    expect(kept.surfaces()).toEqual(["canvas/plan@1"])

    const offline = setup([user("msg_05")], stored("msg_02"), { failure: new Error("connection lost") })
    await settle()
    expect(offline.canvases()).toEqual(["plan:main"])
    expect(offline.snapshots()).toEqual(["plan@msg_02"])
  })
})

describe("stored edits of canvas generations nobody shows go [review4 RENDER#6]", () => {
  test("a canvas replaced or closed while no view of it is open loses the stored edits of its old generations", async () => {
    const edited = writeSurfaceOverrides(EMPTY_PERSISTED, "canvas/plan@1", [["/note", "gen 1", {}]])
    const run = setup([user("msg_01"), assistant("msg_02", create("first"))], edited)
    await settle()
    expect(run.surfaces()).toEqual(["canvas/plan@1"])
    // Replaced: generation 2. No canvas view was mounted to reset the edits.
    run.setMessages((list) => [...list, user("msg_03"), assistant("msg_04", create("second"))])
    await settle()
    expect(run.surfaces()).toEqual([])

    // Edits of the current generation stay, and closing the canvas deletes them.
    const current = setup(
      [user("msg_01"), assistant("msg_02", create("first"))],
      writeSurfaceOverrides(
        writeSurfaceOverrides(EMPTY_PERSISTED, "canvas/plan@1", [["/note", "gen 1", {}]]),
        "canvas/other@3",
        [["/x", 1, {}]],
      ),
    )
    await settle()
    // (A canvas the index does not know keeps its edits: its messages may not be loaded.)
    expect(current.surfaces()).toEqual(["canvas/other@3", "canvas/plan@1"])
    current.setMessages((list) => [...list, user("msg_03"), assistant("msg_04", close)])
    await settle()
    expect(current.surfaces()).toEqual(["canvas/other@3"])
  })
})

describe("a canvas's base and its check, when they are not loaded [review5#F2, review5#F8]", () => {
  const createWithDone = fence(
    "canvas",
    lines(
      { canvas: "plan", title: "Plan" },
      { op: "add", path: "/root", value: "main" },
      { op: "add", path: "/elements/main", value: { type: "Text", props: { text: "running" } } },
      { op: "add", path: "/elements/done", value: { type: "Text", props: { text: "done view" } } },
    ),
  )
  const switchRoot = fence("canvas", lines({ canvas: "plan" }, { op: "replace", path: "/root", value: "done" }))

  test("a root switch whose canvas was created before the loaded messages loads them and keeps the canvas", async () => {
    // No snapshot is stored (cleared, another machine). Before, the switch counted as a whole new canvas: an empty
    // spec, saved as the canvas's snapshot, and the older messages were never loaded.
    const run = setup([user("msg_07"), assistant("msg_08", switchRoot)], EMPTY_PERSISTED, {
      older: [user("msg_01"), assistant("msg_02", createWithDone)],
    })
    await settle()
    await settle()
    expect(run.lists.length).toBeGreaterThan(0)
    expect(run.canvases()).toEqual(["plan:main+done"])
    expect(run.entry.index.canvas("plan")?.spec?.root).toBe("done")
    expect(run.snapshots()).toEqual(["plan@msg_08"])
  })

  test("a check that failed for a passing reason is asked again, later and when the connection changes", async () => {
    // msg_02 is gone from the server, but the first check fails offline: the canvas stays for now.
    const offline = setup(
      [user("msg_05")],
      (() =>
        writeCanvasSnapshot(EMPTY_PERSISTED, "plan", {
          spec: { root: "main", elements: { main: { type: "Text", props: { text: "the plan" }, children: [] } } },
          after: { messageID: "msg_02", part: 0, ordinal: 0 },
          generation: 1,
        }))(),
      { failure: new Error("connection lost") },
    )
    await settle()
    expect(offline.gets).toEqual(["msg_02"])
    expect(offline.canvases()).toEqual(["plan:main"])
    // Back online and reconnected: asked again at once, and the reverted canvas goes. Before, it was never asked again
    // while the session's entry lived.
    offline.heal()
    offline.reconnect()
    await settle()
    expect(offline.gets).toEqual(["msg_02", "msg_02"])
    expect(offline.canvases()).toEqual([])
    expect(offline.snapshots()).toEqual([])

    // Without a reconnect, after a while.
    const later = setup(
      [user("msg_05")],
      (() =>
        writeCanvasSnapshot(EMPTY_PERSISTED, "plan", {
          spec: { root: "main", elements: { main: { type: "Text", props: { text: "the plan" }, children: [] } } },
          after: { messageID: "msg_02", part: 0, ordinal: 0 },
          generation: 1,
        }))(),
      { failure: new Error("timeout") },
    )
    await settle()
    later.heal()
    await sleep(VERIFY_RETRY_MS[0]! + 100)
    await settle()
    expect(later.gets).toEqual(["msg_02", "msg_02"])
    expect(later.canvases()).toEqual([])
  })
})
