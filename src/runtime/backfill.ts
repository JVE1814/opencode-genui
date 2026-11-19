import type { MessageLike } from "./session-index.ts"

/** The part of `OpenCodeClient` that `backfill` uses; the real client fits it, and tests pass a fake. */
export interface MessageListClient {
  readonly message: {
    list(
      input: {
        readonly sessionID: string
        readonly limit?: number
        readonly order?: "asc" | "desc"
        readonly cursor?: string
        readonly type?: "assistant"
      },
      options?: { readonly signal?: AbortSignal },
    ): Promise<{ readonly data: readonly unknown[]; readonly cursor?: { readonly next?: string | null } }>
  }
}

export interface BackfillOptions {
  /** Called after each page with everything loaded so far, oldest first; true stops loading. */
  readonly until?: (messages: MessageLike[]) => boolean
  /** The most messages to load. Default 1000. */
  readonly max?: number
  readonly signal?: AbortSignal
}

const PAGE_SIZE = 100

const isMessageLike = (value: unknown): value is MessageLike =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as MessageLike).id === "string" &&
  typeof (value as MessageLike).type === "string"

/**
 * Loads the session's assistant messages from the newest back, page by page, for canvases whose base is older than the
 * client's window. Returns them oldest first. Never throws: on an error or an abort it returns what it has.
 *
 * The server keeps the order a cursor was created with and rejects `order` next to `cursor`, so only the first page
 * names the order; every page repeats the type filter, as the API asks.
 */
export async function backfill(
  client: MessageListClient,
  sessionID: string,
  options: BackfillOptions = {},
): Promise<MessageLike[]> {
  const max = Math.max(0, Math.floor(options.max ?? 1000))
  const { signal, until } = options
  const loaded: MessageLike[] = []
  const ids = new Set<string>()
  let cursor: string | undefined

  try {
    while (loaded.length < max && !signal?.aborted) {
      const limit = Math.min(PAGE_SIZE, max - loaded.length)
      const response = await client.message.list(
        cursor === undefined
          ? { sessionID, limit, order: "desc", type: "assistant" }
          : { sessionID, limit, cursor, type: "assistant" },
        signal ? { signal } : undefined,
      )
      if (signal?.aborted) break
      const data = Array.isArray(response?.data) ? response.data : []
      let added = 0
      for (const item of data) {
        if (!isMessageLike(item) || ids.has(item.id) || loaded.length >= max) continue
        ids.add(item.id)
        loaded.push(item)
        added++
      }
      if (until?.(loaded.toReversed())) break
      const next = response?.cursor?.next
      // A short page is the last; a page with nothing new means the cursor is not moving.
      if (data.length < limit || added === 0 || typeof next !== "string" || next === cursor) break
      cursor = next
    }
  } catch {
    // Return what was loaded.
  }
  return loaded.toReversed()
}
