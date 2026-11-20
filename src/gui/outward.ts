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
  /**
   * How many waits outside the page its dispatch is in (see `whileAway`): the host's answer to a message it sent, a
   * confirm dialog, the clipboard, a choice's gap. Meanwhile the dispatch runs nothing, and its intent counts for nothing
   * else.
   */
  away: number
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

// The intent of the dispatch running now on the surface: the newest one that has not expired, leaving out dispatches
// that wait outside the page (see `whileAway`). Tasks never interleave, and a dispatch spans tasks only while it waits
// outside the page, so the one this finds is running in this very task. A write in another task (typing, which wakes
// watches, or the agent's next patch) finds none: it cannot borrow the intent of a dispatch whose message is still being
// sent, to open a modal or act outward with it.
function liveIntent(key: object): Intent | undefined {
  const list = intents.get(key)
  if (!list) return undefined
  const now = Date.now()
  for (let index = list.length - 1; index >= 0; index--) {
    const intent = list[index]!
    if (intent.away === 0 && now - intent.since <= INTENT_TTL_MS) return intent
  }
  return undefined
}

/**
 * Runs `wait`, something the current dispatch of the surface waits for outside the page (the host's answer to a message,
 * a confirm dialog, the clipboard), with that dispatch's intent set aside meanwhile (see `liveIntent`). The intent is
 * back, with what is left of its burst and its time, once `wait` settles.
 */
