import type { ActionBinding } from "@json-render/core"
import {
  CONFIRM_PARAM,
  ON_ERROR_PARAM,
  ON_SUCCESS_PARAM,
  PASSIVE_PARAM,
  RESERVED_PARAMS,
  type ActionName,
} from "../catalog/actions.ts"
import { normalizeChained } from "../protocol/normalize.ts"
import { sanitizeId } from "../protocol/surface.ts"
import { safeUrl } from "../protocol/url.ts"
import { formatSentMessage } from "../shared/message.ts"
import type { Host, SurfaceContext } from "./host.ts"
import {
  allowOutward,
  confirmIntent,
  confirmOptions,
  hasIntent,
  hasUserGesture,
  openLink,
  type RequestedConfirm,
} from "./outward.ts"

/**
 * Thrown when an action does not run: the user declined its confirm, it was not the result of an activation, the rate
 * limit hit, or its input was refused. A refusal is not a failure: it never runs the binding's onError (nor onSuccess),
 * and it stops the rest of the binding's chain, as json-render's own confirm dialog does on cancel. Components that fire
 * events treat it as quiet.
 *
 * How: the normalizer moves a custom action's onSuccess/onError into reserved params (src/protocol/normalize.ts), so
 * json-render's executeAction sees neither. A refusal thrown here then propagates through executeAction and execute
 * into the element's emit loop, which stops; genui's handler runs onSuccess after a success and onError after a genuine
 * failure itself.
 */
export class ActionRefused extends Error {
  override readonly name = "ActionRefused"
}

/** Whether an error only says that an action did not run (see `ActionRefused`). */
export const isRefusal = (error: unknown) => error instanceof Error && error.name === "ActionRefused"

export type ActionHandler = (params: Record<string, unknown>) => Promise<void>

export type Handlers = Record<ActionName, ActionHandler>

/** An action binding as json-render's `execute` takes it. */
export type Binding = ActionBinding

/**
 * json-render's own `execute` and state `set` for chained handlers, connected from inside the provider by
 * `ChainBridge` (src/gui/chain.ts): a chained action then runs exactly as a bound one (built-ins included), and a `set`
 * reaches watches.
 */
export interface ChainLink {
  execute?: (binding: Binding) => Promise<void>
  set?: (path: string, value: unknown) => void
}

