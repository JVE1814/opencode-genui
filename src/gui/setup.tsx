import { createEffect, createSignal, getOwner, onCleanup, untrack } from "solid-js"
import {
  CodeBlock,
  Command,
  createKeyed,
  MenuItem,
  Panel,
  SettingsPage,
  Store,
  Style,
  type Context,
  type Plugin,
  type SessionRef,
} from "@opencode/plugin/gui"
import { Schema } from "effect"
import { compareRefs, MAX_CANVASES } from "../protocol/fold.ts"
import {
  activationTarget,
  ensureInstructions,
  removeInstructions,
  sameActivation,
  sessionHint,
} from "../runtime/activation.ts"
import { EMPTY_PERSISTED } from "../runtime/snapshot.ts"
import { clearSurfaces, peekSurface, surfaceKeyPrefix } from "../runtime/surfaces.ts"
import { CANVAS_TAB_PREFIX, INSTRUCTION_KEY, LANGUAGES, SKILL_ID } from "../shared/constants.ts"
import { hintFor } from "../shared/hint.ts"
import { parseOptions, type GenuiOptions } from "../shared/options.ts"
import { createHostAdapter } from "./adapter.ts"
import { canvasOfTab, canvasPanel } from "./canvas.tsx"
import { DEFAULT_PREFS, type Host, type SurfaceContext } from "./host.ts"
import { renderBlock } from "./inline.tsx"
import { clearStoredSurfaces, flushOnAbort, flushSurfaceWrites, type SessionStore } from "./persist.ts"
import { createSessionRegistry, type SessionRegistry } from "./sessions.ts"
import { SettingsView } from "./settings.tsx"
import { css } from "./styles/index.ts"

export const PrefsSchema = Schema.Struct({
  autoOpen: Schema.Literals(["select", "append", "off"]),
  confirmActions: Schema.Literals(["always", "untrusted", "never"]),
  remoteImages: Schema.Boolean,
})

export const PersistedSessionSchema = Schema.Struct({
  v: Schema.Number,
  canvases: Schema.Record(Schema.String, Schema.String),
  surfaces: Schema.Record(Schema.String, Schema.String),
})

/** The GUI's stored state: preferences for the app, and per session the canvas snapshots and the user's UI edits. */
export const stores = {
  prefs: Store.global(PrefsSchema, DEFAULT_PREFS),
  session: Store.session(PersistedSessionSchema, EMPTY_PERSISTED),
}

export type GenuiDeclarations = Plugin.Declarations<typeof stores>

/** What the GUI's views share: the host seam, the session indexes and the session-level operations. */
export interface GuiEnv {
  readonly ctx: Context
  readonly host: Host
  readonly options: GenuiOptions
  readonly sessions: SessionRegistry
  store(session: SessionRef): SessionStore
  /** The host key of a canvas's tab, `${plugin}:canvas.<id>`. */
  tabKey(canvas: string): string
  openCanvas(session: SessionRef, canvas: string, tab?: "select" | "append"): void
  /** The canvas the narrow-screen view shows for a session: the one last opened, if any. Reactive. */
  mobileCanvas(session: SessionRef): string | undefined
  /** Shows a canvas in the narrow-screen view (its picker). */
  showMobileCanvas(session: SessionRef, canvas: string): void
  closeCanvas(session: SessionRef, canvas: string): void
  /** The user closed this canvas's tab in this window; auto-open leaves it closed. */
  markClosed(session: SessionRef, canvas: string): void
  sendPrompt(session: SessionRef, text: string): Promise<void>
  insertPrompt(session: SessionRef, text: string): void
  /** The SurfaceContext of a surface of `session()`: what its actions reach. One object per mounted surface. */
  surfaceInfo(input: {
    readonly kind: SurfaceContext["kind"]
    readonly id: () => string
    readonly title: () => string | undefined
    readonly trusted: () => boolean
    readonly session: () => SessionRef | undefined
  }): SurfaceContext
  /** Resets the UI state of every surface (or one session's) and forgets the stored edits. */
  resetSurfaces(session?: SessionRef): void
}

