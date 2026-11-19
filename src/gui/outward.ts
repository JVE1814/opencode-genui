import { OUTWARD_BURST, OUTWARD_INTERVAL_MS } from "../catalog/actions.ts"
import { urlHost } from "../protocol/url.ts"
import type { Host, SurfaceContext } from "./host.ts"

export { OUTWARD_BURST, OUTWARD_INTERVAL_MS }

/** A confirm the spec asked for on an action binding (`confirm`), as src/gui/actions.ts reads it. */
export interface RequestedConfirm {
  readonly title?: string
  readonly message?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly danger?: boolean
}

/**
 * An activation's permission to act outward: granted by a component when the user activates one of its controls on
 * purpose (see `withIntent`), scoped to the surface, spent by the outward actions that activation runs.
 */
interface Intent {
  spent: number
  /** When it was granted, or last renewed by a confirm the user accepted (see INTENT_TTL_MS). */
  since: number
}

/**
 * How long an intent lasts after it was granted, or after the user last accepted a confirm in its dispatch: about as
 * long as the browser's own user activation. A dispatch that hangs (an await that never settles) cannot keep one open.
 */
export const INTENT_TTL_MS = 5000

// The intents of the activations each surface is dispatching right now, newest last.
const intents = new WeakMap<object, Intent[]>()

// The newest intent of the surface that has not expired.
function liveIntent(key: object): Intent | undefined {
  const list = intents.get(key)
  if (!list) return undefined
  const now = Date.now()
  for (let index = list.length - 1; index >= 0; index--) {
    const intent = list[index]!
    if (now - intent.since <= INTENT_TTL_MS) return intent
  }
  return undefined
}
// When each surface last started acting outward, for OUTWARD_INTERVAL_MS.
const lastActivation = new WeakMap<object, number>()

/**
 * Whether the window has a transient user activation (a click or key press in the last few seconds). An extra check
 * only: it is window-wide and lasts seconds, so it cannot tell which control the user meant (see `withIntent`).
 */
export function hasUserGesture(): boolean {
  const activation = (globalThis.navigator as Navigator & { userActivation?: { isActive: boolean } })?.userActivation
  // Without the API (older engines, tests) fall back to allowing; the intent and the rate limit still apply.
  return activation ? activation.isActive : true
}

/**
 * Runs `dispatch`, the actions a control fires because the user activated it on purpose (a press, a pick from a menu
 * or list, Enter in a field, a choice; see ACTIVATION_EVENTS in src/catalog/actions.ts), with an outward intent granted
 * to its surface. The outward actions this dispatch runs take from the intent, also after awaits and confirm dialogs,
 * up to OUTWARD_BURST; it ends when the dispatch settles, or INTENT_TTL_MS after it was granted or last renewed.
 *
 * Nothing else grants one: watch bindings, focus, blur, typing, slider movement, mounts and programmatic emits run
 * without, so their outward actions are refused. (Bindings of those kinds are also tagged by the normalizer, so they are
 * refused even while an activation of the same surface is being dispatched.)
 */
export async function withIntent<T>(surface: SurfaceContext | undefined, dispatch: () => Promise<T>): Promise<T> {
  if (!surface || !hasUserGesture()) return dispatch()
  const intent: Intent = { spent: 0, since: Date.now() }
  const open = intents.get(surface)
  if (open) open.push(intent)
  else intents.set(surface, [intent])
  try {
    return await dispatch()
  } finally {
    const list = intents.get(surface)
    const index = list?.indexOf(intent) ?? -1
    if (list && index !== -1) list.splice(index, 1)
  }
}

/** Whether the surface is dispatching an activation (whose actions may act outward, or ask for a confirm). */
export function hasIntent(surface: SurfaceContext | undefined): boolean {
  return !!surface && liveIntent(surface) !== undefined
}

/**
 * Asks the user with the app's confirm dialog. Accepting is itself a deliberate activation, so it renews the surface's
 * current intent: the rest of the dispatch keeps its burst however long the user took to read.
 */
