import { afterEach, describe, expect, test } from "bun:test"
import { catchError, createRoot, createSignal, getOwner, type Owner } from "solid-js"
import type { SessionRef } from "@opencode/plugin/gui"
import { contentId } from "../../src/protocol/digest.ts"
import { collide } from "../e2e/collide.ts"
import { parseBlock } from "../../src/protocol/surface.ts"
import {
  clearStoredSurfaces,
  flushOnAbort,
  flushSurfaceWrites,
  inlineSurfaceId,
  persistSurface,
  surfaceEntry,
  type SessionStore,
} from "../../src/gui/persist.ts"
import { createSessionRegistry } from "../../src/gui/sessions.ts"
import { clearSurfaces, getSurface, surfaceKey } from "../../src/runtime/surfaces.ts"
import {
  EMPTY_PERSISTED,
  readSurfaceOverrides,
  writeCanvasSnapshot,
  writeSurfaceOverrides,
  type PersistedSession,
} from "../../src/runtime/snapshot.ts"
import { UI_SECRET_ROOT } from "../../src/shared/constants.ts"

/** A session store with the app's semantics: undefined until it loads, writes before then wait, none after dispose. */
function fakeStore(initial: PersistedSession = EMPTY_PERSISTED, options: { loaded?: boolean } = {}) {
  const loaded = options.loaded ?? true
  const [value, setValue] = createSignal<PersistedSession | undefined>(loaded ? initial : undefined)
  const [ready, setReady] = createSignal(loaded)
  const queue: Array<(current: PersistedSession) => PersistedSession> = []
  let disposed = false
  let failValue = false
  const write = (apply: (current: PersistedSession) => PersistedSession) => {
    if (disposed) return
    if (!ready()) return void queue.push(apply)
    setValue(apply(value()!))
  }
  const store: SessionStore = {
    get value() {
      if (failValue) throw new Error("store read failed")
      return value()
    },
    ready,
    set: (next) => write(() => next),
    update: (mutate) =>
      write((current) => {
        const draft = structuredClone(current) as Parameters<typeof mutate>[0]
        mutate(draft)
        return draft
      }),
  }
  return {
    store,
    current: () => value(),
    load() {
      let current = initial
      for (const apply of queue.splice(0)) current = apply(current)
      setValue(current)
      setReady(true)
    },
    dispose: () => void (disposed = true),
    /** Makes the next read of `value` throw, and makes the store's value change so readers read it again. */
    breakReads() {
      failValue = true
      setValue({ ...value()! })
    },
  }
}

function fakeSession(key = "srv\nses_1"): { session: SessionRef; setMessages(list: unknown[]): void } {
  const [messages, setMessages] = createSignal<unknown[]>([])
  const id = key.split("\n")[1]!
  const session = {
    key,
    id,
    tab: "tab",
    pending: false,
    location: undefined,
    server: {
      id: "srv",
      connected: true,
      client: { message: { list: async () => ({ data: [] }) } },
      data: { session: { message: { list: () => messages() }, get: () => ({}) } },
    },
  } as unknown as SessionRef
  return { session, setMessages }
}

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  clearSurfaces()
})

/** A root with its own error handler, like the plugin root (setup runs in catchError) or the host's own memos. */
function errorRoot(): { owner: Owner | null; errors: unknown[]; run<T>(fn: () => T): T } {
  const errors: unknown[] = []
  let owner: Owner | null = null
  createRoot((dispose) => {
    disposers.push(dispose)
    catchError(
      () => {
        owner = getOwner()
      },
      (error) => errors.push(error),
    )
  })
  return {
    owner,
    errors,
    run: <T>(fn: () => T) => {
      let result!: T
      createRoot((dispose) => {
        disposers.push(dispose)
        catchError(
          () => {
            result = fn()
          },
          (error) => errors.push(error),
        )
      })
      return result
    },
  }
}

