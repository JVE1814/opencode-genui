import { unwrap } from "solid-js/store"
import type { PlaygroundHost } from "./host/index.tsx"
import type { Message } from "./host/server.ts"
import type { Runner } from "./scenarios/runner.ts"
import { findScenario } from "./scenarios/index.ts"

/**
 * Test hooks on `window.__genui`. The arrays are live records of what plugins did through the host; read them after
 * the action under test (Playwright: `page.evaluate(() => window.__genui.prompts)`).
 */
export interface GenuiHooks {
  /** How the plugin was loaded: `source`, `stub` or `bundle`, and the bundle's URL. */
  readonly mode: string
  readonly bundle?: string
  /** `client.session.prompt` calls (what `sendPrompt` sends): `{ sessionID, text, input }`. */
  readonly prompts: readonly { readonly sessionID: string; readonly text: string; readonly input: unknown }[]
  /** `client.session.switchModel` calls: `{ sessionID, model }`. */
  readonly modelSwitches: readonly { readonly sessionID: string; readonly model: unknown }[]
  /** `ctx.toast.show` options (action buttons as their labels). */
  readonly toasts: readonly unknown[]
  /** `ctx.dialogs.confirm` options with the answer given. */
  readonly confirms: readonly unknown[]
  readonly alerts: readonly unknown[]
  /** `ctx.system.copy` texts. */
  readonly copies: readonly string[]
  /** `ctx.system.openExternal` URLs (recorded, never opened). */
  readonly opened: readonly string[]
  readonly saves: readonly unknown[]
  readonly links: readonly unknown[]
  readonly notifications: readonly unknown[]
  /** Errors the host recorded for plugins (throwing renders, setup, list callbacks). */
  readonly errors: readonly { readonly plugin: string; readonly where: string; readonly message: string }[]
  /** Session instruction entries by session id, then key. */
  readonly instructions: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** Scripts `ctx.dialogs.confirm`: true or false answers at once; null (default) shows the dialog. */
  setConfirmAnswer(answer: boolean | null): void
  /** Clears the current session and plays a scenario; resolves when it has finished streaming. */
  runScenario(name: string): Promise<void>
  appendUser(text: string): string
  /** Writes an assistant message; streams in deltas with `stream: true`; `complete: false` leaves it streaming. */
  appendAssistant(text: string, options?: { stream?: boolean; complete?: boolean }): Promise<string>
  /** Appends a text delta to a streaming assistant message (default: the newest one). */
  appendText(delta: string, messageID?: string): void
  completeMessage(messageID?: string): void
  /** A plain copy of the current session's messages (all of them, not only the loaded window). */
  messages(): Message[]
  /** True unmounts every timeline row's content (rows scrolled off screen); false mounts them again. */
  virtualize(on: boolean): void
  /** Runs a published command (`${plugin}.${id}`) as the palette does. */
  runCommand(id: string): boolean
  /** The current session's side strip: keys, selection, preview, open. */
  layout(): unknown
  /** Routes another session by index (0 = Session A) or id. */
  routeSession(which: number | string): void
  composerText(): string
  /** Resolves when the host is mounted and the plugin has loaded (or failed to). */
  readonly ready: Promise<void>
  /** Resolves when the scenario from `?scenario=` has finished streaming. */
  readonly scenarioDone: Promise<void>
  readonly host: PlaygroundHost
}

declare global {
  interface Window {
    __genui: GenuiHooks
  }
}

export function installHooks(input: {
  readonly host: PlaygroundHost
  readonly runner: Runner
  readonly mode: string
  readonly bundle?: string
  readonly ready: Promise<void>
  readonly scenarioDone: Promise<void>
}): GenuiHooks {
  const { host, runner } = input
  const app = host.app
  const sessionID = () => app.sessions.current().id
  const hooks: GenuiHooks = {
    mode: input.mode,
    bundle: input.bundle,
    prompts: app.server.log.prompts,
    modelSwitches: app.server.log.modelSwitches,
    toasts: app.records.toasts,
    confirms: app.records.confirms,
    alerts: app.records.alerts,
    copies: app.records.copies,
    opened: app.records.opened,
    saves: app.records.saves,
    links: app.records.links,
    notifications: app.records.notifications,
    errors: app.records.errors,
    get instructions() {
      return app.server.log.instructions
    },
    setConfirmAnswer(answer) {
      app.dialogs.answer = answer
    },
    runScenario(name) {
      const scenario = findScenario(name)
      if (!scenario) return Promise.reject(new Error(`No scenario named ${name}`))
      return runner.run(scenario, sessionID())
    },
    appendUser: (text) => app.server.appendUser(sessionID(), text).id,
    appendAssistant: (text, options) => runner.assistant(sessionID(), text, { stream: false, ...options }),
    appendText(delta, messageID) {
      const id = messageID ?? app.server.streaming(sessionID())
      if (!id) throw new Error("appendText: no streaming assistant message")
      app.server.appendText(sessionID(), id, delta)
    },
    completeMessage: (messageID) => app.server.complete(sessionID(), messageID),
    messages: () => structuredClone(unwrap(app.server.messages(sessionID())) as Message[]),
    virtualize: (on) => app.setVirtualized(on),
    runCommand(id) {
      const context = Object.values(app.contexts())[0]
      return context ? context.commands.run(id) : false
    },
    layout: () => structuredClone(unwrap(app.layout.strip(app.sessions.current().key))),
    routeSession(which) {
      const session =
        typeof which === "number" ? app.sessions.all[which] : app.sessions.all.find((item) => item.ref.id === which)
      if (session) app.sessions.route(session.ref.key)
    },
    composerText: () => app.sessions.composer.text(app.sessions.current().key),
    ready: input.ready,
    scenarioDone: input.scenarioDone,
    host,
  }
  window.__genui = hooks
  return hooks
}
