import { createStore, produce } from "solid-js/store"
import type { OpenOptions, PanelState } from "@opencode/plugin/gui"
import type { Backend } from "./storage.ts"

/** One session's side strip: panel keys (`${plugin}:${tab id}`) in strip order, the selection and the preview slot. */
export interface Strip {
  readonly keys: readonly string[]
  readonly active?: string
  readonly preview?: string
  /** The side region is open. */
  readonly open: boolean
}

const EMPTY: Strip = { keys: [], open: false }

export interface LayoutState {
  strip(session: string): Strip
  open(session: string, key: string, options?: OpenOptions): void
  /** Removes the key; returns whether it was in the strip. */
  remove(session: string, key: string): boolean
  select(session: string, key: string | undefined): void
  setOpen(session: string, open: boolean): void
  /** Keeps a double-clicked preview tab. */
  keep(session: string, key: string): void
  state(session: string, key: string): PanelState
  scroll: Map<string, { readonly x: number; readonly y: number }>
  widths: Map<string, number>
}

/** The side strips of every session, stored like the app's layout (so a reload keeps the open tabs). */
export function createLayoutState(backend: Backend): LayoutState {
  const [strips, setStrips] = createStore<Record<string, Strip>>({})

  const strip = (session: string): Strip => {
    const known = strips[session]
    if (known) return known
    const stored = backend.read(`layout.${session}`) as Strip | undefined
    // Seeding the store from a read is deferred so a reactive read never writes.
    if (stored && Array.isArray(stored.keys)) queueMicrotask(() => strips[session] || setStrips(session, stored))
    return stored && Array.isArray(stored.keys) ? stored : EMPTY
  }

  const edit = (session: string, mutate: (draft: { -readonly [K in keyof Strip]: Strip[K] }) => void) => {
    if (!strips[session]) setStrips(session, structuredClone({ ...strip(session), keys: [...strip(session).keys] }))
    setStrips(session, produce(mutate as (draft: Strip) => void))
    backend.write(`layout.${session}`, structuredClone({ ...strips[session]!, keys: [...strips[session]!.keys] }))
  }

  return {
    strip,
    open(session, key, options = {}) {
      const mode = options.tab ?? "open"
      edit(session, (draft) => {
        const keys = [...draft.keys]
        if (keys.includes(key)) {
          if (mode === "append") return
          draft.active = key
          draft.open = true
          if (mode === "preview") draft.preview = key
          return
        }
        if (mode === "append") {
          draft.keys = [...keys, key]
          return
        }
        if ((mode === "open" || mode === "preview") && draft.preview && keys.includes(draft.preview)) {
          keys[keys.indexOf(draft.preview)] = key
          draft.keys = keys
        } else draft.keys = [...keys, key]
        if (mode === "open") draft.preview = undefined
        if (mode === "preview") draft.preview = key
        draft.active = key
        draft.open = true
      })
    },
    remove(session, key) {
      const index = strip(session).keys.indexOf(key)
      if (index < 0) return false
      edit(session, (draft) => {
        const keys = draft.keys.filter((candidate) => candidate !== key)
        if (draft.active === key) draft.active = keys[index] ?? keys[index - 1]
        if (draft.preview === key) draft.preview = undefined
        draft.keys = keys
        if (keys.length === 0) draft.open = false
      })
      return true
    },
    select(session, key) {
      edit(session, (draft) => {
        draft.active = key
        if (key) draft.open = true
      })
    },
    setOpen(session, open) {
      edit(session, (draft) => {
        draft.open = open
      })
    },
    keep(session, key) {
      edit(session, (draft) => {
        if (draft.preview === key) draft.preview = undefined
      })
    },
    state(session, key) {
      const current = strip(session)
      // A pinned tab is selectable without being stored.
      if (!current.keys.includes(key) && current.active !== key) return "closed"
      if (current.active !== key) return "open"
      return current.open ? "visible" : "active"
    },
    scroll: new Map(),
    widths: new Map(),
  }
}
