import { messageId, type FakeServer, type Message } from "../host/server.ts"
import type { Scenario, Step } from "./types.ts"

export type Speed = "instant" | "fast" | "normal" | "slow"

const DELAY: Record<Speed, number> = { instant: 0, fast: 4, normal: 22, slow: 70 }
const PAUSE: Record<Speed, number> = { instant: 0, fast: 0.3, normal: 1, slow: 2 }
// Delta sizes cycle through these, so streams are reproducible and split lines (and fences) at varied points.
const CHUNKS = [7, 13, 4, 18, 9, 11, 3, 15, 6, 21]

export interface Runner {
  readonly speed: Speed
  /** Clears the session and plays the scenario's steps; a new run stops the previous one. */
  run(scenario: Scenario | undefined, sessionID: string): Promise<void>
  steps(steps: readonly Step[], sessionID: string, signal?: AbortSignal): Promise<void>
  /** Writes one assistant message, in deltas unless `stream` is false; completes it unless `complete` is false. */
  assistant(
    sessionID: string,
    text: string,
    options?: { readonly stream?: boolean; readonly complete?: boolean; readonly signal?: AbortSignal },
  ): Promise<string>
  stop(): void
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

/** Completed messages for steps that happened before the session opened (pauses are dropped). */
export function historyMessages(steps: readonly Step[]): Message[] {
  const start = Date.now() - steps.length * 60_000
  return steps.flatMap((step, index): Message[] => {
    const created = start + index * 60_000
    if ("user" in step) return [{ id: messageId(), type: "user", time: { created }, text: step.user }]
    if ("assistant" in step)
      return [
        {
          id: messageId(),
          type: "assistant",
          time: { created, completed: created + 1000 },
          agent: "build",
          model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
          content: [{ type: "text", text: step.assistant }],
          finish: "stop",
        },
      ]
    return []
  })
}

export function createRunner(server: FakeServer, speed: Speed): Runner {
  let current: AbortController | undefined

  const runner: Runner = {
    speed,
    async assistant(sessionID, text, options = {}) {
      const id = server.startAssistant(sessionID)
      const stream = options.stream ?? speed !== "instant"
      if (!stream) server.appendText(sessionID, id, text)
      else {
        let offset = 0
        let turn = 0
        while (offset < text.length) {
          const size = CHUNKS[turn++ % CHUNKS.length]!
          server.appendText(sessionID, id, text.slice(offset, offset + size))
          offset += size
          await sleep(Math.max(DELAY[speed], 1), options.signal)
        }
      }
      if (options.complete !== false) server.complete(sessionID, id)
      return id
    },
    async steps(steps, sessionID, signal) {
      for (const step of steps) {
        if (signal?.aborted) return
        if ("user" in step) server.appendUser(sessionID, step.user)
        else if ("assistant" in step)
          await runner.assistant(sessionID, step.assistant, { complete: step.complete, signal })
        else if (PAUSE[speed] > 0) await sleep(step.pause * PAUSE[speed], signal)
      }
    },
    async run(scenario, sessionID) {
      runner.stop()
      const controller = new AbortController()
      current = controller
      server.load(sessionID, scenario?.history ? historyMessages(scenario.history) : [])
      if (!scenario) return
      try {
        await runner.steps(scenario.steps, sessionID, controller.signal)
      } catch (error) {
        if (!controller.signal.aborted) throw error
      }
    },
    stop() {
      current?.abort(new Error("scenario stopped"))
      current = undefined
    },
  }
  return runner
}
