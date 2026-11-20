import { batch } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client/promise"
import type { Data } from "@opencode/client/solid"
import type { ServerRef } from "@opencode/plugin/gui"
import { unimplemented } from "./stub.ts"

/** The assistant and user message shapes the fake server produces (subsets of the client's `SessionMessageInfo`). */
export interface UserMessage {
  readonly id: string
  readonly type: "user"
  readonly time: { readonly created: number }
  readonly text: string
}

export type AssistantPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool"
      readonly id: string
      readonly name: string
      /** `output` is what the tool returned; the timeline renders it as Markdown, as the app does for tool output. */
      readonly state: { readonly status: string; readonly output?: string }
    }

export interface AssistantMessage {
  readonly id: string
  readonly type: "assistant"
  readonly time: { readonly created: number; readonly completed?: number }
  readonly agent: string
  readonly model: { readonly id: string; readonly providerID: string }
  readonly content: readonly AssistantPart[]
  readonly finish?: "stop"
}

export type Message = UserMessage | AssistantMessage

interface SessionState {
  /** Every message the server has, oldest first. */
  history: Message[]
  /** The window the client's store holds (`data.session.message.list`): the latest ones, grown by `loadMore`. */
  loaded: Message[]
  status: "idle" | "running"
}

export interface PromptRecord {
  readonly sessionID: string
  readonly text: string
  readonly input: unknown
}

/** What the fake server records for tests (`window.__genui`). */
export interface ServerLog {
  readonly prompts: PromptRecord[]
  /** The session instruction entries, by session id, then key. */
  readonly instructions: Record<string, Record<string, unknown>>
  /** `client.session.switchModel` calls, in order. */
  readonly modelSwitches: { readonly sessionID: string; readonly model: SessionModel }[]
}

