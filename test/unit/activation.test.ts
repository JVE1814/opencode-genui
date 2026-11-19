import { describe, expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client/promise"
import { ensureInstructions, removeInstructions, type InstructionsClient } from "../../src/runtime/activation.ts"

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