describe("createSessionRegistry", () => {
  test("a session root takes the setup owner's error handler, not that of whoever asked first", () => {
    const plugin = errorRoot()
    const host = errorRoot()
    const backing = fakeStore()
    const registry = createSessionRegistry(() => backing.store, { owner: plugin.owner })
    disposers.push(() => registry.dispose())
    const { session } = fakeSession()
    // The host's panel memo asks first.
    host.run(() => registry.get(session).index.ready())
    backing.breakReads()
    expect(plugin.errors).toHaveLength(1)
    expect(host.errors).toHaveLength(0)
  })

  test("without an owner, the error went to whichever computation created the session root", () => {
    const host = errorRoot()
    const backing = fakeStore()
    const registry = host.run(() => createSessionRegistry(() => backing.store))
    disposers.push(() => registry.dispose())
    host.run(() => registry.get(fakeSession().session))
    backing.breakReads()
    expect(host.errors).toHaveLength(1)
  })

  test("a store that never loads still lets the index load after the grace period, with no snapshots", async () => {
    const backing = fakeStore(EMPTY_PERSISTED, { loaded: false })
    const registry = createSessionRegistry(() => backing.store, { graceMs: 20 })
    disposers.push(() => registry.dispose())
    const entry = registry.get(fakeSession().session)
    expect(entry.index.ready()).toBe(false)
    await Bun.sleep(40)
    expect(entry.index.ready()).toBe(true)
    expect(entry.index.canvases()).toEqual([])
  })

  test("a loaded store with snapshots waits for messages, then for the grace period", async () => {
    const snapshot = {
      spec: { root: "main", elements: { main: { type: "Text", props: { text: "saved" }, children: [] } } },
      after: { messageID: "msg_01", part: 0, ordinal: 0 },
      generation: 1,
    }
    const backing = fakeStore(writeCanvasSnapshot(EMPTY_PERSISTED, "main", snapshot))
    const registry = createSessionRegistry(() => backing.store, { graceMs: 20 })
    disposers.push(() => registry.dispose())
    const entry = registry.get(fakeSession().session)
    expect(entry.index.ready()).toBe(false)
    await Bun.sleep(40)
    expect(entry.index.ready()).toBe(true)
    expect(entry.index.canvas("main")?.spec?.root).toBe("main")
  })
})

describe("persistence when the plugin goes away", () => {
  // The host's dispose order: abort the plugin's signal, release its cleanups (the session stores are disposed there),
  // then dispose its root (where onCleanup runs, and the CodeBlock and Panel renders unmount).
  function host(flushOn: "abort" | "cleanup") {
    const backing = fakeStore()
    const controller = new AbortController()
    const runtime = getSurface(surfaceKey("srv\nses_1", "inline", "trusted/form"))
    let disposeRoot!: () => void
    createRoot((dispose) => {
      disposeRoot = dispose
      persistSurface({ runtime: () => runtime, store: () => backing.store, entry: () => "inline/trusted/form" })
      if (flushOn === "abort") flushOnAbort(controller.signal, flushSurfaceWrites)
    })
    runtime.store.setBase({ name: "" })
    runtime.store.set("/name", "Ada")
    const dispose = () => {
      controller.abort()
      backing.dispose()
      if (flushOn === "cleanup") flushSurfaceWrites()
      disposeRoot()
    }
    return { backing, dispose }
  }

  test("pending edits are written when the signal aborts, before the stores are disposed", () => {
    const { backing, dispose } = host("abort")
    dispose()
    expect(
      readSurfaceOverrides(backing.current(), "inline/trusted/form").map(([path, value]) => [path, value]),
    ).toEqual([["/name", "Ada"]])
  })

  test("(a flush at cleanup time comes too late: the store is already disposed)", () => {
    const { backing, dispose } = host("cleanup")
    dispose()
    expect(readSurfaceOverrides(backing.current(), "inline/trusted/form")).toEqual([])
  })

  test("flushOnAbort does nothing for a signal already aborted, and its remover stops it", () => {
    let calls = 0
    const aborted = new AbortController()
    aborted.abort()
    flushOnAbort(aborted.signal, () => calls++)
    const controller = new AbortController()
    const remove = flushOnAbort(controller.signal, () => calls++)
    remove()
    controller.abort()
    expect(calls).toBe(0)
  })
})

