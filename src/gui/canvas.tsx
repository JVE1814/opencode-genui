import { createComputed, createMemo, Match, Show, Switch, untrack, type JSX } from "solid-js"
import type { MountedSession, Panel, PanelTab, SessionRef, UiMenuEntry } from "@opencode/plugin/gui"
import { compileSpec } from "../protocol/compile.ts"
import { writeSurfaceOverrides } from "../runtime/snapshot.ts"
import { getSurface, surfaceKey, type SurfaceRuntime } from "../runtime/surfaces.ts"
import { CANVAS_TAB_PREFIX } from "../shared/constants.ts"
import { HostContext } from "./host.ts"
import { allowOutward } from "./outward.ts"
import { persistSurface, surfaceEntry, writeStore } from "./persist.ts"
import type { SessionEntry } from "./sessions.ts"
import type { GuiEnv } from "./setup.tsx"
import { askToFix, SurfaceView } from "./surface.tsx"

type TabShown = "hidden" | "shown" | "missing"

/** The canvas id of one of this panel's tab ids (`canvas.<id>`). */
export const canvasOfTab = (tab: string) =>
  tab.startsWith(CANVAS_TAB_PREFIX) ? tab.slice(CANVAS_TAB_PREFIX.length) : tab

/**
 * The message "Ask agent to resend" sends for a canvas whose base is gone: like the fix message, written for the
 * agent and kept in English.
 */
export function formatResendRequest(canvas: string, title?: string): string {
  const name = title
    ? `"${title.replace(/\s+/g, " ").replace(/"/g, "'").slice(0, 120)}" (canvas \`${canvas}\`)`
    : `canvas \`${canvas}\``
  return `The UI ${name} can't be shown: its earlier version is no longer available to the app.\n\nPlease resend the whole canvas in one \`\`\`canvas block that sets /root.`
}

/**
 * The side panel with one tab per canvas. Tabs share one render (`group`), which follows the selected tab; tab objects
 * are cached per session, canvas and visibility, so unchanged tabs keep their identity and their label.
 */
export function canvasPanel(env: GuiEnv): Panel {
  // Per session entry (a session whose shell tab closed and reopened gets a new entry, and new tab objects), then per
  // tab id and visibility.
  const tabs = new WeakMap<SessionEntry, Map<string, PanelTab>>()

  const tabFor = (entry: SessionEntry, tabId: string, shown: TabShown): PanelTab => {
    let cache = tabs.get(entry)
    if (!cache) tabs.set(entry, (cache = new Map()))
    const cached = cache.get(`${tabId}\n${shown}`)
    if (cached) return cached
    const canvas = canvasOfTab(tabId)
    const title = () => entry.title(canvas) ?? canvas
    const tab: PanelTab = {
      id: tabId,
      get title() {
        return title()
      },
      group: "canvas",
      closable: "hover",
      ...(shown === "hidden" ? { hidden: true } : {}),
      ...(shown === "missing" ? { missing: true } : {}),
      label: () => <TabLabel env={env} title={title} streaming={() => !!entry.index.canvas(canvas)?.streaming} />,
    }
    cache.set(`${tabId}\n${shown}`, tab)
    return tab
  }

  return {
    id: "canvas",
    region: "side",
    list(input) {
      const entry = env.sessions.get(input.session)
      const { index } = entry
      const ready = index.ready()
      const keep = new Set<string>()
      const listed = input.open
        .filter((tabId) => tabId.startsWith(CANVAS_TAB_PREFIX))
        .map((tabId) => {
          const canvas = canvasOfTab(tabId)
          // Hidden until the index has loaded; struck through once the agent closed the canvas.
          const shown: TabShown = !ready
            ? "hidden"
            : !index.canvas(canvas) && index.removed().has(canvas)
              ? "missing"
              : "shown"
          keep.add(`${tabId}\n${shown}`)
          return tabFor(entry, tabId, shown)
        })
      const cache = tabs.get(entry)
      if (cache) for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key)
      return listed
    },
    render: (props) => <CanvasView env={env} tabId={() => props.tab.id} session={() => props.session} />,
    close(input) {
      env.markClosed(input.session, canvasOfTab(input.tab.id))
    },
  }
}

