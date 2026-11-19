import { createSignal, For, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/gui"
import { PLUGIN_ID } from "../src/shared/constants.ts"
import { installHooks } from "./hooks.ts"
import { createHost } from "./host/index.tsx"
import { loadBundle } from "./host/loader.ts"
import { observeMessageId, type Message } from "./host/server.ts"
import { findScenario, scenarios } from "./scenarios/index.ts"
import { createRunner, type Speed } from "./scenarios/runner.ts"
import "./styles.css"

/*
 * Query parameters:
 *   scenario=<name>        conversation to play (empty, form, canvas, invalid, gallery, history)
 *   speed=instant|fast|normal|slow
 *   theme=dark             start in dark mode
 *   plugin=stub            load the stub plugin instead of src/gui.tsx
 *   bundle=1 | bundle=stub load the BUILT bundle (dist/gui-experimental.cjs, or the stub's) through a require shim
 *   options=<json>         plugin options, as in opencode.json
 *   window=<n>             messages the session store holds (default 20)
 *   persist=0              do not keep storage and the transcript across reloads
 */
const params = new URLSearchParams(location.search)
const speed: Speed = (["instant", "fast", "normal", "slow"] as const).find((s) => s === params.get("speed")) ?? "normal"
const persist = params.get("persist") !== "0"
const bundle = params.get("bundle")
const mode = bundle ? "bundle" : params.get("plugin") === "stub" ? "stub" : "source"
const bundleUrl = bundle === "stub" ? "/__genui/stub-bundle.cjs" : bundle ? "/dist/gui-experimental.cjs" : undefined
const initialScenario = findScenario(params.get("scenario") ?? "empty") ?? findScenario("empty")!

let options: Record<string, never> = {}
try {
  options = JSON.parse(params.get("options") ?? "{}") as Record<string, never>
} catch {
  console.warn("[playground] ?options is not JSON; using {}")
}

const host = createHost({
  app: {
    persist,
    window: Math.max(1, Number(params.get("window")) || 20),
    locale: params.get("locale") ?? "en",
    mode: params.get("theme") === "dark" ? "dark" : "light",
  },
})
const app = host.app
const runner = createRunner(app.server, speed)
const [scenario, setScenario] = createSignal(initialScenario.name)
const [notice, setNotice] = createSignal<string>()

// The transcript survives a page reload like the app's server-side history does (see README).
const TRANSCRIPT = "transcript"
interface Transcript {
  readonly scenario: string
  readonly sessions: Record<string, Message[]>
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
app.server.onChange = () => {
  if (!persist) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const sessions: Record<string, Message[]> = {}
    for (const session of app.sessions.all) sessions[session.ref.id] = [...app.server.messages(session.ref.id)]
    app.backend.write(TRANSCRIPT, { scenario: scenario(), sessions } satisfies Transcript)
  }, 200)
}

// Messages the user or a plugin sends get the scenario's scripted reply.
const reply = (sessionID: string, text: string) => {
  const steps = findScenario(scenario())?.reply?.(text)
  if (steps) void runner.steps(steps, sessionID)
}
app.server.onPrompt = (record) => reply(record.sessionID, record.text)

async function loadPlugin(): Promise<void> {
  let loaded: { id: string; definition: Plugin.Definition } | undefined
  try {
    if (mode === "stub") loaded = { id: "stub", definition: (await import("./stub/gui.tsx")).default }
    else if (bundleUrl) {
      const result = await loadBundle(bundleUrl)
      console.info(`[playground] bundle ${bundleUrl}: ${result.size} bytes, requires ${result.required.join(", ")}`)
      loaded = { id: bundle === "stub" ? "stub" : PLUGIN_ID, definition: result.definition }
    } else {
      // A glob, so the playground builds and runs before src/gui.tsx exists.
      const sources = import.meta.glob<{ default: Plugin.Definition }>("../src/gui.tsx")
      const source = sources["../src/gui.tsx"]
      if (!source) {
        setNotice("No src/gui.tsx yet: the host runs without a plugin. Try ?plugin=stub.")
        return
      }
      loaded = { id: PLUGIN_ID, definition: (await source()).default }
    }
    host.load({ ...loaded, options })
  } catch (error) {
    console.error("[playground] plugin failed to load", error)
    setNotice(`The plugin failed to load: ${error instanceof Error ? error.message : String(error)}`)
    app.records.errors.push({ plugin: loaded?.id ?? mode, where: "load", message: String(error) })
  }
}

function Controls() {
  return (
    <>
      <label data-playground-control>
        <span>Scenario</span>
        <select
          data-playground-scenario
          value={scenario()}
          onChange={(event) => {
            setScenario(event.currentTarget.value)
            void runner.run(findScenario(event.currentTarget.value), app.sessions.current().id)
          }}
        >
          <For each={scenarios}>{(item) => <option value={item.name}>{item.title}</option>}</For>
        </select>
      </label>
      <button
        type="button"
        data-component="button-v2"
        data-size="small"
        data-variant="ghost"
        data-playground-restart
        onClick={() => void runner.run(findScenario(scenario()), app.sessions.current().id)}
      >
        Restart
      </button>
      <span data-playground-mode title={bundleUrl ?? ""}>
        {mode === "bundle" ? `bundle: ${bundleUrl}` : mode === "stub" ? "stub plugin" : "src/gui.tsx"} · {speed}
      </span>
    </>
  )
}

const root = document.getElementById("root")!
let resolveReady!: () => void
const ready = new Promise<void>((resolve) => (resolveReady = resolve))
let resolveScenario!: () => void
const scenarioDone = new Promise<void>((resolve) => (resolveScenario = resolve))
installHooks({ host, runner, mode, bundle: bundleUrl, ready, scenarioDone })

// Load the plugin first: the app runs setup before its interface mounts.
await loadPlugin()
host.mount(root, {
  controls: () => <Controls />,
  banner: () => (
    <Show when={notice()}>
      <span data-playground-notice>{notice()}</span>
    </Show>
  ),
  onSend: (text) => {
    const sessionID = app.sessions.current().id
    app.server.appendUser(sessionID, text)
    reply(sessionID, text)
  },
})
resolveReady()

const saved = persist ? (app.backend.read(TRANSCRIPT) as Transcript | undefined) : undefined
if (saved && saved.scenario === initialScenario.name && saved.sessions) {
  for (const [sessionID, messages] of Object.entries(saved.sessions)) {
    for (const message of messages) observeMessageId(message.id)
    // A message cut off by the reload stays as it was, like a reply that stopped mid-block.
    const settled = messages.map((message) =>
      message.type === "assistant" && message.time.completed === undefined
        ? { ...message, time: { ...message.time, completed: Date.now() } }
        : message,
    )
    app.server.load(sessionID, settled)
  }
  resolveScenario()
} else
  void runner
    .run(initialScenario, app.sessions.current().id)
    .catch((error: unknown) => console.error("[playground] scenario failed", error))
    .finally(resolveScenario)