describe("stored surfaces", () => {
  test("clearStoredSurfaces reaches a store that has not loaded yet", () => {
    const stored = writeSurfaceOverrides(EMPTY_PERSISTED, "inline/trusted/a", [["/a", 1]])
    const backing = fakeStore(stored, { loaded: false })
    clearStoredSurfaces(backing.store)
    expect(backing.current()).toBeUndefined()
    backing.load()
    expect(backing.current()?.surfaces).toEqual({})
  })

  test("loading drops stored edits the agent has overwritten since, and stored secrets, from the stored copy too", () => {
    const entry = "inline/trusted/form"
    const stored = writeSurfaceOverrides(EMPTY_PERSISTED, entry, [
      ["/name", "Ada", { b: "" }],
      ["/env", "prod", { b: "staging" }],
      [`/${UI_SECRET_ROOT}/pw`, "hunter2"],
    ])
    const backing = fakeStore(stored)
    const runtime = getSurface(surfaceKey("srv\nses_1", "inline", "trusted/form"))
    // The surface renders first: the agent's state now says env "eu".
    runtime.store.setBase({ name: "", env: "eu" })
    createRoot((dispose) => {
      disposers.push(dispose)
      persistSurface({ runtime: () => runtime, store: () => backing.store, entry: () => entry })
    })
    expect(runtime.store.getSnapshot()).toEqual({ name: "Ada", env: "eu" })
    expect(readSurfaceOverrides(backing.current(), entry)).toEqual([["/name", "Ada", { b: "" }]])
  })

  test("a password typed before the session store loads survives the load, and the stored edits load too", () => {
    const entry = "inline/trusted/db"
    const backing = fakeStore(writeSurfaceOverrides(EMPTY_PERSISTED, entry, [["/name", "Ada", { b: "" }]]), {
      loaded: false,
    })
    const runtime = getSurface(surfaceKey("srv\nses_1", "inline", "trusted/db"))
    runtime.store.setBase({ [UI_SECRET_ROOT]: { pw: "" }, name: "" })
    createRoot((dispose) => {
      disposers.push(dispose)
      persistSurface({ runtime: () => runtime, store: () => backing.store, entry: () => entry })
    })
    runtime.store.set(`/${UI_SECRET_ROOT}/pw`, "hunter2")
    backing.load()
    expect(runtime.store.get(`/${UI_SECRET_ROOT}/pw`)).toBe("hunter2")
    expect(runtime.store.get("/name")).toBe("Ada")
  })

  test("an untrusted block never shares the runtime or stored entry of the agent's block with the same header id", () => {
    const agent = parseBlock('{"id":"deploy"}\n{"op":"add","path":"/root","value":"a"}')
    const foreign = parseBlock('{"id":"deploy"}\n{"op":"add","path":"/root","value":"b"}')
    const resent = parseBlock('{"id":"deploy"}\n{"op":"add","path":"/root","value":"c"}')
    const trusted = inlineSurfaceId(agent, true, true)
    expect(trusted).toBe("trusted/deploy")
    // Re-sent by the agent: the newest copy shares the id's state, an older copy has its own.
    expect(inlineSurfaceId(resent, true, true)).toBe(trusted)
    expect(inlineSurfaceId(agent, true, false)).not.toBe(trusted)
    // Not the agent's: keyed by content, whatever its header says, and never under the trusted prefix.
    const untrusted = inlineSurfaceId(foreign, false, true)
    expect(untrusted).toBe(`untrusted/${contentId(foreign.text)}`)
    expect(inlineSurfaceId(agent, false, true)).not.toBe(trusted)
    expect(surfaceEntry("inline", untrusted)).not.toBe(surfaceEntry("inline", trusted))
    expect(surfaceKey("s", "inline", untrusted)).not.toBe(surfaceKey("s", "inline", trusted))
    // Blocks crafted to the same FNV hash still get stores of their own: the content key is a SHA-256 digest.
    const benignBody = '{"op":"add","path":"/root","value":"a"}'
    const benign = parseBlock(benignBody)
    const crafted = parseBlock(collide('{"op":"add","path":"/root","value":"b"}', benignBody))
    expect(crafted.hash).toBe(benign.hash)
    expect(inlineSurfaceId(crafted, false, true)).not.toBe(inlineSurfaceId(benign, false, true))
    expect(inlineSurfaceId(crafted, true, true)).not.toBe(inlineSurfaceId(benign, true, true))
    // An agent block without an id is keyed by its content.
    expect(inlineSurfaceId(parseBlock('{"op":"add","path":"/root","value":"a"}'), true, true)).toMatch(/^trusted\//)
  })
})
