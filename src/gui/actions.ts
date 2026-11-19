import { CONFIRM_PARAM, type ActionName } from "../catalog/actions.ts"
import { sanitizeId } from "../protocol/surface.ts"
import { safeUrl } from "../protocol/url.ts"
import { formatSentMessage } from "../shared/message.ts"
import type { Host, SurfaceContext } from "./host.ts"
import { allowOutward, hasUserGesture, openLink, type RequestedConfirm } from "./outward.ts"

/**
 * Thrown when an action does not run: the user declined its confirm, there was no user gesture, the rate limit hit, or
 * its input was refused. Throwing (rather than resolving) keeps json-render from running the binding's `onSuccess` and
 * the actions bound after it, as its own confirm dialog does on cancel. Components that fire events treat it as quiet.
 */
export class ActionRefused extends Error {
  override readonly name = "ActionRefused"
}

/** Whether an error only says that an action did not run (see `ActionRefused`). */
export const isRefusal = (error: unknown) => error instanceof Error && error.name === "ActionRefused"

export type ActionHandler = (params: Record<string, unknown>) => Promise<void>

export type Handlers = Record<ActionName, ActionHandler>

export interface HandlerOptions {
  /** Reads the surface's state, for `${/path}` placeholders in a requested confirm's text (as json-render's own). */
  readonly read?: (path: string) => unknown
}

/** Toasts a surface may show per window of time, so a `watch` loop cannot flood the corner of the window. */
export const TOAST_BURST = 3
export const TOAST_WINDOW_MS = 5000
/** Minimum time between two `openCanvas` actions of one surface. */
export const OPEN_CANVAS_INTERVAL_MS = 1000

const MAX_TITLE = 200
const MAX_MESSAGE = 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : ""

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

function interpolate(template: string, read: HandlerOptions["read"]): string {
  if (!read || !template.includes("${")) return template
  return template.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
    const value = read(path.trim())
    return value === undefined || value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value)
  })
}

/**
 * Reads the confirm a binding asked for, in whichever shape the model wrote it: json-render's `ActionConfirm` object
 * (`{ title, message, confirmLabel?, cancelLabel?, variant? }`), a string (the message), or `true` (a plain confirm).
 * `false`, null and anything else ask nothing.
 */
export function readConfirm(value: unknown, read?: HandlerOptions["read"]): RequestedConfirm | undefined {
  if (value === true) return {}
  if (typeof value === "string") {
    const message = clip(interpolate(value, read).trim(), MAX_MESSAGE)
    return message ? { message } : {}
  }
  if (!isRecord(value)) return undefined
  const field = (key: string, max: number) => {
    const raw = value[key]
    if (typeof raw !== "string") return undefined
    const result = clip(interpolate(raw, read).trim(), max)
    return result || undefined
  }
  const title = field("title", MAX_TITLE)
  const message = field("message", MAX_MESSAGE)
  const confirmLabel = field("confirmLabel", 40)
  const cancelLabel = field("cancelLabel", 40)
  const danger = value.variant === "danger" || value.danger === true
  return {
    ...(title ? { title } : {}),
    ...(message ? { message } : {}),
    ...(confirmLabel ? { confirmLabel } : {}),
    ...(cancelLabel ? { cancelLabel } : {}),
    ...(danger ? { danger: true } : {}),
  }
}

/** Splits the confirm the normalizer moved into `params[CONFIRM_PARAM]` from the action's own params. */
export function takeConfirm(
  params: unknown,
  read?: HandlerOptions["read"],
): { readonly params: Record<string, unknown>; readonly confirm: RequestedConfirm | undefined } {
  if (!isRecord(params)) return { params: {}, confirm: undefined }
  if (!Object.hasOwn(params, CONFIRM_PARAM)) return { params, confirm: undefined }
  const { [CONFIRM_PARAM]: requested, ...rest } = params
  return { params: rest, confirm: readConfirm(requested, read) }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "")

/**
 * The handlers of genui's custom actions for one surface. Outward actions (send, insert, open link, copy) go through
 * the outward gate: a user gesture, one per second per surface, and a confirm when the settings, the surface's trust or
 * the binding ask for one. `showToast` and `openCanvas` are rate limited, and ask first only when the binding has a
 * `confirm` (which then also needs a user gesture). A handler that does not run throws `ActionRefused`.
 */