function TabLabel(props: { readonly env: GuiEnv; readonly title: () => string; readonly streaming: () => boolean }) {
  const { host } = props.env
  return (
    <span data-genui="" data-gu-chrome="tab">
      <span data-slot="icon">
        <host.ui.Icon name="layout-right" size="small" />
      </span>
      <span data-slot="title">{props.title()}</span>
      <Show when={props.streaming()}>
        <span data-gu-live="" role="img" aria-label={host.t("canvas.live")} />
      </Show>
    </span>
  )
}

/** One canvas in the side panel: a slim header with its title, live state and menu, and the canvas itself. */
function CanvasView(props: {
  readonly env: GuiEnv
  readonly tabId: () => string
  readonly session: () => MountedSession
}): JSX.Element {
  const { env } = props
  const { host, ctx } = env
  const ui = ctx.ui
  const canvas = () => canvasOfTab(props.tabId())
  const entry = createMemo(() => env.sessions.get(props.session()))
  const index = () => entry().index
  const state = () => index().canvas(canvas())
  const ready = () => index().ready()
  const removed = () => !state() && index().removed().has(canvas())
  const streaming = () => !!state()?.streaming
  const title = () => entry().title(canvas()) ?? canvas()
  const runtime = createMemo(() => getSurface(surfaceKey(props.session().key, "canvas", canvas())))
  const compiled = createMemo(() => compileSpec(state()?.spec ?? null, { streaming: streaming() }))
  const lineErrors = () => (streaming() ? [] : (state()?.lineErrors ?? []))
  const generation = () => state()?.generation

  // A replaced canvas (new generation) starts from the agent's state: what the user typed belonged to the old UI.
  createComputed(() => {
    const current = generation()
    if (current === undefined) return
    const surface = runtime()
    untrack(() => resetOnNewGeneration(env, props.session(), canvas(), surface, current))
  })

  persistSurface({
    runtime,
    store: () => env.store(props.session()),
    // Unknown until the index has folded the canvas: then the edits of its current generation load.
    entry: () => {
      const current = generation()
      return current === undefined ? undefined : surfaceEntry("canvas", canvas(), current)
    },
  })

  // One info object per mount: the group render follows the selected tab, so its id is read through a getter.
  const info = env.surfaceInfo({
    kind: "canvas",
    id: canvas,
    title,
    trusted: () => true,
    session: () => props.session(),
  })

  const issues = () => compiled().issues
  const hasProblems = () => !streaming() && (issues().length > 0 || lineErrors().length > 0)
  const rescanning = () => entry().rescanning()
  const rescan = () => void entry().rescan()

  const resend = async () => {
    const message = formatResendRequest(canvas(), state()?.title)
    const ok = await allowOutward(host, info, {
      title: host.t("confirm.send"),
      detail: message,
      confirmLabel: host.t("confirm.sendLabel"),
    })
    if (!ok) return
    await env
      .sendPrompt(props.session(), message)
      .catch(() => host.toast({ title: host.t("action.sendFailed"), variant: "error" }))
  }

  const menu = (): UiMenuEntry[] => {
    const items: UiMenuEntry[] = []
    const current = state()
    if (current?.spec)
      items.push({
        label: host.t("canvas.copySpec"),
        icon: "copy",
        onSelect: () => {
          void host.copy(JSON.stringify(current.spec, null, 2)).then(
            () => host.toast({ title: host.t("canvas.copied"), variant: "success" }),
            () => host.toast({ title: host.t("action.copyFailed"), variant: "error" }),
          )
        },
      })
    if (current)
      items.push({
        label: host.t("canvas.reset"),
        icon: "outline-reset",
        onSelect: () => runtime().store.reset(),
      })
    if (hasProblems())
      items.push({
        label: host.t("canvas.fix"),
        icon: "speech-bubble",
        onSelect: () => void askToFix(host, info, { issues: issues(), lineErrors: lineErrors() }),
      })
    if (items.length > 0) items.push({ type: "separator" })
    items.push({
      label: host.t("canvas.close"),
      icon: "close",
      onSelect: () => env.closeCanvas(props.session(), canvas()),
    })
    return items
  }

  const notice = (input: {
    readonly icon: "warning" | "info" | "layout-right"
    readonly title: string
    readonly body?: string
    readonly actions?: JSX.Element
  }) => (
    <div data-gu-chrome="notice">
      <span data-slot="icon">
        <ui.Icon name={input.icon} size="large" />
      </span>
      <div data-slot="title">{input.title}</div>
      <Show when={input.body}>
        <p data-slot="body">{input.body}</p>
      </Show>
      <Show when={input.actions}>
        <div data-slot="actions">{input.actions}</div>
      </Show>
    </div>
  )

  const rescanButton = () => (
    <ui.Button size="small" variant="neutral" icon="refresh" busy={rescanning()} onClick={rescan}>
      {rescanning() ? host.t("canvas.rescanning") : host.t("canvas.rescan")}
    </ui.Button>
  )

  return (
    <HostContext.Provider value={host}>
      <div data-genui="" data-gu-chrome="canvas" data-canvas={canvas()}>
        <header data-slot="header">
          <span data-slot="title" title={title()}>
            {title()}
          </span>
          <Show when={streaming()}>
            <span data-slot="status" role="status">
              <span data-gu-live="" />
              {host.t("canvas.updating")}
            </span>
          </Show>
          <span data-slot="menu">
            <ui.Menu label={host.t("canvas.menu")} items={menu()} />
          </span>
        </header>
        <div data-slot="body">
          <Switch
            fallback={notice({
              icon: "info",
              title: host.t("canvas.unknown.title"),
              body: host.t("canvas.unknown.body"),
              actions: rescanButton(),
            })}
          >
            <Match when={!ready()}>
              <div data-gu-chrome="notice" data-tone="quiet">
                <ui.Loader size="small" />
                <span>{host.t("canvas.loading")}</span>
              </div>
            </Match>
            <Match when={state()?.missingBase}>
              {notice({
                icon: "warning",
                title: host.t("canvas.missingBase.title"),
                body: host.t("canvas.missingBase.body"),
                actions: (
                  <>
                    {rescanButton()}
                    <ui.Button size="small" variant="neutral" icon="speech-bubble" onClick={() => void resend()}>
                      {host.t("canvas.resend")}
                    </ui.Button>
                  </>
                ),
              })}
            </Match>
            <Match when={state() && !compiled().spec && !compiled().fatal}>
              <div data-gu-chrome="notice" data-tone="quiet">
                <Show when={streaming()}>
                  <ui.Loader size="small" />
                </Show>
                <span>{streaming() ? host.t("canvas.updating") : host.t("canvas.empty")}</span>
              </div>
            </Match>
            <Match when={state()}>
              <SurfaceView
                host={host}
                compiled={compiled}
                runtime={runtime}
                info={info}
                streaming={streaming}
                lineErrors={lineErrors}
              />
            </Match>
            <Match when={removed()}>
              {notice({
                icon: "layout-right",
                title: host.t("canvas.removed.title"),
                body: host.t("canvas.removed.body"),
              })}
            </Match>
          </Switch>
        </div>
      </div>
    </HostContext.Provider>
  )
}

// The generation each canvas runtime's edits belong to; a different one resets the edits and their stored copy.
function resetOnNewGeneration(
  env: GuiEnv,
  session: SessionRef,
  canvas: string,
  runtime: SurfaceRuntime,
  generation: number,
) {
  const previous = runtime.generation
  runtime.generation = generation
  if (previous === undefined || previous === generation) return
  runtime.store.reset()
  writeStore(env.store(session), (value) => writeSurfaceOverrides(value, surfaceEntry("canvas", canvas, previous), []))
}