/**
 * How many of the tabs auto-open opened may be open in a session at once: as many as a session has canvases (see
 * MAX_CANVASES). Each canvas a reply streams opens its tab, and a reply that opened and closed canvases in turn left
 * hundreds of tabs, the work of each delta growing with them. A live canvas always gets a place: at most MAX_CANVASES
 * are live, so when all are taken, one holds a canvas the agent closed, and the oldest such tab gives up its place.
 */
export const MAX_AUTO_OPEN = MAX_CANVASES

export const setup: Plugin.Setup<GenuiDeclarations> = (ctx) => {
  ctx.add(Style, css)

  const options = parseOptions(ctx.options)
  const host = createHostAdapter(ctx, () => ctx.stores.prefs.value)
  const store = (session: SessionRef): SessionStore => ctx.stores.session(session)
  // Session roots take the plugin root's context, so their errors fail the plugin whoever first asked for a session.
  const sessions = createSessionRegistry(store, { owner: getOwner() })
  const closed = new Set<string>()
  const closedKey = (session: SessionRef, canvas: string) => `${session.key}\n${canvas}`
  // Per session key: the canvases whose tab auto-open opened and that are still open, oldest first (see MAX_AUTO_OPEN),
  // and the tab genui is closing itself (not the user: auto-open may open it again). A session's set starts from the
  // canvas tabs its strip holds, so an app restart, which keeps the strip, does not reset the count.
  const autoOpened = new Map<string, Set<string>>()
  const closing = new Set<string>()
  const tabKey = (canvas: string) => `${ctx.id}:${CANVAS_TAB_PREFIX}${canvas}`
  // The host reports the close to the panel (markClosed) while it closes the tab; the mark is dropped either way, so a
  // close the host did not report cannot hide the user's next one.
  const closeOwn = (session: SessionRef, canvas: string) => {
    const key = closedKey(session, canvas)
    closing.add(key)
    try {
      ctx.layout.close(tabKey(canvas), session)
    } finally {
      closing.delete(key)
    }
  }
  // Per session key: the canvas the narrow-screen view shows.
  const [mobile, setMobile] = createSignal<ReadonlyMap<string, string>>(new Map())
  const showMobile = (session: SessionRef, canvas: string) =>
    setMobile((previous) =>
      previous.get(session.key) === canvas ? previous : new Map(previous).set(session.key, canvas),
    )

  /**
   * Before a UI sends a message: switches the session to the model the user picked in the composer, as the app's own
   * send does (composer/submit.ts `applySelection`). The pick stays in the window until a prompt is sent, and only the
   * routed session has the composer. Not while a revert is staged: the prompt commits it, which drops a switch made after
   * its cut. Best effort: if anything fails, the message still goes, on the session's model. The plugin API does not
   * expose the composer's agent, so the session's current agent answers.
   */
  async function applyComposerModel(session: SessionRef) {
    try {
      if (ctx.sessions.current()?.key !== session.key) return
      const picked = ctx.screen.current()?.composer.model()
      if (!picked) return
      const info = session.server.data.session.get(session.id) as
        | { model?: { id: string; providerID: string; variant?: string }; revert?: unknown }
        | undefined
      const stored = info?.model
      if (info?.revert) return
      if (stored?.id === picked.modelID && stored.providerID === picked.providerID && stored.variant === picked.variant)
        return
      await session.server.client.session.switchModel({
        sessionID: session.id,
        model: {
          id: picked.modelID,
          providerID: picked.providerID,
          ...(picked.variant ? { variant: picked.variant } : {}),
        },
      })
    } catch (error) {
      console.warn("genui: could not switch to the composer's model", error)
    }
  }

  const env: GuiEnv = {
    ctx,
    host,
    options,
    sessions,
    store,
    tabKey,
    openCanvas(session, canvas, tab = "select") {
      closed.delete(closedKey(session, canvas))
      showMobile(session, canvas)
      // On a narrow screen the side region is not shown: a canvas the user opens shows in the panel's narrow-screen
      // view (an `open` selects it there); one opened quietly stays a tab for when the window is wide.
      if (tab === "select" && ctx.layout.narrow()) ctx.layout.open(tabKey(canvas), session, { tab: "open" })
      else ctx.layout.open(tabKey(canvas), session, { tab, background: true })
    },
    mobileCanvas: (session) => mobile().get(session.key),
    showMobileCanvas: showMobile,
    closeCanvas: (session, canvas) => ctx.layout.close(tabKey(canvas), session),
    markClosed(session, canvas) {
      const key = closedKey(session, canvas)
      if (!closing.delete(key)) closed.add(key)
    },
    async sendPrompt(session, text) {
      await applyComposerModel(session)
      await session.server.client.session.prompt({ sessionID: session.id, text })
    },
    insertPrompt(session, text) {
      // The composer follows the routed session; only fill it when that is the surface's session.
      const screen = ctx.screen.current()
      if (!screen || ctx.sessions.current()?.key !== session.key) {
        ctx.toast.show({ title: ctx.t("action.noSession"), variant: "error" })
        return
      }
      screen.composer.insert(text)
      screen.composer.focus()
    },
    surfaceInfo(input) {
      return {
        kind: input.kind,
        get id() {
          return input.id()
        },
        get title() {
          return input.title()
        },
        get trusted() {
          return input.trusted()
        },
        get sendPrompt() {
          const session = input.session()
          return session ? (text: string) => env.sendPrompt(session, text) : undefined
        },
        get insertPrompt() {
          const session = input.session()
          return session ? (text: string) => env.insertPrompt(session, text) : undefined
        },
        get openCanvas() {
          const session = input.session()
          if (!session) return undefined
          return (canvas: string) => {
            const index = sessions.get(session).index
            if (index.ready() && !index.canvas(canvas)) {
              ctx.toast.show({ title: ctx.t("action.canvasMissing", { canvas }), variant: "error" })
              return
            }
            env.openCanvas(session, canvas)
          }
        },
      }
    },
    resetSurfaces(session) {
      const prefix = session ? surfaceKeyPrefix(session.key) : undefined
      clearSurfaces((key) => {
        if (prefix !== undefined && !key.startsWith(prefix)) return false
        peekSurface(key)?.store.reset()
        return true
      })
      flushSurfaceWrites()
      // Also the sessions whose store has not loaded in this window: the write waits for the load.
      const targets = session ? [session] : ctx.sessions.list()
      for (const target of targets) clearStoredSurfaces(store(target))
    },
  }

  // ── Lifetime ──────────────────────────────────────────────────────────────────────────────────────────────────
  const flush = () => {
    flushSurfaceWrites()
    sessions.flush()
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush)
    onCleanup(() => window.removeEventListener("pagehide", flush))
  }
  // When the plugin goes away (reload, update, disable, options change), pending writes go first: the host aborts the
  // signal before it disposes the session stores, and an onCleanup here only runs after that. The flush at cleanup is
  // for a host that disposes without aborting (and writes nothing when the abort already flushed).
  const stopFlush = flushOnAbort(ctx.signal, flush)
  onCleanup(() => {
    stopFlush()
    flush()
    sessions.dispose()
  })

  // Sessions whose shell tab closed take their index with them. Not before the interface mounts: until then no session
  // is listed, while panels and code blocks may already have asked for one.
  createEffect(() => {
    if (!ctx.layout.ready()) return
    const keep = new Set(ctx.sessions.list().map((session) => session.key))
    const current = ctx.sessions.current()
    if (current) keep.add(current.key)
    sessions.prune(keep)
    for (const key of autoOpened.keys()) if (!keep.has(key)) autoOpened.delete(key)
  })

  // ── Auto-open: a canvas that starts in a live reply opens its tab once ────────────────────────────────────────
  // Each start once: a canvas the agent closed and sent again whole starts again, and keeps the tab auto-open gave it,
  // or gets one again if genui closed it; never one the user closed. A canvas the agent closes again in the reply that
  // started it takes its tab with it. At most MAX_AUTO_OPEN of the tabs it opened stay open in a session: past that,
  // the oldest of a canvas the agent closed (struck through) make room. After an app restart, every canvas tab the
  // strip kept counts (the strip does not say which tabs auto-open opened), oldest first.
  createEffect(() => {
    const session = ctx.sessions.current()
    if (!session) return
    const index = sessions.get(session).index
    const fresh = index.fresh()
    if (fresh.length === 0) return
    // (Until the stored strip has loaded, it reads as empty.)
    if (!ctx.layout.ready()) return
    const mode = host.prefs().autoOpen
    untrack(() => {
      let opened = autoOpened.get(session.key)
      if (!opened) {
        const stored = ctx.layout.stored(session).filter((tab) => tab.startsWith(CANVAS_TAB_PREFIX))
        autoOpened.set(session.key, (opened = new Set(stored.map(canvasOfTab))))
      }
      for (const canvas of [...opened])
        if (ctx.layout.state(tabKey(canvas), session) === "closed") opened.delete(canvas)
      for (const canvas of fresh) {
        index.consumeFresh(canvas)
        if (mode === "off" || closed.has(closedKey(session, canvas)) || opened.has(canvas)) continue
        // (Only once the index has loaded the session's canvases: until then, a live one could read as closed.)
        if (opened.size >= MAX_AUTO_OPEN && index.ready()) {
          const live = new Set(index.canvasIds())
          for (const old of [...opened]) {
            if (opened.size < MAX_AUTO_OPEN) break
            if (live.has(old)) continue
            opened.delete(old)
            closeOwn(session, old)
          }
        }
        if (opened.size >= MAX_AUTO_OPEN) continue
        ctx.layout.open(tabKey(canvas), session, { tab: mode === "select" ? "select" : "append", background: true })
        opened.add(canvas)
      }
    })
  })
  createEffect(() => {
    const session = ctx.sessions.current()
    if (!session) return
    const index = sessions.get(session).index
    const withdrawn = index.withdrawn()
    if (withdrawn.length === 0) return
    untrack(() => {
      const opened = autoOpened.get(session.key)
      for (const canvas of withdrawn) {
        if (opened?.delete(canvas) && ctx.layout.state(tabKey(canvas), session) !== "closed") closeOwn(session, canvas)
        index.consumeWithdrawn(canvas)
      }
    })
  })

  // ── Activation: tell the agent about genui in sessions shown here ─────────────────────────────────────────────
  // Runs again for a reconnect or a restarted server's new client, so a put that failed is retried; ensureInstructions
  // keeps it to one request per client and session.
  const target = () => activationTarget(ctx.sessions.current())
  if (options.instructions === "session") {
    let warned = false
    createKeyed(
      target,
      (run) => {
        const value = sessionHint(hintFor(options), SKILL_ID)
        void ensureInstructions(run.client, run.sessionID, INSTRUCTION_KEY, value).then((result) => {
          if (result !== "failed" || warned || ctx.signal.aborted) return
          warned = true
          ctx.toast.show({
            title: ctx.t("activation.failed.title"),
            description: ctx.t("activation.failed.description"),
            variant: "error",
          })
        })
      },
      { equals: sameActivation },
    )
  } else {
    // A previous "session" setting may have left the entry behind.
    const cleaned = new Set<string>()
    createKeyed(
      target,
      (run) => {
        if (cleaned.has(run.key)) return
        cleaned.add(run.key)
        // A failed removal is tried again on the next reconnect or client.
        void removeInstructions(run.client, run.sessionID, INSTRUCTION_KEY).then((ok) => {
          if (!ok) cleaned.delete(run.key)
        })
      },
      { equals: sameActivation },
    )
  }

  // ── Inline blocks and canvas chips ────────────────────────────────────────────────────────────────────────────
  ctx.add(CodeBlock, { languages: [...LANGUAGES], render: (props) => renderBlock(env, props) })

  // ── Canvas tabs ───────────────────────────────────────────────────────────────────────────────────────────────
  ctx.add(Panel, canvasPanel(env))

  const pickCanvas = async () => {
    const session = ctx.sessions.current()
    if (!session) {
      ctx.toast.show({ title: ctx.t("noSession.title") })
      return
    }
    const canvases = sessions.get(session).index.canvases()
    if (canvases.length === 0) {
      ctx.toast.show({ title: ctx.t("none.title"), description: ctx.t("none.description") })
      return
    }
    const latest = canvases.reduce((a, b) => (compareRefs(a.last, b.last) >= 0 ? a : b))
    if (canvases.length === 1) {
      env.openCanvas(session, latest.id)
      return
    }
    const picked = await ctx.dialogs.select({
      title: ctx.t("pick.title"),
      placeholder: ctx.t("pick.placeholder"),
      current: latest.id,
      options: canvases.map((canvas) => ({
        title: canvas.title ?? canvas.id,
        value: canvas.id,
        ...(canvas.title ? { description: canvas.id } : {}),
      })),
    })
    if (picked !== undefined && !ctx.signal.aborted) env.openCanvas(session, picked)
  }

  // Reads only the canvas ids (equality-guarded), so a streaming canvas does not contribute the item again each tick.
  ctx.add(MenuItem, () => {
    const session = ctx.sessions.current()
    const ids = session ? sessions.get(session).index.canvasIds() : []
    const opened = !!session && ids.length > 0 && ids.every((id) => ctx.layout.state(tabKey(id), session) !== "closed")
    return {
      menu: "session.panel" as const,
      id: "canvas",
      title: ctx.t("menu.canvas"),
      icon: "layout-right" as const,
      ...(ids.length > 0 ? { description: ctx.plural("menu.canvas.count", ids.length) } : {}),
      ...(opened ? { opened: true } : {}),
      run: () => void pickCanvas(),
    }
  })

  // ── Commands ──────────────────────────────────────────────────────────────────────────────────────────────────
  ctx.add(Command, () => ({
    id: "open-canvas",
    title: ctx.t("command.open"),
    group: ctx.t("command.group"),
    section: "session" as const,
    enabled: !!ctx.sessions.current(),
    run: () => pickCanvas(),
  }))

  ctx.add(Command, () => ({
    id: "rescan",
    title: ctx.t("command.rescan"),
    group: ctx.t("command.group"),
    section: "session" as const,
    enabled: !!ctx.sessions.current(),
    run: async () => {
      const session = ctx.sessions.current()
      if (!session) return
      const count = await sessions.get(session).rescan()
      if (ctx.signal.aborted) return
      ctx.toast.show({
        title: ctx.t("rescan.done"),
        description: ctx.plural("rescan.found", count),
        variant: "success",
      })
    },
  }))

  ctx.add(Command, () => ({
    id: "reset",
    title: ctx.t("command.reset"),
    group: ctx.t("command.group"),
    section: "session" as const,
    enabled: !!ctx.sessions.current(),
    run: async () => {
      const session = ctx.sessions.current()
      if (!session) return
      const ok = await ctx.dialogs.confirm({
        title: ctx.t("reset.title"),
        description: ctx.t("reset.description"),
        confirm: ctx.t("reset.confirm"),
        danger: true,
      })
      if (!ok || ctx.signal.aborted) return
      env.resetSurfaces(session)
      ctx.toast.show({ title: ctx.t("reset.done"), variant: "success" })
    },
  }))

  // ── Settings › genui ──────────────────────────────────────────────────────────────────────────────────────────
  ctx.add(SettingsPage, {
    id: ctx.id,
    get title() {
      return ctx.t("settings.title")
    },
    icon: "layout-right",
    get entries() {
      return [
        {
          id: `${ctx.id}-auto-open`,
          title: ctx.t("settings.autoOpen.title"),
          description: ctx.t("settings.autoOpen.description"),
        },
        {
          id: `${ctx.id}-confirm`,
          title: ctx.t("settings.confirm.title"),
          description: ctx.t("settings.confirm.description"),
        },
        {
          id: `${ctx.id}-images`,
          title: ctx.t("settings.images.title"),
          description: ctx.t("settings.images.description"),
        },
        { id: `${ctx.id}-instructions`, title: ctx.t("settings.instructions.title") },
        {
          id: `${ctx.id}-clear`,
          title: ctx.t("settings.clear.title"),
          description: ctx.t("settings.clear.description"),
        },
      ]
    },
    render: () => (
      <SettingsView
        env={env}
        prefs={() => host.prefs()}
        update={(mutate) => ctx.stores.prefs.update((draft) => void mutate(draft))}
      />
    ),
  })
}
