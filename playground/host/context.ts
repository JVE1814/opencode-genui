import { createSignal, untrack } from "solid-js"
import { createStore, produce, type Store as SolidStore } from "solid-js/store"
import {
  Command,
  LinkHandler,
  MenuItem,
  type Cleanup,
  type Context,
  type Contract,
  type Ipc,
  type Layout,
  type Link,
  type Live,
  type Params,
  type Persisted,
  type Plugin,
  type PluginOptions,
  type Registry,
  type SessionPanelMenuItem,
  type SessionRef,
  type SetupContext,
  type StoreDeclaration,
  type Token,
} from "@opencode/plugin/gui"
import { liveAccessor } from "../fake-sdk/internal.ts"
import type { App } from "./app.ts"
import type { Lifetime } from "./registry.ts"
import type { Region } from "./region.ts"
import { createPersisted, storeKey } from "./storage.ts"
import { notImplemented, unimplemented } from "./stub.ts"
import { ui } from "./ui.tsx"

/** The app's shared copy that `ctx.t` falls back to (`common.*`). */
const COMMON: Record<string, string> = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.confirm": "Confirm",
  "common.copy": "Copy",
  "common.delete": "Delete",
  "common.done": "Done",
  "common.ok": "OK",
  "common.open": "Open",
  "common.save": "Save",
  "common.search": "Search",
  "common.settings": "Settings",
  "common.submit": "Submit",
}

export function interpolate(template: string, params: Params | undefined): string {
  if (!params) return template
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** Display keys for a chord in keybind syntax, as the app shows them on Linux. */
export function keysOf(bind: string): string[] {
  const names: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: "Super" }
  return bind
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(
      (part) =>
        names[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)),
    )
}

function matchesBind(bind: string, event: KeyboardEvent): boolean {
  const parts = bind.toLowerCase().split("+")
  const key = parts.at(-1)
  const want = new Set(parts.slice(0, -1))
  const mod = want.has("mod") || want.has("ctrl")
  return (
    event.key.toLowerCase() === key &&
    event.ctrlKey === mod &&
    event.shiftKey === want.has("shift") &&
    event.altKey === want.has("alt") &&
    event.metaKey === want.has("meta")
  )
}

export interface PluginInstance {
  readonly id: string
  readonly context: SetupContext<Plugin.Definition>
  readonly dispose: () => void
}

/**
 * Builds the window context a plugin's `setup` receives (`SetupContext`), over the fake app. Every member the genui
 * plugin uses is implemented; the rest throw a clear "not implemented" error when called.
 */