export async function confirmIntent(
  host: Host,
  surface: SurfaceContext | undefined,
  options: Parameters<Host["confirm"]>[0],
): Promise<boolean> {
  const intent = liveIntent(surface ?? host)
  const ok = await host.confirm(options)
  if (ok && intent) intent.since = Date.now()
  return ok
}

// ---------------------------------------------------------------------------------------------------------------------
// Confirm dialogs
// ---------------------------------------------------------------------------------------------------------------------

// Characters that draw nothing, or reorder or disguise text: controls (but tab and line breaks), format characters (zero-width
// and bidirectional marks, Unicode tag characters), private-use, unassigned and lone surrogate code points, variation
// selectors, the combining grapheme joiner, the Mongolian free variation selectors, the Khmer inherent vowels, Hangul
// fillers and the blank braille pattern. A payload could hide or disguise part of itself with them.
const INVISIBLE =
  /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u
const INVISIBLE_RUN = new RegExp(`(?:${INVISIBLE.source})+`, "gu")
// Unicode tag characters mirror printable ASCII (U+E0020-E007E): they carry text that is invisible to the reader but read
// by a model ("ASCII smuggling"). A run of them is decoded, so the user sees what is hidden.
const TAG = /^[\u{E0020}-\u{E007E}]$/u
const LONG_SPACE = /[^\S\n]{20,}/g
const BLANK_LINES = /\n(?:[^\S\n]*\n){3,}/g

