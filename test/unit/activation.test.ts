import { describe, expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client/promise"
import { createRoot, createSignal } from "solid-js"
import { createKeyed } from "@opencode/plugin/gui"
import {
  activationTarget,
  ensureInstructions,
  removeInstructions,
  sameActivation,
  type ActivationSession,
  type InstructionsClient,
} from "../../src/runtime/activation.ts"

// Compile-time check: the real client satisfies the structural type.
export const fits = (client: OpenCodeClient): InstructionsClient => client

function fakeClient(options: { failList?: boolean; failPut?: number; failRemove?: boolean } = {}) {
  const entries = new Map<string, Map<string, unknown>>()
  const calls: string[] = []
  let puts = 0
  const session = (id: string) => {
    let map = entries.get(id)
    if (!map) {
      map = new Map()
      entries.set(id, map)
    }
    return map
  }
  const client: InstructionsClient = {
    experimental: {
      session: {
        instructions: {
          entry: {
            async list({ sessionID }) {
              calls.push(`list ${sessionID}`)
              if (options.failList) throw new Error("list failed")
              return [...session(sessionID)].map(([key, value]) => ({ key, value }))
            },
            async put({ sessionID, key, value }) {
              calls.push(`put ${sessionID} ${key}`)
              puts++
              if (options.failPut !== undefined && puts <= options.failPut) throw new Error("put failed")
              session(sessionID).set(key, value)
            },
            async remove({ sessionID, key }) {
              calls.push(`remove ${sessionID} ${key}`)
              if (options.failRemove) throw new Error("remove failed")
              session(sessionID).delete(key)
            },
          },
        },
      },
    },
  }
  return { client, calls, session }
}

describe("ensureInstructions", () => {
  test("puts the entry once and remembers it for the window", async () => {
    const { client, calls, session } = fakeClient()
    expect(await ensureInstructions(client, "ses_1", "genui", "hint")).toBe("put")
    expect(session("ses_1").get("genui")).toBe("hint")
    expect(await ensureInstructions(client, "ses_1", "genui", "hint")).toBe("unchanged")
    expect(calls).toEqual(["list ses_1", "put ses_1 genui"])
  })

  test("skips the put when the server already has the same value", async () => {
    const { client, calls, session } = fakeClient()
    session("ses_1").set("genui", "hint")
    expect(await ensureInstructions(client, "ses_1", "genui", "hint")).toBe("unchanged")
    expect(calls).toEqual(["list ses_1"])
  })

  test("a different value is put again", async () => {
    const { client, session } = fakeClient()
    session("ses_1").set("genui", "old")
    expect(await ensureInstructions(client, "ses_1", "genui", "new")).toBe("put")
    expect(session("ses_1").get("genui")).toBe("new")
    expect(await ensureInstructions(client, "ses_1", "genui", "newer")).toBe("put")
  })

  test("concurrent mounts share one request", async () => {
    const { client, calls } = fakeClient()
    const results = await Promise.all([
      ensureInstructions(client, "ses_1", "genui", "hint"),
      ensureInstructions(client, "ses_1", "genui", "hint"),
    ])
    expect(results).toEqual(["put", "unchanged"])
    expect(calls).toEqual(["list ses_1", "put ses_1 genui"])
  })

  test("memoizes per client and per session", async () => {
    const first = fakeClient()
    const second = fakeClient()
    await ensureInstructions(first.client, "ses_1", "genui", "hint")
    expect(await ensureInstructions(second.client, "ses_1", "genui", "hint")).toBe("put")
    expect(await ensureInstructions(first.client, "ses_2", "genui", "hint")).toBe("put")
  })

  test("a failure is reported, not thrown, and a later call retries", async () => {
    const { client, calls } = fakeClient({ failPut: 1 })
    expect(await ensureInstructions(client, "ses_1", "genui", "hint")).toBe("failed")
    expect(await ensureInstructions(client, "ses_1", "genui", "hint")).toBe("put")
    expect(calls.filter((call) => call.startsWith("put"))).toHaveLength(2)
  })

  test("a failing list still puts", async () => {
    const { client, session } = fakeClient({ failList: true })
    expect(await ensureInstructions(client, "ses_1", "genui", "hint")).toBe("put")
    expect(session("ses_1").get("genui")).toBe("hint")
  })

  test("a client without the API fails quietly", async () => {
    expect(await ensureInstructions({} as InstructionsClient, "ses_1", "genui", "hint")).toBe("failed")
    expect(await ensureInstructions(null as unknown as InstructionsClient, "ses_1", "genui", "hint")).toBe("failed")
  })
})

describe("removeInstructions", () => {
  test("removes the entry and forgets the memo", async () => {
    const { client, calls, session } = fakeClient()
    await ensureInstructions(client, "ses_1", "genui", "hint")
    expect(await removeInstructions(client, "ses_1", "genui")).toBe(true)
    expect(session("ses_1").has("genui")).toBe(false)
    expect(await ensureInstructions(client, "ses_1", "genui", "hint")).toBe("put")
    expect(calls).toContain("remove ses_1 genui")
  })

  test("nothing to remove is a success without a remove call", async () => {
    const { client, calls } = fakeClient()
    expect(await removeInstructions(client, "ses_1", "genui")).toBe(true)
    expect(calls).toEqual(["list ses_1"])
  })

  test("a failure resolves false", async () => {
    const { client, session } = fakeClient({ failRemove: true })
    session("ses_1").set("genui", "hint")
    expect(await removeInstructions(client, "ses_1", "genui")).toBe(false)
    expect(await removeInstructions({} as InstructionsClient, "ses_1", "genui")).toBe(false)
  })
})

describe("activationTarget", () => {
  const sessionWith = (fields: {
    client: InstructionsClient
    connected?: boolean
    pending?: boolean
    info?: unknown
  }): ActivationSession => ({
    key: "srv\nses_1",
    id: "ses_1",
    pending: fields.pending ?? false,
    server: {
      client: fields.client,
      ...(fields.connected === undefined ? {} : { connected: fields.connected }),
      data: { session: { get: () => ("info" in fields ? fields.info : {}) } },
    },
  })

  test("only a created, top-level session on a connected server is a target", () => {
    const { client } = fakeClient()
    expect(activationTarget(undefined)).toBeUndefined()
    expect(activationTarget(sessionWith({ client, pending: true }))).toBeUndefined()
    expect(activationTarget(sessionWith({ client, connected: false }))).toBeUndefined()
    expect(activationTarget(sessionWith({ client, info: undefined }))).toBeUndefined()
    expect(activationTarget(sessionWith({ client, info: { parentID: "ses_0" } }))).toBeUndefined()
    expect(activationTarget(sessionWith({ client }))).toEqual({ key: "srv\nses_1", sessionID: "ses_1", client })
    expect(activationTarget(sessionWith({ client, connected: true }))?.client).toBe(client)
  })

  test("a failed put is retried on reconnect and on a restarted server's new client, once per client", async () => {
    const first = fakeClient({ failPut: 1 })
    const second = fakeClient()
    const [connected, setConnected] = createSignal(true)
    const [client, setClient] = createSignal(first.client)
    const [tick, setTick] = createSignal(0)
    const session = (): ActivationSession => ({
      key: "srv\nses_1",
      id: "ses_1",
      pending: false,
      server: {
        get client() {
          return client()
        },
        get connected() {
          return connected()
        },
        data: { session: { get: () => (tick(), {}) } },
      },
    })
    const results: string[] = []
    const dispose = createRoot((dispose) => {
      createKeyed(
        () => activationTarget(session()),
        (run) => void ensureInstructions(run.client, run.sessionID, "genui", "hint").then((r) => results.push(r)),
        { equals: sameActivation },
      )
      return dispose
    })
    await Bun.sleep(5)
    expect(results).toEqual(["failed"])
    // A data update with the same session and client is the same run.
    setTick(1)
    await Bun.sleep(5)
    expect(results).toEqual(["failed"])
    // The event connection drops and comes back: the put is tried again.
    setConnected(false)
    setConnected(true)
    await Bun.sleep(5)
    expect(results).toEqual(["failed", "put"])
    setConnected(false)
    setConnected(true)
    await Bun.sleep(5)
    // Already put through this client: no new request.
    expect(results).toEqual(["failed", "put", "unchanged"])
    expect(first.calls.filter((call) => call.startsWith("put"))).toHaveLength(2)
    // The server restarts with a new client: one more request, through it.
    setClient(second.client)
    await Bun.sleep(5)
    expect(results.at(-1)).toBe("put")
    expect(second.calls.filter((call) => call.startsWith("put"))).toHaveLength(1)
    dispose()
  })
})