/** A session's model, as the session info holds it (the client's `ModelRef`). */
export interface SessionModel {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface FakeServer {
  readonly ref: ServerRef
  readonly log: ServerLog
  /** How many of the newest messages a session's store holds when it loads (the app keeps about 20). */
  readonly window: number
  ensure(sessionID: string): void
  /** Replaces a session's history, as loading a stored conversation does; the store holds the latest `window`. */
  load(sessionID: string, messages: readonly Message[]): void
  messages(sessionID: string): readonly Message[]
  appendUser(sessionID: string, text: string): UserMessage
  startAssistant(sessionID: string, parts?: readonly AssistantPart[]): string
  appendText(sessionID: string, messageID: string, delta: string): void
  complete(sessionID: string, messageID?: string): void
  /** The newest assistant message that has not completed. */
  streaming(sessionID: string): string | undefined
  /** Called after `client.session.prompt` stored the user message; the scenario runner answers through it. */
  onPrompt?: (record: PromptRecord) => void
  /** Called whenever messages change, so the playground can keep a copy across reloads. */
  onChange?: (sessionID: string) => void
}

// Message ids sort by time, as the server's ("msg_" + time-ordered hex): fixed-width hex of a monotonic counter.
let lastStamp = 0
export function messageId(): string {
  const stamp = Math.max(Date.now() * 1000, lastStamp + 1)
  lastStamp = stamp
  return `msg_${stamp.toString(16).padStart(14, "0")}${Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0")}`
}

/** Restores the id counter past ids loaded from storage, so new ids still sort after them. */
export function observeMessageId(id: string) {
  const hex = id.startsWith("msg_") ? id.slice(4, 18) : ""
  const stamp = Number.parseInt(hex, 16)
  if (Number.isFinite(stamp) && stamp > lastStamp) lastStamp = stamp
}

const MODEL = { id: "playground-model", providerID: "playground" }

export function createFakeServer(options: { readonly window?: number } = {}): FakeServer {
  const window = Math.max(1, options.window ?? 20)
  const [state, setState] = createStore<{ sessions: Record<string, SessionState> }>({ sessions: {} })
  const log: ServerLog = { prompts: [], instructions: {}, modelSwitches: [] }
  // Each session's model, as `switchModel` last set it (MODEL until then).
  const models: Record<string, SessionModel> = {}

  const ensure = (sessionID: string) => {
    if (state.sessions[sessionID]) return
    setState("sessions", sessionID, { history: [], loaded: [], status: "idle" })
  }

  const session = (sessionID: string) => {
    ensure(sessionID)
    return state.sessions[sessionID]!
  }

  const changed = (sessionID: string) => server.onChange?.(sessionID)

  const push = (sessionID: string, message: Message) => {
    ensure(sessionID)
    setState(
      "sessions",
      sessionID,
      produce((draft) => {
        draft.history.push(message)
        draft.loaded.push(message)
      }),
    )
  }

  const indexOf = (sessionID: string, messageID: string) =>
    session(sessionID).loaded.findIndex((message) => message.id === messageID)

  const snapshot = (message: Message): SessionMessageInfo =>
    structuredClone(unwrap(message)) as unknown as SessionMessageInfo

  const data = {
    session: {
      // The session's info, as the app's synced store holds it: top-level sessions (no parentID), no staged revert.
      get: (sessionID: string) =>
        state.sessions[sessionID]
          ? {
              id: sessionID,
              title: `Session ${sessionID}`,
              time: { created: 0 },
              model: { ...(models[sessionID] ?? MODEL) },
            }
          : undefined,
      status: (sessionID: string) => state.sessions[sessionID]?.status ?? "idle",
      setStatus: (sessionID: string, status: "idle" | "running") => setState("sessions", sessionID, "status", status),
      message: {
        list: (sessionID: string) => (state.sessions[sessionID]?.loaded ?? []) as unknown as SessionMessageInfo[],
        get: (sessionID: string, messageID: string) =>
          state.sessions[sessionID]?.loaded.find((message) => message.id === messageID) as
            | SessionMessageInfo
            | undefined,
        more: (sessionID: string) => {
          const current = state.sessions[sessionID]
          return !!current && current.loaded.length < current.history.length
        },
        loading: () => false,
        loadMore: async (sessionID: string, input?: { all?: boolean }) => {
          const current = session(sessionID)
          const missing = current.history.length - current.loaded.length
          if (missing <= 0) return
          const count = input?.all ? missing : Math.min(missing, window)
          const older = current.history.slice(missing - count, missing)
          setState("sessions", sessionID, "loaded", (loaded) => [...older, ...loaded])
        },
        sync: async () => {},
        invalidate: () => {},
        restoreFiles: async () => [],
      },
    },
  }

  const client = {
    session: {
      switchModel: async (input: { readonly sessionID: string; readonly model: SessionModel }) => {
        if (typeof input?.sessionID !== "string" || typeof input.model?.id !== "string")
          throw new Error("session.switchModel: sessionID and model are required")
        const model = { ...input.model }
        log.modelSwitches.push({ sessionID: input.sessionID, model })
        models[input.sessionID] = model
      },
      prompt: async (input: { readonly sessionID: string; readonly text: string }) => {
        if (typeof input?.sessionID !== "string" || typeof input.text !== "string")
          throw new Error("session.prompt: sessionID and text are required")
        const record: PromptRecord = { sessionID: input.sessionID, text: input.text, input: structuredClone(input) }
        log.prompts.push(record)
        const message = server.appendUser(input.sessionID, input.text)
        queueMicrotask(() => server.onPrompt?.(record))
        return {
          id: message.id,
          sessionID: input.sessionID,
          time: { created: message.time.created },
          type: "user",
          payload: { text: input.text },
          delivery: "queue",
        }
      },
      message: {
        get: async (input: { readonly sessionID: string; readonly messageID: string }) => {
          const found = session(input.sessionID).history.find((message) => message.id === input.messageID)
          // The server's error for a message it does not have (@opencode/client `MessageNotFoundError`).
          if (!found)
            throw {
              _tag: "MessageNotFoundError",
              sessionID: input.sessionID,
              messageID: input.messageID,
              message: `Message not found: ${input.messageID}`,
            }
          return snapshot(found)
        },
      },
    },
    message: {
      // Pages newest-first or oldest-first; the cursor is the id after which the next page starts. Like the server,
      // it rejects `order` together with `cursor`.
      list: async (input: {
        readonly sessionID: string
        readonly limit?: number
        readonly order?: "asc" | "desc"
        readonly cursor?: string
        readonly type?: string
      }) => {
        if (input.cursor !== undefined && input.order !== undefined)
          throw new Error("message.list: `order` is not allowed together with `cursor`")
        const limit = Math.max(1, Math.min(200, input.limit ?? 50))
        let order: "asc" | "desc" = input.order ?? "desc"
        let start = 0
        let all = session(input.sessionID).history.filter((message) => !input.type || message.type === input.type)
        if (input.cursor !== undefined) {
          const [direction, after] = decodeCursor(input.cursor)
          order = direction
          if (order === "desc") all = all.toReversed()
          start = all.findIndex((message) => message.id === after) + 1
        } else if (order === "desc") all = all.toReversed()
        const page = all.slice(start, start + limit)
        const last = page.at(-1)
        const more = start + limit < all.length
        return {
          data: page.map(snapshot),
          cursor: { next: more && last ? encodeCursor(order, last.id) : null, previous: null },
        }
      },
    },
    experimental: {
      session: {
        instructions: {
          entry: {
            list: async (input: { readonly sessionID: string }) =>
              Object.entries(log.instructions[input.sessionID] ?? {}).map(([key, value]) => ({ key, value })),
            put: async (input: { readonly sessionID: string; readonly key: string; readonly value: unknown }) => {
              log.instructions[input.sessionID] = { ...log.instructions[input.sessionID], [input.key]: input.value }
            },
            remove: async (input: { readonly sessionID: string; readonly key: string }) => {
              const entries = { ...log.instructions[input.sessionID] }
              delete entries[input.key]
              log.instructions[input.sessionID] = entries
            },
          },
        },
      },
    },
  }

  const ref: ServerRef = {
    id: "sidecar",
    name: "Local",
    url: "http://127.0.0.1:4096",
    password: undefined,
    client: unimplemented(client, "client") as unknown as OpenCodeClient,
    data: unimplemented(data, "data") as unknown as Data,
    local: true,
    builtin: true,
    compatible: true,
    connected: true,
  }

  const server: FakeServer = {
    ref,
    log,
    window,
    ensure,
    load(sessionID, messages) {
      ensure(sessionID)
      const copy = messages.map((message) => structuredClone(message))
      setState("sessions", sessionID, { history: copy, loaded: copy.slice(-window), status: "idle" })
      changed(sessionID)
    },
    messages: (sessionID) => session(sessionID).history,
    appendUser(sessionID, text) {
      const message: UserMessage = { id: messageId(), type: "user", time: { created: Date.now() }, text }
      push(sessionID, message)
      changed(sessionID)
      return message
    },
    startAssistant(sessionID, parts = [{ type: "text", text: "" }]) {
      const message: AssistantMessage = {
        id: messageId(),
        type: "assistant",
        time: { created: Date.now() },
        agent: "build",
        model: MODEL,
        content: parts.map((part) => ({ ...part })),
      }
      batch(() => {
        push(sessionID, message)
        setState("sessions", sessionID, "status", "running")
      })
      changed(sessionID)
      return message.id
    },
    appendText(sessionID, messageID, delta) {
      const index = indexOf(sessionID, messageID)
      if (index < 0) throw new Error(`appendText: no loaded message ${messageID}`)
      const message = session(sessionID).loaded[index] as AssistantMessage
      if (message.type !== "assistant") throw new Error("appendText: not an assistant message")
      // Text deltas apply to the last text part, as the app's store applies `text += delta`.
      let part = message.content.findLastIndex((item) => item.type === "text")
      if (part < 0 || part !== message.content.length - 1) {
        setState(
          "sessions",
          sessionID,
          "loaded",
          index,
          produce((draft) => {
            ;(draft as unknown as { content: AssistantPart[] }).content.push({ type: "text", text: "" })
          }),
        )
        part = (session(sessionID).loaded[index] as AssistantMessage).content.length - 1
      }
      setState(
        "sessions",
        sessionID,
        "loaded",
        index,
        "content" as never,
        part as never,
        "text" as never,
        ((text: string) => text + delta) as never,
      )
    },
    complete(sessionID, messageID = server.streaming(sessionID)) {
      if (!messageID) return
      const index = indexOf(sessionID, messageID)
      if (index < 0) return
      batch(() => {
        setState(
          "sessions",
          sessionID,
          "loaded",
          index,
          "time" as never,
          ((time: AssistantMessage["time"]) => ({
            ...time,
            completed: Date.now(),
          })) as never,
        )
        setState("sessions", sessionID, "loaded", index, "finish" as never, "stop" as never)
        if (!server.streaming(sessionID)) setState("sessions", sessionID, "status", "idle")
      })
      changed(sessionID)
    },
    streaming(sessionID) {
      const loaded = state.sessions[sessionID]?.loaded ?? []
      for (let index = loaded.length - 1; index >= 0; index--) {
        const message = loaded[index]!
        if (message.type === "assistant" && message.time.completed === undefined) return message.id
      }
      return undefined
    },
  }
  return server
}

const encodeCursor = (order: "asc" | "desc", id: string) => btoa(`${order}:${id}`)

function decodeCursor(cursor: string): ["asc" | "desc", string] {
  try {
    const [order, id] = atob(cursor).split(":")
    if ((order === "asc" || order === "desc") && id) return [order, id]
  } catch {
    // Reported below.
  }
  throw new Error("message.list: invalid cursor")
}
