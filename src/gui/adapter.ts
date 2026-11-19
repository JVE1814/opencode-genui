import type { Context } from "@opencode/plugin/gui"
import { DEFAULT_PREFS, type Host, type Prefs } from "./host.ts"

/** The parts of the plugin context the host adapter reads. */
export type HostSource = Pick<Context, "ui" | "t" | "appearance" | "dialogs" | "toast" | "system">

const AUTO_OPEN: ReadonlySet<Prefs["autoOpen"]> = new Set(["select", "append", "off"])
const CONFIRM: ReadonlySet<Prefs["confirmActions"]> = new Set(["always", "untrusted", "never"])

/**
 * The stored preferences over the defaults, field by field: the store's schema already decodes them, but a value from
 * an older version or a hand-edited file must not break the UI.
 */
export function mergePrefs(stored: unknown): Prefs {
  const raw = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {}
  return {
    autoOpen: AUTO_OPEN.has(raw.autoOpen as Prefs["autoOpen"])
      ? (raw.autoOpen as Prefs["autoOpen"])
      : DEFAULT_PREFS.autoOpen,
    confirmActions: CONFIRM.has(raw.confirmActions as Prefs["confirmActions"])
      ? (raw.confirmActions as Prefs["confirmActions"])
      : DEFAULT_PREFS.confirmActions,
    remoteImages: typeof raw.remoteImages === "boolean" ? raw.remoteImages : DEFAULT_PREFS.remoteImages,
  }
}

/**
 * Adapts the plugin context to the `Host` seam the generated UI uses. Every member reads the context when called, so
 * the locale, color scheme and preferences stay live.
 */
export function createHostAdapter(ctx: HostSource, prefs: () => unknown): Host {
  return {
    ui: ctx.ui,
    t: (key, params) => ctx.t(key, params),
    mode: () => ctx.appearance.mode(),
    confirm: (options) => ctx.dialogs.confirm(options),
    toast: (options) => void ctx.toast.show(options),
    copy: (text) => ctx.system.copy(text),
    openExternal: (url) => ctx.system.openExternal(url),
    prefs: () => mergePrefs(prefs()),
  }
}
