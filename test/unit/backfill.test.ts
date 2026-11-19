import { describe, expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client/promise"
import { backfill, type MessageListClient } from "../../src/runtime/backfill.ts"
import type { MessageLike } from "../../src/runtime/session-index.ts"

// Compile-time check: the real client satisfies the structural type.
export const fits = (client: OpenCodeClient): MessageListClient => client

type ListInput = Parameters<MessageListClient["message"]["list"]>[0]

const message = (index: number): MessageLike => ({
  id: `msg_${String(index).padStart(4, "0")}`,
  type: "assistant",
  content: [{ type: "text", text: `m${index}` }],
  time: { completed: 1 },
})

/** A fake server holding `count` assistant messages, paging newest first like the real one. */
function fakeClient(count: number, options: { failAt?: number; onCall?: (input: ListInput) => void } = {}) {
  const all = Array.from({ length: count }, (_, index) => message(index))
  const calls: ListInput[] = []
  const client: MessageListClient = {
    message: {
      async list(input) {
        calls.push(input)
        options.onCall?.(input)
        if (input.cursor !== undefined && input.order !== undefined)
          throw new Error("Cursor cannot be combined with order")
        if (options.failAt !== undefined && calls.length >= options.failAt) throw new Error("network")
        const ordered = all.toReversed()
        const start = input.cursor === undefined ? 0 : ordered.findIndex((item) => item.id === input.cursor) + 1
        const data = ordered.slice(start, start + (input.limit ?? 50))
        return { data, cursor: { next: data.at(-1)?.id ?? null, previous: data[0]?.id ?? null } }
      },
    },
  }
  return { client, calls }
}

describe("backfill", () => {
  test("loads every assistant message, oldest first", async () => {
    const { client, calls } = fakeClient(250)
    const result = await backfill(client, "ses_1")
    expect(result).toHaveLength(250)
    expect(result[0]!.id).toBe("msg_0000")
    expect(result.at(-1)!.id).toBe("msg_0249")
    expect(calls[0]).toEqual({ sessionID: "ses_1", limit: 100, order: "desc", type: "assistant" })
    expect(calls[1]).toEqual({ sessionID: "ses_1", limit: 100, cursor: "msg_0150", type: "assistant" })
    expect(calls).toHaveLength(3)
  })

  test("stops at max", async () => {
    const { client, calls } = fakeClient(500)
    const result = await backfill(client, "ses_1", { max: 150 })
    expect(result).toHaveLength(150)
    expect(result[0]!.id).toBe("msg_0350")
    expect(calls.map((call) => call.limit)).toEqual([100, 50])
  })

  test("stops when until is satisfied, passing everything so far oldest first", async () => {
    const { client, calls } = fakeClient(500)
    const seen: string[][] = []
    const result = await backfill(client, "ses_1", {
      until: (messages) => {
        seen.push([messages[0]!.id, messages.at(-1)!.id])
        return messages.some((item) => item.id === "msg_0350")
      },
    })
    expect(calls).toHaveLength(2)
    expect(result).toHaveLength(200)
    expect(seen[0]).toEqual(["msg_0400", "msg_0499"])
  })

  test("never throws and returns what it loaded", async () => {
    const { client } = fakeClient(500, { failAt: 2 })
    const result = await backfill(client, "ses_1")
    expect(result).toHaveLength(100)
    expect(result[0]!.id).toBe("msg_0400")

    const broken = { message: { list: () => Promise.reject(new Error("down")) } } as unknown as MessageListClient
    expect(await backfill(broken, "ses_1")).toEqual([])
    const nonsense = { message: { list: async () => ({ data: "x" }) } } as unknown as MessageListClient
    expect(await backfill(nonsense, "ses_1")).toEqual([])
  })

  test("an abort stops between pages", async () => {
    const controller = new AbortController()
    const { client, calls } = fakeClient(500, { onCall: () => calls.length === 2 && controller.abort() })
    const result = await backfill(client, "ses_1", { signal: controller.signal })
    expect(calls).toHaveLength(2)
    expect(result).toHaveLength(100)
  })

  test("a cursor that does not move ends the loop", async () => {
    let count = 0
    const client: MessageListClient = {
      message: {
        async list() {
          count++
          return { data: [message(1)], cursor: { next: "same" } }
        },
      },
    }
    const result = await backfill(client, "ses_1", { max: 1000 })
    expect(result.map((item) => item.id)).toEqual(["msg_0001"])
    expect(count).toBeLessThanOrEqual(2)
  })

  test("skips items that are not messages", async () => {
    const client: MessageListClient = {
      message: { list: async () => ({ data: [null, { id: 1 }, message(3), "x"], cursor: {} }) },
    }
    expect((await backfill(client, "ses_1")).map((item) => item.id)).toEqual(["msg_0003"])
  })
})