export interface HandlerOptions {
  /** Reads the surface's state, for `${/path}` placeholders in a requested confirm's text (as json-render's own). */
  readonly read?: (path: string) => unknown
  /** Where onSuccess/onError handlers run (see ChainLink). Without it, chained actions and sets are skipped. */
  readonly link?: ChainLink
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

/** An action's own params, and what the normalizer put in its reserved params (see src/catalog/actions.ts). */
export interface Reserved {
  readonly params: Record<string, unknown>
  readonly confirm: RequestedConfirm | undefined
  /** Where the binding runs when that is not an activation (`watch["/q"]`, `on.blur`); outward actions refuse. */
  readonly passive: string | undefined
  readonly onSuccess: unknown
  readonly onError: unknown
}

/** Splits the reserved params the normalizer added (confirm, chains, passive tag) from the action's own params. */
export function takeReserved(params: unknown, read?: HandlerOptions["read"]): Reserved {
  if (!isRecord(params))
    return { params: {}, confirm: undefined, passive: undefined, onSuccess: undefined, onError: undefined }
  if (!RESERVED_PARAMS.some((key) => Object.hasOwn(params, key)))
    return { params, confirm: undefined, passive: undefined, onSuccess: undefined, onError: undefined }
  const own: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) if (!RESERVED_PARAMS.includes(key)) own[key] = value
  const passive = params[PASSIVE_PARAM]
  return {
    params: own,
    confirm: readConfirm(params[CONFIRM_PARAM], read),
    passive: passive === undefined || passive === null || passive === false ? undefined : String(passive),
    onSuccess: params[ON_SUCCESS_PARAM],
    onError: params[ON_ERROR_PARAM],
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : typeof error === "string" ? error : "")

/**
 * The handlers of genui's custom actions for one surface.
 *
 * - Outward actions (send, insert, open link, copy) go through the outward gate (src/gui/outward.ts): they run only as
 *   the result of an activation of a control in this surface, a few per activation, one activation per second, with a
 *   confirm when the settings, the surface's trust or the binding ask for one. In a passive binding (watch, on.focus,
 *   on.blur, ...) they are refused outright.
 * - `showToast` and `openCanvas` are rate limited, and ask first only when the binding has a `confirm`, which then also
 *   needs an activation.
 * - A handler that does not run throws `ActionRefused`; onSuccess runs after a success, onError after a genuine failure
 *   (which it then handles, so the binding's chain goes on, as in json-render).
 */
export function createHandlers(host: Host, surface: SurfaceContext, options: HandlerOptions = {}): Handlers {
  const toastTimes: number[] = []
  let lastCanvas = 0

  const refuse = (reason: string): never => {
    throw new ActionRefused(reason)
  }

  // A confirm the binding asked for on an action that does not leave the surface. A dialog that pops up on its own is
  // hostile, so it needs an activation of this surface too.
  const confirmRequested = async (reserved: Reserved, title: string, detail?: { text: string; label: string }) => {
    if (reserved.passive !== undefined || !hasIntent(surface) || !hasUserGesture()) return false
    return confirmIntent(
      host,
      surface,
      confirmOptions(host, surface, {
        title,
        ...(detail ? { detail: detail.text, detailLabel: detail.label } : {}),
        confirmLabel: host.t("confirm.continue"),
        ...(reserved.confirm ? { requested: reserved.confirm } : {}),
      }),
    )
  }

  // The outward gate for an action a spec bound.
  const outward = (
    reserved: Reserved,
    name: string,
    input: { title: string; detail: string; detailLabel: string; confirmLabel: string },
  ) => {
    if (reserved.passive !== undefined) refuse(`${name}: not from an activation (${reserved.passive})`)
    return allowOutward(host, surface, {
      ...input,
      requireIntent: true,
      ...(reserved.confirm ? { requested: reserved.confirm } : {}),
    })
  }

  const noSession = (): never => {
    host.toast({ title: host.t("action.noSession"), variant: "error" })
    return refuse("no session")
  }

  // Runs an onSuccess/onError handler: a chained action through json-render (its params were resolved with the bound
  // action's), or `set` through the provider's store, with "$error.message" filled in for onError. The resolved handler
  // is normalized again first, with the parent's passive tag: whatever the resolution produced, json-render never sees
  // a `confirm` (its dialog never renders, so the dispatch would hang) or onSuccess/onError of its own, and a chain of a
  // passive binding stays passive.
  const runChained = async (handler: unknown, parent: Reserved, error?: unknown) => {
    const binding = normalizeChained(handler, parent.passive)
    if (!binding) return
    if (typeof binding.action === "string") {
      await options.link?.execute?.(binding as unknown as Binding)
      return
    }
    const set = options.link?.set
    if (!set || !isRecord(binding.set)) return
    for (const [path, value] of Object.entries(binding.set))
      set(path, value === "$error.message" && error !== undefined ? errorText(error) : value)
  }

  // Wraps an action's body with its chain: onSuccess after a success, onError after a genuine failure (then handled),
  // neither after a refusal (which propagates and stops the binding's chain).
  const action =
    (body: (params: Record<string, unknown>, reserved: Reserved) => Promise<void>): ActionHandler =>
    async (raw) => {
      const reserved = takeReserved(raw, options.read)
      try {
        await body(reserved.params, reserved)
      } catch (error) {
        if (isRefusal(error) || !isRecord(reserved.onError)) throw error
        await runChained(reserved.onError, reserved, error)
        return
      }
      await runChained(reserved.onSuccess, reserved)
    }

  return {
    sendPrompt: action(async (params, reserved) => {
      // Nothing to say (Enter in an empty field, a missing param) sends nothing, as insertPrompt does.
      if (!text(params.text).trim() && params.data === undefined) refuse("sendPrompt: no text")
      const message = formatSentMessage(
        params.data === undefined ? { text: text(params.text) } : { text: text(params.text), data: params.data },
      )
      const send = surface.sendPrompt
      if (!send) return noSession()
      const ok = await outward(reserved, "sendPrompt", {
        title: host.t("confirm.send"),
        detail: message,
        detailLabel: host.t("confirm.label.message"),
        confirmLabel: host.t("confirm.sendLabel"),
      })
      if (!ok) refuse("sendPrompt")
      try {
        await send(message)
      } catch (error) {
        const description = errorText(error)
        host.toast({ title: host.t("action.sendFailed"), ...(description ? { description } : {}), variant: "error" })
        throw error
      }
    }),

    insertPrompt: action(async (params, reserved) => {
      const value = text(params.text)
      if (!value.trim()) refuse("insertPrompt: no text")
      const insert = surface.insertPrompt
      if (!insert) return noSession()
      const ok = await outward(reserved, "insertPrompt", {
        title: host.t("confirm.insert"),
        detail: value,
        detailLabel: host.t("confirm.label.text"),
        confirmLabel: host.t("confirm.insertLabel"),
      })
      if (!ok) refuse("insertPrompt")
      insert(value)
    }),

    openLink: action(async (params, reserved) => {
      if (reserved.passive !== undefined) refuse(`openLink: not from an activation (${reserved.passive})`)
      const url = safeUrl(params.url, "link")
      if (!url) {
        host.toast({ title: host.t("action.linkBlocked"), variant: "error" })
        return refuse("openLink: refused URL")
      }
      const opened = await openLink(host, surface, url, {
        requireIntent: true,
        ...(reserved.confirm ? { requested: reserved.confirm } : {}),
      })
      if (!opened) refuse("openLink")
    }),

    copyText: action(async (params, reserved) => {
      const value = text(params.text)
      // Nothing to copy (a param slip such as { value }): refuse rather than empty the clipboard and say "Copied".
      if (!value) refuse("copyText: no text")
      const label = clip(text(params.label).trim(), 60)
      const ok = await outward(reserved, "copyText", {
        title: host.t("confirm.copy"),
        detail: value,
        detailLabel: host.t("confirm.label.text"),
        confirmLabel: host.t("confirm.copyLabel"),
      })
      if (!ok) refuse("copyText")
      try {
        await host.copy(value)
      } catch (error) {
        host.toast({ title: host.t("action.copyFailed"), variant: "error" })
        throw error
      }
      host.toast({
        title: label ? host.t("action.copiedNamed", { label }) : host.t("action.copied"),
        variant: "success",
      })
    }),

    showToast: action(async (params, reserved) => {
      const title = clip(text(params.title).trim(), MAX_TITLE)
      if (!title) refuse("showToast: no title")
      const now = Date.now()
      while (toastTimes.length > 0 && now - toastTimes[0]! >= TOAST_WINDOW_MS) toastTimes.shift()
      if (toastTimes.length >= TOAST_BURST) refuse("showToast: rate limited")
      toastTimes.push(now)
      const description = clip(text(params.description).trim(), MAX_MESSAGE)
      if (reserved.confirm !== undefined) {
        const detail = description ? `${title}\n\n${description}` : title
        const shown = { text: detail, label: host.t("confirm.label.notification") }
        if (!(await confirmRequested(reserved, host.t("confirm.toast"), shown))) refuse("showToast")
      }
      const variant = params.variant === "success" || params.variant === "error" ? params.variant : "default"
      host.toast({ title, ...(description ? { description } : {}), variant })
    }),

    openCanvas: action(async (params, reserved) => {
      const id = sanitizeId(params.canvas)
      if (!id) refuse("openCanvas: no canvas id")
      const open = surface.openCanvas
      if (!open) return noSession()
      const now = Date.now()
      if (now - lastCanvas < OPEN_CANVAS_INTERVAL_MS) refuse("openCanvas: rate limited")
      lastCanvas = now
      if (
        reserved.confirm !== undefined &&
        !(await confirmRequested(reserved, host.t("confirm.openCanvas", { canvas: id! })))
      )
        refuse("openCanvas")
      open(id!)
    }),
  }
}