const codePoint = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`

// A run of invisible characters as the confirm shows it: tag characters decoded, the rest spelled out, repeats counted.
function spellOut(host: Host, run: string): string {
  const parts: string[] = []
  let hidden = ""
  const flush = () => {
    if (hidden) parts.push(host.t("confirm.hiddenText", { text: `“${hidden}”` }))
    hidden = ""
  }
  const chars = [...run]
  for (let index = 0; index < chars.length; ) {
    const char = chars[index]!
    if (TAG.test(char)) {
      hidden += String.fromCodePoint(char.codePointAt(0)! - 0xe0000)
      index++
      continue
    }
    flush()
    let end = index + 1
    while (end < chars.length && chars[end] === char) end++
    parts.push(end - index > 1 ? `[${codePoint(char)} ×${end - index}]` : `[${codePoint(char)}]`)
    index = end
  }
  flush()
  return parts.join("")
}

/**
 * A payload as the confirm shows it: all of it, with invisible characters spelled out (hidden tag text decoded) and long
 * runs of spaces or blank lines collapsed into a visible count, so nothing in it can hide off screen or between lines.
 */
export function showPayload(host: Host, text: string): string {
  return text
    .replace(INVISIBLE_RUN, (run) => spellOut(host, run))
    .replace(LONG_SPACE, (run) => ` ${host.t("confirm.spaces", { count: run.length })} `)
    .replace(BLANK_LINES, (run) => `\n\n${host.t("confirm.blankLines", { count: run.split("\n").length - 2 })}\n\n`)
}

/**
 * Text the spec wrote for a confirm, as an untrusted dialog quotes it: on one line, with quotation marks replaced, so it
 * cannot close genui's quote and go on as text that reads like genui's own.
 */
export function quoteSpecText(host: Host, text: string): string {
  const flat = showPayload(host, text)
    .replace(/[\s\u2028\u2029]+/gu, " ")
    .replace(/["“”„‟«»‹›〝〞〟＂❝❞]/gu, "'")
    .trim()
  return `“${flat}”`
}

export interface ConfirmInput {
  /** genui's confirm title, e.g. "Send this message to the agent?". */
  readonly title: string
  /** Exactly what will happen, shown in full: the whole message with its data, the URL, the copied text. */
  readonly detail?: string
  /** genui's confirm button label. */
  readonly confirmLabel?: string
  /** A confirm the spec itself asked for (a binding's `confirm`). */
  readonly requested?: RequestedConfirm
}

/**
 * The confirm dialog for an action. It always shows the whole payload. On a trusted surface (the agent's own reply, a
 * canvas) the spec's confirm may word the title, message and buttons. On an untrusted one (tool output, a file) the title
 * and buttons stay genui's, and the spec's text appears only quoted and labelled, after genui's note and the payload.
 */
export function confirmOptions(host: Host, surface: SurfaceContext | undefined, input: ConfirmInput) {
  const requested = input.requested
  const payload = input.detail === undefined || input.detail === "" ? undefined : showPayload(host, input.detail)
  const danger = requested?.danger ? { danger: true } : {}
  if (surface?.trusted) {
    const notes = [requested?.message, payload].filter(Boolean)
    const confirm = requested?.confirmLabel || input.confirmLabel
    return {
      title: requested?.title || input.title,
      ...(notes.length > 0 ? { description: notes.join("\n\n") } : {}),
      ...(confirm ? { confirm } : {}),
      ...(requested?.cancelLabel ? { cancel: requested.cancelLabel } : {}),
      ...danger,
    }
  }
  const said = [requested?.title, requested?.message].filter(Boolean).join(" — ")
  const notes = [
    host.t("confirm.untrusted"),
    payload,
    said ? host.t("confirm.specSays", { text: quoteSpecText(host, said) }) : undefined,
  ].filter(Boolean)
  return {
    title: input.title,
    description: notes.join("\n\n"),
    ...(input.confirmLabel ? { confirm: input.confirmLabel } : {}),
    ...danger,
  }
}

/**
 * Gate for actions that leave the surface (send a message, fill the composer, open a link, copy). Refuses without a
 * window user activation (an extra check, see `hasUserGesture`), and, with `requireIntent` (actions a spec binds), when
 * no activation of the surface is being dispatched or its burst is spent. The first outward action of an activation
 * (or a click on genui's own chrome) also needs OUTWARD_INTERVAL_MS since the surface's last one; the rest of its burst
 * does not. Then it asks the user to confirm when the settings call for it (always, or only for untrusted surfaces) or
 * when the spec asked for a confirm.
 *
 * @returns Whether to proceed.
 */
export async function allowOutward(
  host: Host,
  surface: SurfaceContext | undefined,
  input: ConfirmInput & {
    /** Refuse unless an activation of the surface is being dispatched (see `withIntent`). */
    readonly requireIntent?: boolean
  },
): Promise<boolean> {
  if (!hasUserGesture()) return false

  const key: object = surface ?? host
  const intent = liveIntent(key)
  if (intent && intent.spent >= OUTWARD_BURST) return false
  if (input.requireIntent && !intent) return false
  if (!intent || intent.spent === 0) {
    const now = Date.now()
    if (now - (lastActivation.get(key) ?? 0) < OUTWARD_INTERVAL_MS) {
      // Too soon after the previous activation: the rest of this one's burst is refused too.
      if (intent) intent.spent = OUTWARD_BURST
      return false
    }
    lastActivation.set(key, now)
  }
  if (intent) intent.spent++

  const policy = host.prefs().confirmActions
  const ask = !!input.requested || policy === "always" || (policy === "untrusted" && !surface?.trusted)
  if (!ask) return true
  return confirmIntent(host, surface, confirmOptions(host, surface, input))
}

/**
 * Opens a link from a surface, after the outward gate. The URL must already have passed `safeUrl`.
 *
 * @returns Whether the link was opened.
 */
export async function openLink(
  host: Host,
  surface: SurfaceContext | undefined,
  url: string,
  options: { readonly requested?: RequestedConfirm; readonly requireIntent?: boolean } = {},
): Promise<boolean> {
  const ok = await allowOutward(host, surface, {
    title: host.t("confirm.openLink", { host: urlHost(url) }),
    detail: url,
    confirmLabel: host.t("confirm.open"),
    ...options,
  })
  if (ok) host.openExternal(url)
  return ok
}