export function createHandlers(host: Host, surface: SurfaceContext, options: HandlerOptions = {}): Handlers {
  const toastTimes: number[] = []
  let lastCanvas = 0

  const refuse = (reason: string): never => {
    throw new ActionRefused(reason)
  }

  // A confirm the binding asked for on an action that does not leave the surface. A dialog that pops up on its own
  // is hostile, so it needs a user gesture too.
  const confirmRequested = async (requested: RequestedConfirm, title: string, detail?: string) => {
    if (!hasUserGesture()) return false
    const notes = [requested.message, surface.trusted ? undefined : host.t("confirm.untrusted"), detail].filter(Boolean)
    return host.confirm({
      title: requested.title || title,
      ...(notes.length > 0 ? { description: notes.join("\n\n") } : {}),
      confirm: requested.confirmLabel || host.t("confirm.continue"),
      ...(requested.cancelLabel ? { cancel: requested.cancelLabel } : {}),
      ...(requested.danger ? { danger: true } : {}),
    })
  }

  const noSession = (): never => {
    host.toast({ title: host.t("action.noSession"), variant: "error" })
    return refuse("no session")
  }

  return {
    async sendPrompt(raw) {
      const { params, confirm } = takeConfirm(raw, options.read)
      const message = formatSentMessage(
        params.data === undefined ? { text: text(params.text) } : { text: text(params.text), data: params.data },
      )
      const send = surface.sendPrompt
      if (!send) return noSession()
      const ok = await allowOutward(host, surface, {
        title: host.t("confirm.send"),
        detail: message,
        confirmLabel: host.t("confirm.sendLabel"),
        ...(confirm ? { requested: confirm } : {}),
      })
      if (!ok) refuse("sendPrompt")
      try {
        await send(message)
      } catch (error) {
        const description = errorText(error)
        host.toast({ title: host.t("action.sendFailed"), ...(description ? { description } : {}), variant: "error" })
        throw error
      }
    },

    async insertPrompt(raw) {
      const { params, confirm } = takeConfirm(raw, options.read)
      const value = text(params.text)
      if (!value.trim()) refuse("insertPrompt: no text")
      const insert = surface.insertPrompt
      if (!insert) return noSession()
      const ok = await allowOutward(host, surface, {
        title: host.t("confirm.insert"),
        detail: value,
        confirmLabel: host.t("confirm.insertLabel"),
        ...(confirm ? { requested: confirm } : {}),
      })
      if (!ok) refuse("insertPrompt")
      insert(value)
    },

    async openLink(raw) {
      const { params, confirm } = takeConfirm(raw, options.read)
      const url = safeUrl(params.url, "link")
      if (!url) {
        host.toast({ title: host.t("action.linkBlocked"), variant: "error" })
        return refuse("openLink: refused URL")
      }
      if (!(await openLink(host, surface, url, confirm))) refuse("openLink")
    },

    async copyText(raw) {
      const { params, confirm } = takeConfirm(raw, options.read)
      const value = text(params.text)
      const label = clip(text(params.label).trim(), 60)
      const ok = await allowOutward(host, surface, {
        title: host.t("confirm.copy"),
        detail: value,
        confirmLabel: host.t("confirm.copyLabel"),
        ...(confirm ? { requested: confirm } : {}),
      })
      if (!ok) refuse("copyText")
      try {
        await host.copy(value)
      } catch (error) {
        host.toast({ title: host.t("action.copyFailed"), variant: "error" })
        throw error
      }
      host.toast({
        title: label ? host.t("action.copiedLabel", { label }) : host.t("action.copied"),
        variant: "success",
      })
    },

    async showToast(raw) {
      const { params, confirm } = takeConfirm(raw, options.read)
      const title = clip(text(params.title).trim(), MAX_TITLE)
      if (!title) refuse("showToast: no title")
      const now = Date.now()
      while (toastTimes.length > 0 && now - toastTimes[0]! >= TOAST_WINDOW_MS) toastTimes.shift()
      if (toastTimes.length >= TOAST_BURST) refuse("showToast: rate limited")
      toastTimes.push(now)
      const description = clip(text(params.description).trim(), MAX_MESSAGE)
      if (confirm && !(await confirmRequested(confirm, host.t("confirm.toast"), title))) refuse("showToast")
      const variant = params.variant === "success" || params.variant === "error" ? params.variant : "default"
      host.toast({ title, ...(description ? { description } : {}), variant })
    },

    async openCanvas(raw) {
      const { params, confirm } = takeConfirm(raw, options.read)
      const id = sanitizeId(params.canvas)
      if (!id) refuse("openCanvas: no canvas id")
      const open = surface.openCanvas
      if (!open) return noSession()
      const now = Date.now()
      if (now - lastCanvas < OPEN_CANVAS_INTERVAL_MS) refuse("openCanvas: rate limited")
      lastCanvas = now
      if (confirm && !(await confirmRequested(confirm, host.t("confirm.openCanvas", { canvas: id! })))) {
        refuse("openCanvas")
      }
      open(id!)
    },
  }
}
