import {
  createComputed,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import {
  usePanel,
  type MountedSession,
  type Panel,
  type PanelTab,
  type SessionRef,
  type UiMenuEntry,
  type UiSelectOption,
} from "@opencode/plugin/gui"
import { compileSpec } from "../protocol/compile.ts"
import { compareRefs } from "../protocol/fold.ts"
import { writeSurfaceOverrides } from "../runtime/snapshot.ts"
import { getSurface, surfaceKey, type SurfaceRuntime } from "../runtime/surfaces.ts"
import { CANVAS_TAB_PREFIX } from "../shared/constants.ts"
import { HostContext } from "./host.ts"
import { allowOutward } from "./outward.ts"
import { persistSurface, surfaceEntry, writeStore } from "./persist.ts"
import type { SessionEntry } from "./sessions.ts"
import type { GuiEnv } from "./setup.tsx"
import { canvasesRefused } from "./issues.ts"
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
    // Narrow windows show no side region: the session's canvases are a view of their own there, in the More menu.
    mobile: { title: env.ctx.t("menu.canvas"), order: 60, kind: "menu", icon: "layout-right" },
    // The host computes every plugin's panel list in one memo, so this reads only cheap, equality-guarded selectors
    // (booleans and the removed set), never the canvas states that change on every streaming update.
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
            : !index.exists(canvas) && index.removed().has(canvas)
              ? "missing"
              : "shown"
          keep.add(`${tabId}\n${shown}`)
          return tabFor(entry, tabId, shown)
        })
      const cache = tabs.get(entry)
      if (cache) for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key)
      return listed
    },
    render: (props) => <PanelView env={env} tabId={() => props.tab.id} session={() => props.session} />,
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

/** Where the panel renders: the side region (one canvas per tab), or the narrow-screen view of all of them. */
function placement(): () => "side" | "mobile" {
  try {
    return usePanel().placement
  } catch {
    return () => "side"
  }
}

function PanelView(props: {
  readonly env: GuiEnv
  readonly tabId: () => string
  readonly session: () => MountedSession
}): JSX.Element {
  const where = placement()
  return (
    <Show when={where() === "mobile"} fallback={<CanvasView {...props} />}>
      <MobileCanvases env={props.env} session={props.session} />
    </Show>
  )
}

/**
 * The narrow-screen view: the canvas the user last opened in this session (else the one the agent updated last), with
 * a picker in its header when the session has more than one.
 */
function MobileCanvases(props: { readonly env: GuiEnv; readonly session: () => MountedSession }): JSX.Element {
  const { env } = props
  const { host } = env
  const entry = createMemo(() => env.sessions.get(props.session()))
  const ids = () => entry().index.canvasIds()
  const latest = createMemo(() => {
    const states = entry().index.canvases()
    if (states.length === 0) return undefined
    return states.reduce((a, b) => (compareRefs(a.last, b.last) >= 0 ? a : b)).id
  })
  const shown = createMemo(() => {
    const wanted = env.mobileCanvas(props.session())
    return wanted !== undefined && ids().includes(wanted) ? wanted : latest()
  })
  const choices = () =>
    ids().length > 1 ? ids().map((id): UiSelectOption => ({ value: id, label: entry().title(id) ?? id })) : undefined
  return (
    <Show
      when={shown()}
      fallback={
        <div data-genui="" data-gu-chrome="canvas">
          <div data-slot="body">
            <div data-gu-chrome="notice">
              <span data-slot="icon">
                <env.ctx.ui.Icon name="layout-right" size="large" />
              </span>
              <div data-slot="title">{host.t("none.title")}</div>
              <p data-slot="body">{host.t("none.description")}</p>
            </div>
          </div>
        </div>
      }
    >
      {(canvas) => (
        <CanvasView
          env={env}
          tabId={() => `${CANVAS_TAB_PREFIX}${canvas()}`}
          session={props.session}
          choices={choices}
          onChoose={(id) => env.showMobileCanvas(props.session(), id)}
        />
      )}
    </Show>
  )
}

/** One canvas in the side panel: a slim header with its title, live state and menu, and the canvas itself. */
function CanvasView(props: {
  readonly env: GuiEnv
  readonly tabId: () => string
  readonly session: () => MountedSession
  /** The canvases to pick from in the header instead of the title (the narrow-screen view). */
  readonly choices?: () => readonly UiSelectOption[] | undefined
  readonly onChoose?: (canvas: string) => void
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
  // The newest canvas also says how many canvases were not opened (see MAX_CANVASES in src/protocol/fold.ts).
  const refused = createMemo(() => {
    const ids = index().canvasIds()
    return ids[ids.length - 1] === canvas() ? index().refused().size : 0
  })
  const compiled = createMemo(() => {
    const result = compileSpec(state()?.spec ?? null, { streaming: streaming() })
    return refused() > 0 ? { ...result, issues: [...result.issues, canvasesRefused(refused())] } : result
  })
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
          <Show
            when={props.choices?.()}
            fallback={
              <span data-slot="title" title={title()}>
                {title()}
              </span>
            }
          >
            {(choices) => (
              <span data-slot="picker">
                <ui.Select
                  label={host.t("pick.title")}
                  options={choices()}
                  value={canvas()}
                  placement="bottom-start"
                  onChange={(id) => props.onChoose?.(id)}
                />
              </span>
            )}
          </Show>
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
              <Drawing
                streaming={streaming}
                notice={
                  <div data-gu-chrome="notice" data-tone="quiet">
                    <ui.Loader size="small" />
                    <span>{host.t("canvas.updating")}</span>
                  </div>
                }
              >
                <SurfaceView
                  host={host}
                  compiled={compiled}
                  runtime={runtime}
                  info={info}
                  streaming={streaming}
                  lineErrors={lineErrors}
                />
              </Drawing>
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

/** What counts as drawn when a canvas surface has no text yet: media, charts, icons and controls. */
const DRAWN = "img, svg, canvas, video, input, textarea, select, button, progress, meter, [role='img']"

/** Whether a surface shows anything yet: text, or something from DRAWN (an empty Card frame does not count). */
const drawsSomething = (surface: Element) =>
  (surface.textContent ?? "").trim() !== "" || surface.querySelector(DRAWN) !== null

/**
 * A canvas surface that may have nothing to show yet: while the agent streams, the root can exist before any of its
 * children (an empty Stack, or a Card that is only a frame), and the surface would look blank. Until it draws something
 * (see drawsSomething), the quiet notice stays over it.
 */
function Drawing(props: {
  readonly streaming: () => boolean
  readonly notice: JSX.Element
  readonly children: JSX.Element
}): JSX.Element {
  const [blank, setBlank] = createSignal(true)
  let wrapper: HTMLDivElement | undefined
  onMount(() => {
    const surface = wrapper?.firstElementChild
    if (!surface || typeof MutationObserver === "undefined") return void setBlank(false)
    const check = () => setBlank(!drawsSomething(surface))
    const observer = new MutationObserver(check)
    observer.observe(surface, { childList: true, subtree: true, characterData: true })
    check()
    onCleanup(() => observer.disconnect())
  })
  return (
    <div data-slot="drawing">
      <div data-slot="surface" ref={wrapper}>
        {props.children}
      </div>
      <Show when={props.streaming() && blank()}>{props.notice}</Show>
    </div>
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
  runtime.memory.clear()
  writeStore(env.store(session), (value) => writeSurfaceOverrides(value, surfaceEntry("canvas", canvas, previous), []))
}
