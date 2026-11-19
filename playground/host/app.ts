import { createSignal, getOwner, onCleanup, runWithOwner, type Accessor, type JSX } from "solid-js"
import type {
  AlertOptions,
  ConfirmOptions,
  Context,
  DialogHandle,
  PromptOptions,
  SelectOptions,
  ToastHandle,
  ToastOptions,
} from "@opencode/plugin/gui"
import { createContributions, type Contributions } from "./registry.ts"
import { createLayoutState, type LayoutState } from "./layout.ts"
import { createFakeServer, type FakeServer } from "./server.ts"
import { createSessions, type Sessions } from "./sessions.ts"
import { createBackend, type Backend } from "./storage.ts"
import { alertDialog, confirmDialog, promptDialog, selectDialog } from "./dialogs.tsx"

export interface ToastView {
  readonly id: number
  readonly plugin: string
  readonly options: ToastOptions
}

/** A dialog on the stack: a plugin's own render, or one of the host's question dialogs. */
export interface DialogView {
  readonly id: number
  readonly plugin?: string
  readonly render: (handle: DialogHandle) => JSX.Element
  readonly handle: DialogHandle
  /** Called when the dialog closes any way other than its own buttons (Escape, backdrop, replaced). */
  readonly dismiss: () => void
}

export interface ConfirmRecord extends ConfirmOptions {
  readonly answer: boolean | null
}

export interface ErrorRecord {
  readonly plugin: string
  readonly where: string
  readonly message: string
}

/** What the playground records for tests (`window.__genui`). */
export interface Records {
  readonly toasts: ToastOptions[]
  readonly confirms: ConfirmRecord[]
  readonly alerts: AlertOptions[]
  readonly copies: string[]
  readonly opened: string[]
  readonly saves: { readonly name: string; readonly content: string }[]
  readonly notifications: unknown[]
  readonly links: unknown[]
  readonly errors: ErrorRecord[]
}

/** The fake desktop app: the server, the session shell, the side layout, and the services plugins call. */
export interface App {
  readonly backend: Backend
  readonly server: FakeServer
  readonly sessions: Sessions
  readonly layout: LayoutState
  readonly contributions: Contributions
  readonly records: Records
  readonly locale: string
  /** The app interface has mounted: before that, `sessions.current()` is undefined and layout writes wait. */
  readonly mounted: Accessor<boolean>
  setMounted(): void
  /** Runs `write` now if the interface has mounted, else once it does (in call order). */
  whenMounted(write: () => void): void
  readonly mode: Accessor<"light" | "dark">
  setMode(mode: "light" | "dark"): void
  readonly view: Accessor<"session" | "settings">
  readonly settingsPage: Accessor<string | undefined>
  openSettings(page?: string): void
  closeSettings(): void
  readonly palette: Accessor<boolean>
  setPalette(open: boolean): void
  /** Timeline rows are "off screen": code block content unmounts, as when the user scrolls away. */
  readonly virtualized: Accessor<boolean>
  setVirtualized(on: boolean): void
  /** Each plugin's context by id, for rendering its contributions. */
  readonly contexts: Accessor<Readonly<Record<string, Context>>>
  setContext(plugin: string, context: Context | undefined): void
  fail(plugin: string, where: string, error: unknown): void
  readonly toasts: {
    readonly list: Accessor<readonly ToastView[]>
    show(plugin: string, options: ToastOptions): ToastHandle
    dismiss(id: number): void
    dismissPlugin(plugin: string): void
  }
  readonly dialogs: {
    readonly list: Accessor<readonly DialogView[]>
    open(
      plugin: string | undefined,
      render: (handle: DialogHandle) => JSX.Element,
      options?: { replace?: boolean },
    ): DialogHandle
    confirm(options: ConfirmOptions): Promise<boolean>
    alert(options: AlertOptions): Promise<void>
    prompt(options: PromptOptions): Promise<string | undefined>
    select<T>(options: SelectOptions<T>): Promise<T | undefined>
    /** A scripted answer for confirm dialogs (tests); null shows the dialog and waits for a click. */
    answer: boolean | null
  }
}

export interface AppOptions {
  readonly persist: boolean
  readonly window: number
  readonly locale: string
  readonly mode: "light" | "dark"
}