export function createPluginContext(input: {
  readonly app: App
  readonly region: Region
  readonly id: string
  readonly definition: Plugin.Definition
  readonly options: PluginOptions
  readonly lifetime: Lifetime
  readonly signal: AbortSignal
}): SetupContext<Plugin.Definition> {
  const { app, region, id, definition } = input
  const contracts = new Map<string, unknown>()
  const [contractVersion, setContractVersion] = createSignal(0)
  const memories = new Map<string, readonly [SolidStore<object>, (mutation: (draft: object) => void) => void]>()
  const runtimeStores = new Map<string, Persisted<unknown>>()

  const catalog = (locale: string) => definition.i18n?.[locale] ?? definition.i18n?.[locale.split("-")[0]!]

  const t = (key: string, params?: Params) => {
    const template = catalog(app.locale)?.[key] ?? definition.i18n?.en[key] ?? COMMON[key] ?? key
    return interpolate(template, params)
  }

  const add = <T>(registry: Registry<T>, item: T | (() => T | undefined)): Cleanup =>
    app.contributions.add(id, registry, item, input.lifetime)

  const published = (command: string) =>
    untrack(() => app.contributions.items(Command)).find((item) => `${item.plugin}.${item.value.id}` === command)

  const stores: Record<string, unknown> = {}
  for (const [name, declaration] of Object.entries(definition.stores ?? {}) as [string, StoreDeclaration][]) {
    if (declaration.scope === "global") {
      stores[name] = createPersisted({
        backend: app.backend,
        key: storeKey(id, name),
        schema: declaration.schema,
        initial: declaration.initial,
        from: declaration.from,
        loaded: true,
      })
      continue
    }
    const perSession = new Map<string, Persisted<unknown>>()
    stores[name] = (session: SessionRef) => {
      if (!session || typeof session.key !== "string") throw new Error(`ctx.stores.${name}: pass a SessionRef`)
      let persisted = perSession.get(session.key)
      if (!persisted) {
        persisted = createPersisted({
          backend: app.backend,
          key: storeKey(id, name, session.key),
          schema: declaration.schema,
          initial: declaration.initial,
          from: declaration.from,
          loaded: false,
        })
        perSession.set(session.key, persisted)
      }
      return persisted
    }
  }

  const strip = (session: SessionRef) => app.layout.strip(session.key)

  const closeTab = (key: string, session: SessionRef) => {
    const entry =
      session.key === untrack(app.sessions.current).key
        ? untrack(region.entries).find((candidate) => candidate.key === key)
        : undefined
    if (!app.layout.remove(session.key, key) || !entry?.panel.close) return
    try {
      entry.panel.close({ ...region.props(() => entry), tab: entry.tab })
    } catch (error) {
      app.fail(entry.plugin, `Panel ${entry.panel.id} close`, error)
    }
  }

  const layout: Layout = {
    narrow: () => false,
    ready: app.mounted,
    open: (key, session, options) => app.whenMounted(() => app.layout.open(session.key, key, options)),
    close: (key, session) => app.whenMounted(() => closeTab(key, session)),
    toggle: (key, session) =>
      app.whenMounted(() => {
        if (app.layout.state(session.key, key) === "visible") closeTab(key, session)
        else app.layout.open(session.key, key)
      }),
    hide: (key, session) =>
      app.whenMounted(() => {
        if (app.layout.state(session.key, key) === "visible") app.layout.setOpen(session.key, false)
      }),
    state: (key, session) => (app.mounted() ? app.layout.state(session.key, key) : "closed"),
    stored: (session) => (app.mounted() ? region.stored(id, session.key) : []),
    side: {
      opened: (session) => app.mounted() && strip(session).open,
      toggle: (session) => app.whenMounted(() => app.layout.setOpen(session.key, !strip(session).open)),
      menu: () =>
        app.mounted()
          ? app.contributions
              .items(MenuItem)
              .map((item) => item.value)
              .filter((item): item is SessionPanelMenuItem => item.menu === "session.panel")
              .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))
          : [],
      width: (panel) => app.layout.widths.get(`${id}:${panel}`),
      resize: (panel, width) => void app.layout.widths.set(`${id}:${panel}`, width),
    },
    sidebar: { opened: () => true },
    scroll: {
      get: (session, key) => app.layout.scroll.get(`${session.key}\n${key}`),
      set: (session, key, value) => void app.layout.scroll.set(`${session.key}\n${key}`, { ...value }),
    },
    settings: (page) => app.whenMounted(() => app.openSettings(page)),
    project: notImplemented("ctx.layout.project"),
    draft: (draft) => console.info("[playground] ctx.layout.draft", draft),
  }

  const linkHandler = (link: Link) =>
    app.contributions
      .items(LinkHandler)
      .filter((item) => {
        try {
          return item.value.match(link)
        } catch {
          return false
        }
      })
      .toSorted((a, b) => (b.value.priority ?? 0) - (a.value.priority ?? 0))[0]

  const context = {
    id,
    options: input.options,
    signal: input.signal,
    get client() {
      return app.server.ref.client
    },
    add,
    list: <T>(registry: Registry<T>) => app.contributions.items(registry).map((item) => item.value),
    t,
    plural(key: string, count: number, params?: Params) {
      const category = new Intl.PluralRules(app.locale).select(count)
      const full = { ...params, count }
      const exact = `${key}.${category}`
      const template = catalog(app.locale)?.[exact] ?? definition.i18n?.en[exact] ?? definition.i18n?.en[`${key}.other`]
      return template === undefined ? t(`${key}.other`, full) : interpolate(template, full)
    },
    provide<C extends Contract<unknown>>(token: C, impl: unknown): Cleanup {
      if ((token as { kind: string }).kind === "ipc") throw new Error("An Ipc is provided by the main entry")
      if (token.id !== id && !token.id.startsWith(`${id}.`))
        throw new Error(`Plugin ${id} cannot provide contract ${token.id}`)
      contracts.set(token.id, impl)
      setContractVersion((version) => version + 1)
      return () => {
        if (contracts.get(token.id) !== impl) return
        contracts.delete(token.id)
        setContractVersion((version) => version + 1)
      }
    },
    use<T extends Token>(token: T) {
      return liveAccessor((): Live<never> => {
        contractVersion()
        if (token.kind === "contract" && contracts.has(token.id))
          return { status: "active", value: contracts.get(token.id) as never, generation: 1 }
        return { status: "inactive", reason: "disabled" }
      })
    },
    main(token: Ipc) {
      return new Proxy(
        {},
        {
          get(_, key) {
            if (key === "then" || typeof key === "symbol") return undefined
            if (key === "state") return () => undefined
            if (key === "on") return () => () => {}
            return () => Promise.reject(new Error(`The playground runs no main process (ctx.main(${token.id}).${key})`))
          },
        },
      )
    },
    layout,
    sessions: {
      list: () => (app.mounted() ? app.sessions.all.map((session) => session.ref) : []),
      current: () => (app.mounted() ? app.sessions.current() : undefined),
    },
    screen: { current: () => (app.mounted() ? app.sessions.screen : undefined) },
    storage: {
      store(
        key: string,
        options: { schema: never; initial: unknown; scope?: unknown; from?: string | readonly string[] },
      ) {
        const scope =
          options.scope === undefined || options.scope === "global"
            ? undefined
            : typeof options.scope === "object" && options.scope && "session" in options.scope
              ? (options.scope as { session: SessionRef }).session.key
              : JSON.stringify(options.scope)
        const full = storeKey(id, key, scope)
        let persisted = runtimeStores.get(full)
        if (!persisted) {
          persisted = createPersisted({
            backend: app.backend,
            key: full,
            schema: options.schema,
            initial: options.initial,
            from: options.from,
            loaded: scope === undefined,
          })
          runtimeStores.set(full, persisted)
        }
        return persisted
      },
      memory(key: string, options: { initial: object }) {
        let memory = memories.get(key)
        if (!memory) {
          const [store, setStore] = createStore(structuredClone(options.initial))
          memory = [store, (mutation) => setStore(produce(mutation))] as const
          memories.set(key, memory)
        }
        return memory
      },
      remove(key: string) {
        app.backend.remove(storeKey(id, key))
        runtimeStores.delete(storeKey(id, key))
      },
    },
    system: {
      async copy(text: string) {
        app.records.copies.push(String(text))
        await navigator.clipboard?.writeText(String(text)).catch(() => {})
      },
      async save(file: { name: string; content: string }) {
        app.records.saves.push({ name: file.name, content: file.content })
        return true
      },
      // Recorded, not opened: the playground never navigates away.
      openExternal: (url: string) => void app.records.opened.push(String(url)),
    },
    desktop: {
      os: "linux",
      zoom: () => 1,
      launch: notImplemented("ctx.desktop.launch"),
      reveal: async () => false,
      installed: async () => false,
      pick: async () => [],
    },
    dialogs: {
      open: (render: never, options?: { replace?: boolean }) => app.dialogs.open(id, render, options),
      active: () => app.dialogs.list().length > 0,
      confirm: (options: never) => app.dialogs.confirm(options),
      alert: (options: never) => app.dialogs.alert(options),
      prompt: (options: never) => app.dialogs.prompt(options),
      select: (options: never) => app.dialogs.select(options),
    },
    toast: { show: (options: never) => app.toasts.show(id, options) },
    tabs: {
      list: () =>
        app.sessions.all.map((session) => ({
          key: session.ref.tab,
          session: session.ref,
          active: session.ref.key === app.sessions.current().key,
        })),
      open(target: { server: string; id: string }, options?: { focus?: boolean }) {
        const session = app.sessions.all.find((item) => item.ref.id === target.id)
        if (session && options?.focus) app.sessions.route(session.ref.key)
      },
      focus(key: string) {
        const session = app.sessions.all.find((item) => item.ref.tab === key)
        if (session) app.sessions.route(session.ref.key)
      },
      move: () => {},
      close: notImplemented("ctx.tabs.close"),
    },
    attention: {
      async notify(options: unknown) {
        app.records.notifications.push(structuredClone(options))
        return { notification: false, sound: false }
      },
    },
    commands: {
      run(command: string) {
        const item = published(command)
        if (!app.mounted() || !item || item.value.enabled === false) return false
        void Promise.try(() => item.value.run()).catch((error: unknown) =>
          app.fail(item.plugin, `Command ${command}`, error),
        )
        return true
      },
    },
    links: {
      open(link: Link) {
        app.records.links.push({ ...link, session: link.session?.key })
        const handler = linkHandler(link)
        if (!handler) return false
        handler.value.open(link)
        return true
      },
      exists: (link: Link) => untrack(() => linkHandler(link))?.value.exists?.(link) ?? false,
    },
    embeds: unimplemented({}, "ctx.embeds"),
    ui,
    app: { name: "opencode", version: "2.3.2", channel: "local", platform: "desktop", packaged: false },
    locale: { locale: () => app.locale, direction: () => "ltr" },
    appearance: { font: () => "ui-monospace, SFMono-Regular, Menlo, monospace", mode: app.mode },
    router: {
      routing: () => false,
      path: () =>
        !app.mounted()
          ? ""
          : app.view() === "settings"
            ? `/settings?tab=${app.settingsPage() ?? "general"}`
            : `/session/${app.sessions.current().id}`,
    },
    keybinds: {
      keybind(command: string) {
        const bind = app.contributions.items(Command).find((item) => `${item.plugin}.${item.value.id}` === command)
          ?.value.bind
        return bind ? keysOf(bind) : []
      },
      keys: keysOf,
      matches(command: string, event: KeyboardEvent) {
        const bind = published(command)?.value.bind
        return !!bind && matchesBind(bind, event)
      },
    },
    servers: {
      list: () => [app.server.ref.id],
      get: (server: string) => (server === app.server.ref.id ? app.server.ref : undefined),
    },
    workspaces: { on: () => () => {} },
    stores,
  }

  return context as unknown as SetupContext<Plugin.Definition> & Context
}