export async function whileAway<T>(key: object | undefined, wait: () => Promise<T>): Promise<T> {
  const intent = key && liveIntent(key)
  if (intent) intent.away++
  try {
    return await wait()
  } finally {
    if (intent) intent.away--
  }
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
 * Told by json-render when an action list of the dispatch waits for a later task (`true`: it ran for its time slice,
 * see patches/@json-render%2Fsolid) and when it runs again (`false`). Meanwhile the dispatch's intent is set aside, as
 * while it waits outside the page (see `whileAway`): the window answers input in between, and a keystroke's task must
 * not find the intent (a watch it wakes would open an untrusted modal with it).
 */
export type Away = (waiting: boolean) => void

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
  dispatch: (away: Away) => Promise<T>,
  options: { readonly choice?: object } = {},
): Promise<T> {
  if (!surface || !hasUserGesture()) return dispatch(() => {})
  activations.set(surface, (activations.get(surface) ?? 0) + 1)
  const intent: Intent = { spent: 0, since: Date.now(), away: 0, ...(options.choice ? { choice: options.choice } : {}) }
  if (options.choice) latestChoice.set(options.choice, intent)
  const open = intents.get(surface)
  if (open) open.push(intent)
  else intents.set(surface, [intent])
  // How many of the dispatch's action lists wait for a later task right now (see `Away`).
  let waiting = 0
  const away: Away = (now) => {
    if (now) {
      waiting++
      intent.away++
    } else if (waiting > 0) {
      waiting--
      intent.away--
    }
  }
  try {
    return await dispatch(away)
  } finally {
    intent.away -= waiting
    waiting = 0
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
  const intent: Intent = { spent: OUTWARD_BURST, since: Date.now(), away: 0, passive: true }
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
 * Whether the dispatch running now on the surface is an activation (whose actions may act outward, ask for a confirm or
 * open a modal). False in a task the surface dispatches nothing in, such as a keystroke's (see `liveIntent`).
 */
export function hasIntent(surface: SurfaceContext | undefined): boolean {
  const intent = surface && liveIntent(surface)
  return !!intent && !intent.passive
}

// The runner each intent lends (see `lendActivation`).
const lenders = new WeakMap<Intent, (run: () => void) => void>()

/**
 * What the surface's running activation, if any, lends to the elements it shows that the render budget's task slice
 * defers to a later task (see `defer` in src/runtime/budget.ts): a runner that puts the activation's intent back on the
 * surface while a later task mounts them, so that a Dialog the press opened, placed after a long list the same press
 * revealed, still opens on an untrusted surface. Only for that mount: a task in between (a keystroke's) finds nothing,
 * the intent is the same one (its burst is not renewed), and it lends nothing once INTENT_TTL_MS after its grant or
 * last renewal has passed. Undefined while the surface runs no activation.
 */
export function lendActivation(surface: SurfaceContext | undefined): ((run: () => void) => void) | undefined {
  const intent = surface && liveIntent(surface)
  if (!surface || !intent || intent.passive) return undefined
  // One runner per intent: the render budget wakes the elements it lent to together, in chunks (see budget.ts).
  const known = lenders.get(intent)
  if (known) return known
  const lend = (run: () => void) => {
    if (Date.now() - intent.since > INTENT_TTL_MS) return run()
    const list = intents.get(surface) ?? []
    intents.set(surface, list)
    // The same intent, also while its dispatch waits for a later task itself (`away`): what it spends is its own.
    const lent: Intent = {
      get spent() {
        return intent.spent
      },
      set spent(value) {
        intent.spent = value
      },
      get since() {
        return intent.since
      },
      set since(value) {
        intent.since = value
      },
      away: 0,
    }
    // What a task that runs with it defers again is lent the same.
    lenders.set(lent, lend)
    list.push(lent)
    try {
      run()
    } finally {
      const index = list.lastIndexOf(lent)
      if (index !== -1) list.splice(index, 1)
    }
  }
  lenders.set(intent, lend)
  return lend
}

/** Whether the dispatch running now on the surface is a passive one (focus, blur, a slider, a browsed choice). */
export function isPassiveDispatch(surface: SurfaceContext | undefined): boolean {
  return !!(surface && liveIntent(surface)?.passive)
}

/**
 * Asks the user with the app's confirm dialog. Accepting is itself a deliberate activation, so it renews the surface's
 * current intent: the rest of the dispatch keeps its burst however long the user took to read. While the dialog is up,
 * the intent is set aside (see `whileAway`).
 */
export async function confirmIntent(
  host: Host,
  surface: SurfaceContext | undefined,
  options: Parameters<Host["confirm"]>[0],
): Promise<boolean> {
  const intent = liveIntent(surface ?? host)
  const ok = await whileAway(surface ?? host, () => host.confirm(options))
  if (ok && intent) intent.since = Date.now()
  return ok
}

// ---------------------------------------------------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------------------------------------------------
//
// Whether a modal (Dialog, Drawer, src/gui/components/overlay.tsx) may open. The record lives here, keyed by the
// surface's state store and the modal's open path, and window-wide, never in the component: a spec that hides and
// re-shows a Dialog mounts a fresh one, which would start with a clean record of its own and loop again.

/** How long after the user dismissed a modal (Escape, its close button, its backdrop) another one opens only from an activation. */
export const REOPEN_MS = 1500

// How many activations each surface dispatched (see `withIntent`), and how many versions of the agent's state it showed
// (see `noteAgentState`), so far.
const activations = new WeakMap<object, number>()
const agentStates = new WeakMap<object, number>()

/** Says that the surface shows a new version of the agent's state (its next patch, a re-sent block). */
export function noteAgentState(surface: SurfaceContext): void {
  agentStates.set(surface, (agentStates.get(surface) ?? 0) + 1)
}

// What each state store's last dismissal of a modal saw: the surface, and its counts of activations and agent states.
const dismissals = new WeakMap<
  object,
  { readonly surface: object; readonly activations: number; readonly states: number }
>()
/** How many modals may open in one task, in the whole window. */
export const MODAL_OPENS_PER_TASK = 8

/** Why a modal did not open (see `modalRefusal`). */
export type ModalRefusal = "again" | "shown" | "many" | "passive" | "untrusted" | "dismissed"

// The current task: a number the next timer task moves on, with what this task did. A loop that opens and closes a
// modal through focus moves never yields, so everything that bounds it is counted per task.
let modalTask = 0
let modalTaskTimer: ReturnType<typeof setTimeout> | undefined
let modalOpens = 0
let modalWarned = false
const currentModalTask = () => {
  modalTaskTimer ??= setTimeout(() => {
    modalTaskTimer = undefined
    modalTask++
    modalOpens = 0
    modalWarned = false
  })
  return modalTask
}
// The open paths of each state store whose modal opened or closed in the current task, and how (closed wins).
const modalToggles = new WeakMap<object, { task: number; paths: Map<string, "opened" | "closed"> }>()
// The modal elements genui opened, by state store and open path (the element tells whether it is still shown).
const shownModals = new WeakMap<object, Map<string, Set<{ readonly open: boolean; readonly isConnected: boolean }>>>()
// When the user last dismissed a modal, in any surface.
let modalDismissed = Number.NEGATIVE_INFINITY

function toggledPaths(store: object): Map<string, "opened" | "closed"> {
  const task = currentModalTask()
  const record = modalToggles.get(store)
  if (record?.task === task) return record.paths
  const paths = new Map<string, "opened" | "closed">()
  modalToggles.set(store, { task, paths })
  return paths
}

// Whether a modal element genui opened at `path` of `store` is shown now (forgetting those that are not).
function isShown(store: object, path: string): boolean {
  const elements = shownModals.get(store)?.get(path)
  if (!elements) return false
  for (const element of elements) if (!element.open || !element.isConnected) elements.delete(element)
  return elements.size > 0
}

/** Records that `element` opened as the modal at `path` of `store` (see `modalRefusal`'s `shown`). */
export function noteModalShown(
  store: object,
  path: string,
  element: { readonly open: boolean; readonly isConnected: boolean },
) {
  let paths = shownModals.get(store)
  if (!paths) shownModals.set(store, (paths = new Map()))
  let elements = paths.get(path)
  if (!elements) paths.set(path, (elements = new Set()))
  elements.add(element)
}

/**
 * Why the modal at open path `path` of the state store `store` may not open now, or undefined when it may:
 *
 * - `again`: a modal at this path of this store closed in this task, or opened in it and is no longer shown, whichever
 *   instance of the Dialog (a remounted one too) asks. A modal that keeps opening and closing within one task never lets
 *   the window paint; that loop went through focus moves (see `asModalFocusMove`), and this bounds any other.
 * - `shown`: another modal element at this path of this store opened in this task and is shown (a Dialog and a Drawer
 *   bound to one path): the state stays open, and that one is what the user sees.
 * - `many`: MODAL_OPENS_PER_TASK modals opened in this task, in the whole window (the same loop through ever new paths).
 * - `passive`: the surface's running dispatch is a passive one (focus, blur, a slider, a browsed choice), on any surface.
 * - `untrusted`: on an untrusted surface, only an activation opens a modal (a model-written modal is a phishing tool).
 * - `dismissed`: once the user dismissed a modal of this store, only an activation opens one of its modals, until the
 *   user activates a control of its surface or the agent sends a new version of its state, however long that takes: a
 *   watch woken by the dismissal could wait past any time limit (its list deferred to later tasks) and re-open it after
 *   every Escape. And within REOPEN_MS of the user dismissing any modal, only an activation opens one, on any surface.
 */
export function modalRefusal(
  store: object,
  path: string,
  surface: SurfaceContext | undefined,
): ModalRefusal | undefined {
  const toggled = toggledPaths(store).get(path)
  if (toggled) return toggled === "opened" && isShown(store, path) ? "shown" : "again"
  if (modalOpens >= MODAL_OPENS_PER_TASK) return "many"
  if (isPassiveDispatch(surface)) return "passive"
  const activation = hasIntent(surface)
  if (surface?.trusted === false && !activation) return "untrusted"
  if (activation) return undefined
  const dismissal = dismissals.get(store)
  if (
    dismissal &&
    (activations.get(dismissal.surface) ?? 0) === dismissal.activations &&
    (agentStates.get(dismissal.surface) ?? 0) === dismissal.states
  )
    return "dismissed"
  if (Date.now() - modalDismissed < REOPEN_MS) return "dismissed"
  return undefined
}

/**
 * Records what happened to the modal at `path` of `store`, on `surface`: it `opened`, it `closed` (from state), or the
 * user `dismissed` it (Escape, the close button, the backdrop). Each counts as a change of that path in this task (see
 * `modalRefusal`).
 */
export function noteModal(
  store: object,
  path: string,
  change: "opened" | "closed" | "dismissed",
  surface?: SurfaceContext,
): void {
  const toggled = toggledPaths(store)
  if (change !== "opened" || !toggled.has(path)) toggled.set(path, change === "opened" ? "opened" : "closed")
  if (change === "opened") modalOpens++
  if (change !== "dismissed") return
  modalDismissed = Date.now()
  const key: object = surface ?? store
  dismissals.set(store, { surface: key, activations: activations.get(key) ?? 0, states: agentStates.get(key) ?? 0 })
}

// How many of genui's own showModal() or close() calls are running (see `asModalFocusMove`).
let modalFocusMoves = 0

/**
 * Runs `move`, genui's own showModal() or close() of a modal. Both move focus at once (into the modal, and back to where
 * it was), and the focus and blur events they cause are not the user's: a field's on.focus and on.blur do not run for
 * them (see `isModalFocusMove`). Otherwise a spec whose field opens a modal on focus (directly or through a watch) and
 * closes it on blur loops: every open blurs the field, every close focuses it again.
 */
export function asModalFocusMove(move: () => void): void {
  modalFocusMoves++
  try {
    move()
  } finally {
    modalFocusMoves--
  }
}

/** Whether a focus or blur event comes from a modal genui is opening or closing right now (see `asModalFocusMove`). */
export const isModalFocusMove = (): boolean => modalFocusMoves > 0

/** Says once per task, in the console, that a modal was refused for a reason other than its surface's trust. */
export function warnModalRefusal(reason: ModalRefusal, path: string): void {
  if (reason === "untrusted" || reason === "shown" || modalWarned) return
  modalWarned = true
  const why: Record<Exclude<ModalRefusal, "untrusted" | "shown">, string> = {
    again:
      "it closed in this task, or opened in it and is no longer shown (a modal that keeps opening and closing loops)",
    many: `${MODAL_OPENS_PER_TASK} modals already opened in this task`,
    passive: "focus, blur, a slider or a browsed choice opened it, which is no activation",
    dismissed: `the user dismissed a modal (of this UI since its last activation, or less than ${REOPEN_MS} ms ago); only a press or another activation opens one now`,
  }
  console.warn(`[genui] The modal at "${path}" did not open: ${why[reason]}.`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Confirm dialogs
// ---------------------------------------------------------------------------------------------------------------------
//
// The app shows a confirm's description as one paragraph: its dialog collapses whitespace (line breaks included) and
// keeps the text from being selected (packages/ui/src/overlays/dialog/dialog.css, `[data-slot=dialog-description]`).
// So genui's description reads as one run of text whatever the host does with whitespace:
//
//   [genui's note (untrusted) | the spec's message (trusted)] [Message: the payload, line breaks shown as ↵]
//
// The payload comes last and runs to the end of the dialog, so nothing it contains can pass for genui's own text that
// follows it; it is labelled, word for word, and spelled out so that nothing in it hides. On an untrusted surface the
// spec's own title and message are not shown at all: in one run of plain text nothing can mark where they end, since
// any delimiter genui puts after them has lookalikes among the letters of some script (a Hebrew yod, a syllabics final
// acute), and text after a forged one ("Checked by genui: safe to send") read as genui's own verdict.

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
 * the title, note and buttons are genui's, and the spec's own words are left out (see the top of this section); only
 * its `danger` is kept. The parts are separated by blank lines for a host that keeps them, and read as one paragraph
 * where the host collapses them.
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
  const notes = [host.t("confirm.untrusted"), payload].filter(Boolean)
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
  intent.away++
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
    intent.away--
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
