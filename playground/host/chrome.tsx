import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Command, SettingsPage, Style } from "@opencode/plugin/gui"
import type { App } from "./app.ts"
import { Contribution } from "./contribution.tsx"
import { keysOf } from "./context.ts"
import { DialogLayer } from "./dialogs.tsx"
import type { Region } from "./region.ts"
import { useItems } from "./registry.ts"
import { SideRegion } from "./side.tsx"
import { Timeline } from "./timeline.tsx"
import { Icon, Keybind, ui } from "./ui.tsx"

/** The fake app window: header, session screen (timeline and composer), side region, settings, overlays. */
export function Shell(props: {
  readonly app: App
  readonly region: Region
  /** Playground controls (scenario picker and so on) shown in the header. */
  readonly controls?: () => JSX.Element
  /** A notice above the timeline, e.g. why no plugin is loaded. */
  readonly banner?: () => JSX.Element
  /** Sends what the user typed in the composer (the scenario runner answers it). */
  readonly onSend?: (text: string) => void
}) {
  const app = props.app
  onMount(() => app.setMounted())
  return (
    <div data-playground-shell data-view={app.view()}>
      <Styles app={app} />
      <header data-playground-header>
        <div data-playground-brand>
          <Icon name="sidebar" /> genui playground
        </div>
        <div data-playground-controls>{props.controls?.()}</div>
        <div data-playground-actions>
          <ui.Button size="small" variant="ghost" icon="terminal" onClick={() => app.setPalette(true)}>
            Commands
          </ui.Button>
          <ui.Button
            size="small"
            variant={app.view() === "settings" ? "neutral" : "ghost"}
            onClick={() => (app.view() === "settings" ? app.closeSettings() : app.openSettings())}
          >
            Settings
          </ui.Button>
          <ui.Button size="small" variant="ghost" onClick={() => app.setMode(app.mode() === "dark" ? "light" : "dark")}>
            {app.mode() === "dark" ? "Light" : "Dark"}
          </ui.Button>
          <ui.IconButton
            icon="layout-right"
            label="Toggle side panel"
            pressed={app.layout.strip(app.sessions.current().key).open}
            onClick={() => {
              const key = app.sessions.current().key
              app.layout.setOpen(key, !app.layout.strip(key).open)
            }}
          />
        </div>
      </header>
      <Show when={app.view() === "session"} fallback={<SettingsView app={app} />}>
        <main data-playground-main>
          <section data-playground-session>
            <nav data-playground-session-tabs aria-label="Sessions">
              <For each={app.sessions.all}>
                {(session) => (
                  <button
                    type="button"
                    data-playground-session-tab={session.ref.id}
                    aria-pressed={app.sessions.current().key === session.ref.key}
                    onClick={() => app.sessions.route(session.ref.key)}
                  >
                    {session.title}
                  </button>
                )}
              </For>
            </nav>
            <Show when={props.banner}>{(banner) => <div data-playground-banner>{banner()()}</div>}</Show>
            <Timeline app={app} />
            <Composer app={app} onSend={props.onSend} />
          </section>
          <SideRegion app={app} region={props.region} />
        </main>
      </Show>
      <Show when={app.palette()}>
        <CommandPalette app={app} />
      </Show>
      <DialogLayer app={app} />
      <Toasts app={app} />
    </div>
  )
}

/** Style contributions, each a `<style data-plugin>` in the document head while contributed. */
function Styles(props: { readonly app: App }) {
  const styles = useItems(props.app.contributions, Style)
  return (
    <For each={styles()}>
      {(item) => {
        const element = document.createElement("style")
        element.dataset.plugin = item.plugin
        element.textContent = String(item.value)
        document.head.appendChild(element)
        onCleanup(() => element.remove())
        return null
      }}
    </For>
  )
}

function Composer(props: { readonly app: App; readonly onSend?: (text: string) => void }) {
  const key = () => props.app.sessions.current().key
  const text = () => props.app.sessions.composer.text(key())
  const send = () => {
    const value = text().trim()
    if (!value) return
    props.app.sessions.composer.setText(key(), "")
    props.onSend?.(value)
  }
  return (
    <form
      data-playground-composer
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <textarea
        aria-label="Message"
        placeholder="Ask anything (Enter sends, Shift+Enter for a new line)"
        value={text()}
        rows={2}
        onInput={(event) => props.app.sessions.composer.setText(key(), event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
          event.preventDefault()
          send()
        }}
      />
      <ui.Button type="submit" variant="contrast" size="small" disabled={!text().trim()}>
        Send
      </ui.Button>
    </form>
  )
}

