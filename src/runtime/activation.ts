/** The part of `OpenCodeClient` that the session instruction entry uses; the real client fits it. */
export interface InstructionsClient {
  readonly experimental: {
    readonly session: {
      readonly instructions: {
        readonly entry: {
          list(input: {
            readonly sessionID: string
          }): Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>>
          put(input: { readonly sessionID: string; readonly key: string; readonly value: string }): Promise<unknown>
          remove(input: { readonly sessionID: string; readonly key: string }): Promise<unknown>
        }
      }
    }
  }
}

export type EnsureResult = "put" | "unchanged" | "failed"

interface Pending {
  readonly value: string
  readonly result: Promise<EnsureResult>
}

// Per client, per session and key: the value already put (or being put) in this window, so remounting a session does
// not ask the server again.
const memo = new WeakMap<object, Map<string, Pending>>()

const memoKey = (sessionID: string, key: string) => `${sessionID}\u0000${key}`

function entriesOf(client: InstructionsClient) {
  return client.experimental.session.instructions.entry
}

/**
 * Makes sure the session has the instruction entry `key` with exactly `value` (the short hint that tells the agent it
 * can render UI). Skips the write when the entry is already there; a value already ensured for this client, session
 * and key in this window returns "unchanged" without a request. A failure is forgotten, so a later call retries.
 * Never throws.
 */
export function ensureInstructions(
  client: InstructionsClient,
  sessionID: string,
  key: string,
  value: string,
): Promise<EnsureResult> {
  if (typeof client !== "object" || client === null) return Promise.resolve("failed")
  let sessions = memo.get(client)
  if (!sessions) {
    sessions = new Map()
    memo.set(client, sessions)
  }
  const id = memoKey(sessionID, key)
  const known = sessions.get(id)
  if (known && known.value === value)
    return known.result.then((result) => (result === "failed" ? "failed" : "unchanged"))

  const result = (async (): Promise<EnsureResult> => {
    try {
      const entries = await entriesOf(client).list({ sessionID })
      const entry = Array.isArray(entries) ? entries.find((item) => item?.key === key) : undefined
      if (entry && entry.value === value) return "unchanged"
    } catch {
      // Listing is only an optimization; the put below is idempotent.
    }
    try {
      await entriesOf(client).put({ sessionID, key, value })
      return "put"
    } catch {
      return "failed"
    }
  })()
  const pending: Pending = { value, result }
  sessions.set(id, pending)
  void result.then((outcome) => {
    if (outcome === "failed" && sessions.get(id) === pending) sessions.delete(id)
  })
  return result
}

/** Removes the session's instruction entry `key`, if it has one. Resolves false when that failed. Never throws. */
export async function removeInstructions(client: InstructionsClient, sessionID: string, key: string): Promise<boolean> {
  memo.get(client)?.delete(memoKey(sessionID, key))
  try {
    const entries = await entriesOf(client).list({ sessionID })
    if (Array.isArray(entries) && !entries.some((item) => item?.key === key)) return true
  } catch {
    // Try the removal anyway.
  }
  try {
    await entriesOf(client).remove({ sessionID, key })
    return true
  } catch {
    return false
  }
}