export function createApp(options: AppOptions): App {
  const backend = createBackend(options.persist)
  const server = createFakeServer({ window: options.window })
  const sessions = createSessions(server, { ids: ["ses_playground_a", "ses_playground_b"] })
  const records: Records = {
    toasts: [],
    confirms: [],
    alerts: [],
    copies: [],
    opened: [],
    saves: [],
    notifications: [],
    links: [],
    errors: [],
  }

  const [mounted, setMountedSignal] = createSignal(false)
  const waiting: (() => void)[] = []
  const [mode, setMode] = createSignal(options.mode)
  const [view, setView] = createSignal<"session" | "settings">("session")
  const [settingsPage, setSettingsPage] = createSignal<string>()
  const [palette, setPalette] = createSignal(false)
  const [virtualized, setVirtualized] = createSignal(false)
  const [contexts, setContexts] = createSignal<Readonly<Record<string, Context>>>({})
  const [toasts, setToasts] = createSignal<readonly ToastView[]>([])
  const [dialogs, setDialogs] = createSignal<readonly DialogView[]>([])
  let ids = 0

  const dismissToast = (id: number) => setToasts((list) => list.filter((toast) => toast.id !== id))

  const closeDialog = (id: number) => setDialogs((list) => list.filter((dialog) => dialog.id !== id))

  const openDialog: App["dialogs"]["open"] = (plugin, render, openOptions) => {
    const id = ++ids
    let closed = false
    let onDismiss = () => {}
    const handle: DialogHandle = {
      close() {
        if (closed) return
        closed = true
        closeDialog(id)
      },
    }
    if (openOptions?.replace) for (const dialog of dialogs()) dialog.dismiss()
    const view: DialogView = {
      id,
      plugin,
      render,
      handle,
      dismiss: () => {
        onDismiss()
        handle.close()
      },
    }
    // A dialog closes with the owner that opened it.
    const owner = getOwner()
    if (owner) runWithOwner(owner, () => onCleanup(() => view.dismiss()))
    setDialogs((list) => [...list, view])
    return Object.assign(handle, {
      onDismiss(callback: () => void) {
        onDismiss = callback
      },
    })
  }

  const question = <T>(fallback: T, render: (resolve: (value: T) => void, handle: DialogHandle) => JSX.Element) =>
    new Promise<T>((resolve) => {
      let settled = false
      const finish = (value: T) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const handle = openDialog(undefined, (dialog) =>
        render((value) => {
          finish(value)
          dialog.close()
        }, dialog),
      ) as DialogHandle & { onDismiss(callback: () => void): void }
      handle.onDismiss(() => finish(fallback))
    })

  const app: App = {
    backend,
    server,
    sessions,
    layout: createLayoutState(backend),
    contributions: createContributions(),
    records,
    locale: options.locale,
    mounted,
    setMounted() {
      setMountedSignal(true)
      for (const write of waiting.splice(0)) write()
    },
    whenMounted(write) {
      if (mounted()) write()
      else waiting.push(write)
    },
    mode,
    setMode,
    view,
    settingsPage,
    openSettings(page) {
      setSettingsPage(page)
      setView("settings")
    },
    closeSettings: () => setView("session"),
    palette,
    setPalette,
    virtualized,
    setVirtualized,
    contexts,
    setContext(plugin, context) {
      setContexts((current) => {
        const next = { ...current }
        if (context) next[plugin] = context
        else delete next[plugin]
        return next
      })
    },
    fail(plugin, where, error) {
      const message = error instanceof Error ? error.message : String(error)
      records.errors.push({ plugin, where, message })
      console.error(`[plugin ${plugin}] ${where}:`, error)
    },
    toasts: {
      list: toasts,
      show(plugin, toastOptions) {
        records.toasts.push(
          structuredClone({ ...toastOptions, actions: toastOptions.actions?.map((a) => a.label) }) as never,
        )
        const same = toasts().find(
          (toast) =>
            toast.plugin === plugin &&
            toast.options.title === toastOptions.title &&
            toast.options.description === toastOptions.description &&
            toast.options.variant === toastOptions.variant,
        )
        if (same) dismissToast(same.id)
        const id = ++ids
        setToasts((list) => [...list, { id, plugin, options: toastOptions }])
        if (!toastOptions.persistent) setTimeout(() => dismissToast(id), toastOptions.duration ?? 5000)
        return { dismiss: () => dismissToast(id) }
      },
      dismiss: dismissToast,
      dismissPlugin: (plugin) => setToasts((list) => list.filter((toast) => toast.plugin !== plugin)),
    },
    dialogs: {
      list: dialogs,
      open: openDialog,
      answer: null,
      confirm(confirmOptions) {
        const scripted = app.dialogs.answer
        if (scripted !== null) {
          records.confirms.push({ ...confirmOptions, answer: scripted })
          return Promise.resolve(scripted)
        }
        return question(false, (resolve) => confirmDialog(confirmOptions, resolve)).then((answer) => {
          records.confirms.push({ ...confirmOptions, answer })
          return answer
        })
      },
      alert(alertOptions) {
        records.alerts.push({ ...alertOptions })
        return question(undefined, (resolve) => alertDialog(alertOptions, () => resolve(undefined)))
      },
      prompt: (promptOptions) =>
        question<string | undefined>(undefined, (resolve) => promptDialog(promptOptions, resolve)),
      select: <T>(selectOptions: SelectOptions<T>) =>
        question<T | undefined>(undefined, (resolve) => selectDialog(selectOptions, resolve)),
    },
  }
  return app
}
