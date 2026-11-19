/** One step of a scripted conversation. */
export type Step =
  /** The user sends a message. */
  | { readonly user: string }
  /** The assistant writes a message, streamed in deltas; `complete: false` leaves it streaming. */
  | { readonly assistant: string; readonly complete?: boolean }
  /** Waits (skipped at `?speed=instant`). */
  | { readonly pause: number }

export interface Scenario {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly steps: readonly Step[]
  /**
   * Messages the session already has when it opens, loaded the way the app loads a stored session: the client's store
   * holds only the newest `?window=` (default 20). `steps` then play live after them.
   */
  readonly history?: readonly Step[]
  /** The assistant's scripted answer to a message the user (or a `sendPrompt` action) sends. */
  readonly reply?: (prompt: string) => readonly Step[] | undefined
}
