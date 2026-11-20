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
  /** For a choice, the control it was made on (see `withIntent`). */
  readonly choice?: object
  /** Not an activation: a dispatch that may not act outward at all (see `withoutIntent`). */
  readonly passive?: true
  /** A choice waiting for the gap (see `choiceTurn`): its dispatch runs nothing meanwhile, and it counts for nothing else. */
  waiting?: boolean
}

// The newest choice intent of each control (see `withIntent`).
const latestChoice = new WeakMap<object, Intent>()

/**
 * How long an intent lasts after it was granted, or after the user last accepted a confirm in its dispatch: about as
 * long as the browser's own user activation. A dispatch that hangs (an await that never settles) cannot keep one open.
 */
export const INTENT_TTL_MS = 5000

// The intents of the activations each surface is dispatching right now, newest last.
const intents = new WeakMap<object, Intent[]>()

// The newest intent of the surface that has not expired, leaving out choices that wait for the gap: while one waits, a
// write that is no dispatch of its own (typing, which wakes watches) must not find its intent and open a modal with it.
function liveIntent(key: object): Intent | undefined {
  const list = intents.get(key)
  if (!list) return undefined
  const now = Date.now()
  for (let index = list.length - 1; index >= 0; index--) {
    const intent = list[index]!
    if (!intent.waiting && now - intent.since <= INTENT_TTL_MS) return intent
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
export async function withIntent<T>(
  surface: SurfaceContext | undefined,
  dispatch: () => Promise<T>,
  options: { readonly choice?: object } = {},
): Promise<T> {
  if (!surface || !hasUserGesture()) return dispatch()
  const intent: Intent = { spent: 0, since: Date.now(), ...(options.choice ? { choice: options.choice } : {}) }
  if (options.choice) latestChoice.set(options.choice, intent)
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

/**
 * Runs `dispatch`, the actions a control fires for something the user does not mean as an activation (a choice moved
 * with the arrow keys, focus, blur, a slider's movement), as the surface's newest dispatch with a spent intent: its
 * outward actions are refused, and it opens no dialog, even while another activation of the surface is being
 * dispatched or a choice waits for the gap (intents are kept per surface, see `liveIntent`).
 */
export async function withoutIntent<T>(surface: SurfaceContext | undefined, dispatch: () => Promise<T>): Promise<T> {
  if (!surface) return dispatch()
  const intent: Intent = { spent: OUTWARD_BURST, since: Date.now(), passive: true }
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
  const intent = surface && liveIntent(surface)
  return !!intent && !intent.passive
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
//
// The app shows a confirm's description as one paragraph: its dialog collapses whitespace (line breaks included) and
// keeps the text from being selected (packages/ui/src/overlays/dialog/dialog.css, `[data-slot=dialog-description]`).
// So genui's description reads as one run of text whatever the host does with whitespace:
//
//   [genui's note (untrusted) | the spec's message (trusted)] [The UI says: “the spec's text” (untrusted)]
//   [Message: the payload, line breaks shown as ↵]
//
// The payload comes last and runs to the end of the dialog, so nothing it contains can pass for genui's own text that
// follows it; it is labelled, word for word, and spelled out so that nothing in it hides. The spec's text on an untrusted
// surface is quoted with every quotation mark (and lookalike) in it replaced, so it cannot close genui's quote.

// Characters that draw nothing, or reorder or disguise text: controls (but tab and line breaks), format characters (zero-width
// and bidirectional marks, Unicode tag characters), private-use, unassigned and lone surrogate code points, line and
// paragraph separators, variation selectors, the combining grapheme joiner, the Mongolian free variation selectors, the
// Khmer inherent vowels, Hangul fillers, the blank braille pattern, the musical null notehead and the Khitan filler. A
// payload could hide or disguise part of itself with them.
const INVISIBLE =
  /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}\u{1D159}\u{16FE4}]/u
const INVISIBLE_RUN = new RegExp(`(?:${INVISIBLE.source})+`, "gu")
// Unicode tag characters mirror printable ASCII (U+E0020-E007E): they carry text that is invisible to the reader but read
// by a model ("ASCII smuggling"). A run of them is decoded, so the user sees what is hidden.
const TAG = /^[\u{E0020}-\u{E007E}]$/u
// A run of 8 or more of one symbol, mark or non-ASCII space: a glyph this list does not know may draw nothing (or a box),
// and a long run of it could push the rest of the payload out of view.
const SAME_RUN = /([^\p{L}\p{N}\p{P}\u0000-\u007f])\1{7,}/gu
// A long run of spaces, or a run with 3 or more spaces the dialog does not collapse (no-break, em, ideographic...).
const WIDE_SPACE = /[^\S\r\n]{20,}|(?:[^\S\r\n]*[^\S\r\n\t ]){3,}[^\S\r\n]*/g
// A run of line breaks (with the spaces around them, which the dialog collapses anyway).
const LINE_BREAKS = /[^\S\r\n]*(?:(?:\r\n|\r|\n)[^\S\r\n]*)+/g
/** Stands in for a line break in a confirm's payload: the dialog would collapse it. */
export const LINE_BREAK = "↵"
/** A payload longer than this (in characters) shows its length, so text out of view is never silent. */
export const LONG_PAYLOAD = 280

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

/** Text with whatever could hide made visible: invisible characters spelled out, long runs counted. */
function reveal(host: Host, text: string): string {
  return text
    .replace(INVISIBLE_RUN, (run) => spellOut(host, run))
    .replace(SAME_RUN, (run, char: string) => `[${codePoint(char)} ×${[...run].length}]`)
    .replace(WIDE_SPACE, (run) => ` ${host.t("confirm.spaces", { count: run.length })} `)
}

/**
 * A payload as the confirm shows it, on one line: all of it, with invisible characters spelled out (hidden tag text
 * decoded), long runs of one symbol or of spaces counted, line breaks shown as ↵ and runs of blank lines counted.
 */
export function showPayload(host: Host, text: string): string {
  return reveal(host, text).replace(LINE_BREAKS, (run) => {
    const breaks = run.match(/\r\n|\r|\n/g)!.length
    return breaks > 3
      ? ` ${LINE_BREAK} ${host.t("confirm.blankLines", { count: breaks - 1 })} ${LINE_BREAK} `
      : ` ${Array.from({ length: breaks }, () => LINE_BREAK).join(" ")} `
  })
}

// Quotation marks of every script, and characters that look like one: primes, ditto marks, spacing accents and other
// modifier symbols (\p{Sk}, but the emoji skin tones), modifier letters (U+02B9-02FF, U+0374-0375), the Armenian,
// N'Ko and Latin apostrophes and saltillos.
const QUOTE_LIKE =
  /(?![\u{1F3FB}-\u{1F3FF}])[\p{Pi}\p{Pf}\p{Sk}"＂＇‚‛„‟〃״׳′″‴‵‶‷⁗「」『』﹁﹂﹃﹄〝〞〟❛❜❝❞❟❠❮❯⹂\u02B9-\u02FF\u0374\u0375\u055A-\u055F\u07F4\u07F5\uA788-\uA78C\u{1F676}-\u{1F678}]/gu

// Combining marks that do not sit on a letter, a digit or another mark: on their own they draw a free-standing accent,
// and some look like a quotation mark (U+030B draws ˝, U+030E a small ").
const LOOSE_MARKS = /(?<![\p{L}\p{N}\p{M}])\p{M}+/gu

/**
 * Text the spec wrote for a confirm, as an untrusted dialog quotes it: on one line, made visible as a payload is, with
 * every quotation mark and lookalike replaced and combining marks that sit on no letter spelled out, so it cannot close
 * genui's quote and go on as text that reads like genui's own. Lookalikes go first: a mark on one (ʺ̋, itself a letter)
 * is loose once it is replaced, rather than riding on the replacement.
 */
export function quoteSpecText(host: Host, text: string): string {
  const flat = reveal(host, text)
    .replace(QUOTE_LIKE, "'")
    .replace(LOOSE_MARKS, (run) => spellOut(host, run))
    .replace(/\s+/gu, " ")
    .trim()
  return `“${flat}”`
}

export interface ConfirmInput {
  /** genui's confirm title, e.g. "Send this message to the agent?". */
  readonly title: string
  /** Exactly what will happen, shown in full: the whole message with its data, the URL, the copied text. */
  readonly detail?: string
  /** What the detail is, e.g. "Address" (`confirm.label.*`); "Message" when omitted. */
  readonly detailLabel?: string
  /** genui's confirm button label. */
  readonly confirmLabel?: string
  /** A confirm the spec itself asked for (a binding's `confirm`). */
  readonly requested?: RequestedConfirm
}

/** The payload part of a confirm's description: labelled, shown in full, with its length when it is long. */
function payloadPart(host: Host, input: ConfirmInput): string | undefined {
  const detail = input.detail
  if (detail === undefined || detail === "") return undefined
  const label = input.detailLabel || host.t("confirm.label.message")
  const text = showPayload(host, detail).trim()
  const length = [...detail].length
  return length > LONG_PAYLOAD
    ? host.t("confirm.detailLong", { label, count: length.toLocaleString("en-US"), text })
    : host.t("confirm.detail", { label, text })
}

/**
 * The confirm dialog for an action. It always shows the whole payload, last. On a trusted surface (the agent's own
 * reply, a canvas) the spec's confirm may word the title, message and buttons. On an untrusted one (tool output, a file)
 * the title and buttons stay genui's, and the spec's text appears only quoted and labelled, after genui's note. The
 * parts are separated by blank lines for a host that keeps them, and read as one paragraph where the host collapses
 * them (see the top of this section).
 */
export function confirmOptions(host: Host, surface: SurfaceContext | undefined, input: ConfirmInput) {
  const requested = input.requested
  const payload = payloadPart(host, input)
  const danger = requested?.danger ? { danger: true } : {}
  if (surface?.trusted) {
    const message = requested?.message ? reveal(host, requested.message).replace(/\s+/gu, " ").trim() : ""
    const notes = [message, payload].filter(Boolean)
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
    said ? host.t("confirm.specSays", { text: quoteSpecText(host, said) }) : undefined,
    payload,
  ].filter(Boolean)
  return {
    title: input.title,
    description: notes.join("\n\n"),
    ...(input.confirmLabel ? { confirm: input.confirmLabel } : {}),
    ...danger,
  }
}

// The choices waiting for the gap on each surface, in the order they were made (see `choiceTurn`).
const choiceQueue = new WeakMap<object, Promise<void>>()

/**
 * Waits until a choice made too soon after the surface's previous outward activation may go: OUTWARD_INTERVAL_MS after
 * it, and after the choices made before it on the same surface, so the agent hears them in the order the user made
 * them. A choice its control has replaced meanwhile (the user moved on: only the value the control now shows matters),
 * or whose intent expired, does not go. While it waits, its intent counts for nothing else (see `liveIntent`).
 *
 * @returns Whether the choice may go; the surface's gap then starts again from now.
 */
async function choiceTurn(key: object, intent: Intent, choice: object): Promise<boolean> {
  const ahead = choiceQueue.get(key) ?? Promise.resolve()
  let done!: () => void
  const turn = new Promise<void>((resolve) => (done = resolve))
  const queued = ahead.then(() => turn)
  choiceQueue.set(key, queued)
  intent.waiting = true
  try {
    await ahead
    for (;;) {
      if (latestChoice.get(choice) !== intent || Date.now() - intent.since > INTENT_TTL_MS) return false
      const wait = OUTWARD_INTERVAL_MS - (Date.now() - (lastActivation.get(key) ?? 0))
      if (wait <= 0) {
        lastActivation.set(key, Date.now())
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  } finally {
    intent.waiting = false
    done()
    if (choiceQueue.get(key) === queued) choiceQueue.delete(key)
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
    if (Date.now() - (lastActivation.get(key) ?? 0) < OUTWARD_INTERVAL_MS) {
      // Too soon after the previous activation. A choice (the value its control now shows) waits for the gap instead
      // (see `choiceTurn`); anything else is refused, with the rest of its burst.
      if (!intent?.choice || !(await choiceTurn(key, intent, intent.choice))) {
        if (intent) intent.spent = OUTWARD_BURST
        return false
      }
    }
    lastActivation.set(key, Date.now())
  }
  if (intent) intent.spent++
  return askOutward(host, surface, input)
}

/**
 * The confirm part of the outward gate on its own: asks when the settings call for it (always, or only for untrusted
 * surfaces) or when the spec asked for a confirm, showing the whole payload. Also used where genui's own control is
 * the activation and no rate limit applies (a click on "Load image").
 *
 * @returns Whether to proceed: false without a window user activation.
 */
export async function askOutward(
  host: Host,
  surface: SurfaceContext | undefined,
  input: ConfirmInput,
): Promise<boolean> {
  if (!hasUserGesture()) return false
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
    detailLabel: host.t("confirm.label.address"),
    confirmLabel: host.t("confirm.open"),
    ...options,
  })
  if (ok) host.openExternal(url)
  return ok
}
