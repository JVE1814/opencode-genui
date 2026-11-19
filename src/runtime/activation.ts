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

/** The parts of a `SessionRef` activation reads. */
export interface ActivationSession {
  readonly key: string
  readonly id: string
  readonly pending: boolean
  readonly server: {
    readonly client: unknown
    /** The event connection is up; undefined (an older host) counts as connected. */
    readonly connected?: boolean
    readonly data: { readonly session: { get(id: string): unknown } }
  }
}

/** A session to activate, with the client of its server at that moment. */
export interface ActivationTarget {
  readonly key: string
  readonly sessionID: string
  readonly client: InstructionsClient
}

/**
 * The session activation should run for: a created, top-level session (a subagent's session gets nothing, its parent
 * already has the hint) on a connected server, with that server's current client. Undefined while there is none, or
 * while the session's info has not arrived. Read it reactively: a reconnect, or a restarted server's new client, gives
 * a new target (see `sameActivation`), so a failed put is retried, and `ensureInstructions` keeps it to one request per
 * client and session.
 */
export function activationTarget(session: ActivationSession | undefined): ActivationTarget | undefined {
  if (!session || session.pending || session.server.connected === false) return undefined
  let info: { readonly parentID?: unknown } | undefined
  try {
    info = session.server.data.session.get(session.id) as { readonly parentID?: unknown } | undefined
  } catch {
    // A data store without session info (an older host): treat it as a top-level session.
    info = {}
  }
  if (!info || info.parentID) return undefined
  return { key: session.key, sessionID: session.id, client: session.server.client as InstructionsClient }
}

/** Whether two targets are the same run: the same session through the same client. */
export const sameActivation = (a: ActivationTarget, b: ActivationTarget) => a.key === b.key && a.client === b.client

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