function CommandPalette(props: { readonly app: App }) {
  const commands = useItems(props.app.contributions, Command)
  const [query, setQuery] = createSignal("")
  const shown = createMemo(() =>
    commands()
      .filter((item) => !item.value.hidden && item.value.enabled !== false)
      .filter((item) =>
        `${item.value.title} ${item.value.description ?? ""} ${item.value.keywords ?? ""}`
          .toLowerCase()
          .includes(query().toLowerCase()),
      ),
  )
  const run = (plugin: string, id: string) => {
    props.app.setPalette(false)
    props.app.contexts()[plugin]?.commands.run(`${plugin}.${id}`)
  }
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.app.setPalette(false)
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })
  return (
    <>
      <div data-component="dialog-overlay" onClick={() => props.app.setPalette(false)} />
      <div data-playground-palette role="dialog" aria-label="Commands">
        <ui.TextInput
          label="Search commands"
          placeholder="Search commands"
          value={query()}
          onInput={setQuery}
          autofocus
        />
        <div data-playground-palette-list>
          <For each={shown()} fallback={<p class="playground-muted">No commands.</p>}>
            {(item) => (
              <div data-playground-command={`${item.plugin}.${item.value.id}`}>
                <div data-playground-command-copy>
                  <span data-playground-command-title>{item.value.title}</span>
                  <Show when={item.value.description}>
                    <span class="playground-muted">{item.value.description}</span>
                  </Show>
                  <Show when={item.value.group}>
                    <span class="playground-muted">{item.value.group}</span>
                  </Show>
                </div>
                <Show when={item.value.bind}>{(bind) => <Keybind keys={keysOf(bind())} />}</Show>
                <Show when={item.value.slash}>{(slash) => <code>/{slash().name}</code>}</Show>
                <ui.Button size="small" onClick={() => run(item.plugin, item.value.id)}>
                  Run
                </ui.Button>
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  )
}

function SettingsView(props: { readonly app: App }) {
  const app = props.app
  const pages = useItems(app.contributions, SettingsPage)
  const own = () => pages().filter((item) => !item.value.page)
  const general = () => pages().filter((item) => item.value.page === "general")
  const current = () => app.settingsPage() ?? "general"
  const page = () => own().find((item) => item.value.id === current())
  return (
    <main data-playground-settings>
      <nav data-playground-settings-nav aria-label="Settings pages">
        <button
          type="button"
          aria-current={current() === "general" || undefined}
          onClick={() => app.openSettings("general")}
        >
          General
        </button>
        <For each={own()}>
          {(item) => (
            <button
              type="button"
              data-playground-settings-page={item.value.id}
              aria-current={current() === item.value.id || undefined}
              onClick={() => app.openSettings(item.value.id)}
            >
              <Show when={item.value.icon}>{(icon) => <Icon name={icon()} size="small" />}</Show>
              {item.value.title}
            </button>
          )}
        </For>
        <button type="button" onClick={() => app.closeSettings()}>
          ← Back to session
        </button>
      </nav>
      <div data-playground-settings-body>
        <Show
          when={page()}
          keyed
          fallback={
            <>
              <ui.SettingsLayout title="General">
                <ui.SettingsSection title="Appearance">
                  <ui.SettingsRow title="Color scheme" description="The playground's light or dark mode.">
                    <ui.Select
                      label="Color scheme"
                      options={[
                        { value: "light", label: "Light" },
                        { value: "dark", label: "Dark" },
                      ]}
                      value={app.mode()}
                      onChange={(mode) => app.setMode(mode as "light" | "dark")}
                    />
                  </ui.SettingsRow>
                </ui.SettingsSection>
                <For each={general()}>
                  {(item) => (
                    <Contribution app={app} plugin={item.plugin} where={`SettingsPage ${item.value.id}`}>
                      {() => item.value.render({})}
                    </Contribution>
                  )}
                </For>
              </ui.SettingsLayout>
            </>
          }
        >
          {(item) => (
            <Contribution app={app} plugin={item.plugin} where={`SettingsPage ${item.value.id}`}>
              {() => item.value.render({})}
            </Contribution>
          )}
        </Show>
      </div>
    </main>
  )
}

function Toasts(props: { readonly app: App }) {
  return (
    <div class="toast-v2-region" data-playground-toasts>
      <For each={props.app.toasts.list()}>
        {(toast) => (
          <div
            class="toast-v2"
            role="status"
            data-playground-toast={toast.options.variant ?? "default"}
            data-variant={toast.options.variant ?? "default"}
          >
            <Show when={toast.options.variant === "loading"}>
              <div data-slot="toast-v2-icon" data-icon>
                <ui.Loader size="small" />
              </div>
            </Show>
            <Show when={toast.options.icon ?? (toast.options.variant === "success" ? "check" : undefined)}>
              {(icon) => (
                <div data-slot="toast-v2-icon" data-icon>
                  <Icon name={icon()} />
                </div>
              )}
            </Show>
            <div data-slot="toast-v2-content">
              <div data-slot="toast-v2-title">{toast.options.title}</div>
              <Show when={toast.options.description}>
                <div data-slot="toast-v2-description">{toast.options.description}</div>
              </Show>
              <Show when={toast.options.actions?.length}>
                <div data-slot="toast-v2-actions">
                  <For each={toast.options.actions}>
                    {(action) => (
                      <ui.Button
                        size="small"
                        onClick={() => {
                          props.app.toasts.dismiss(toast.id)
                          try {
                            action.run()
                          } catch (error) {
                            console.error(error)
                          }
                        }}
                      >
                        {action.label}
                      </ui.Button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <button
              type="button"
              data-slot="toast-v2-close-button"
              aria-label="Dismiss"
              onClick={() => props.app.toasts.dismiss(toast.id)}
            >
              <Icon name="close" size="small" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
