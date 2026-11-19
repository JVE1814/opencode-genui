import { createContext, useContext } from "solid-js"
import type { Ui } from "@opencode/plugin/gui"

/**
 * Everything the generated UI needs from the app. src/gui.tsx adapts the plugin context to it; the playground and tests
 * provide their own. Components reach it with `useHost()`, never through the plugin context directly, so the app's
 * experimental API stays behind this one seam.
 */
export interface Host {
  /** The app's own components (`ctx.ui`), used wherever one exists so the UI looks and behaves native. */
  readonly ui: Ui
  /** Translated chrome copy (`ctx.t`), keys from src/gui/i18n/en.ts. */
  t(key: string, params?: Record<string, string | number | boolean>): string
  /** The app's color scheme. */
  mode(): "light" | "dark"
  confirm(options: {
    readonly title: string
    readonly description?: string
    readonly confirm?: string
    readonly cancel?: string
    readonly danger?: boolean
  }): Promise<boolean>
  toast(options: {
    readonly title: string
    readonly description?: string
    readonly variant?: "default" | "success" | "error"
  }): void
  copy(text: string): Promise<void>
  openExternal(url: string): void
  /** User preferences from the settings page. */
  prefs(): Prefs
}

export interface Prefs {
  /** How a new canvas in a live turn opens: `select` focuses its tab, `append` adds it quietly, `off` does nothing. */
  readonly autoOpen: "select" | "append" | "off"
  /** When outward actions (send, insert, open link, copy) ask first. */
  readonly confirmActions: "always" | "untrusted" | "never"
  /** Whether images from http(s) URLs load without a click. */
  readonly remoteImages: boolean
}

export const DEFAULT_PREFS: Prefs = { autoOpen: "select", confirmActions: "untrusted", remoteImages: false }

/**
 * One rendered surface: an inline block or a canvas. Actions use it to reach the session the surface belongs to.
 */
export interface SurfaceContext {
  readonly kind: "inline" | "canvas"
  /** The surface's id: the canvas id, or the inline block's header id or hash. */
  readonly id: string
  /** The surface's title, for confirmations and the messages it sends. */
  readonly title?: string
  /** False for a block that is not in the session's assistant messages (tool output, a file preview). */
  readonly trusted: boolean
  /** Sends a user message to the session. Undefined outside a session. */
  readonly sendPrompt?: (text: string) => Promise<void>
  /** Puts text in the session's composer. Undefined outside a session. */
  readonly insertPrompt?: (text: string) => void
  /** Opens a canvas of the session. Undefined outside a session. */
  readonly openCanvas?: (id: string) => void
}

export const HostContext = createContext<Host>()
export const SurfaceInfoContext = createContext<SurfaceContext>()

export function useHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error("genui: useHost outside a HostContext provider")
  return host
}

export function useSurface(): SurfaceContext | undefined {
  return useContext(SurfaceInfoContext)
}
