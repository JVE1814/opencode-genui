import { z } from "zod"

/**
 * The custom actions a spec can bind (besides json-render's built-ins setState, pushState, removeState and
 * validateForm). The GUI implements each one in src/gui/actions.ts; outward actions run only from an activation (see
 * ACTIVATION_EVENTS) and may ask the user to confirm.
 */
export const actionDefinitions = {
  sendPrompt: {
    params: z.object({ text: z.string(), data: z.unknown().optional() }),
    description:
      'Send a message to you (the agent) as the user, e.g. from a submit button. text says what the user did; data carries the values, usually { "$state": "/form" }. You receive it as the user\'s next message.',
  },
  insertPrompt: {
    params: z.object({ text: z.string() }),
    description: "Put text in the user's message box for them to edit and send, without sending it.",
  },
  openLink: {
    params: z.object({ url: z.string() }),
    description: "Open an http(s) or mailto URL in the user's browser.",
  },
  copyText: {
    params: z.object({ text: z.string(), label: z.string().optional() }),
    description: 'Copy text to the clipboard and confirm with a toast ("<label> copied").',
  },
  showToast: {
    params: z.object({
      title: z.string(),
      description: z.string().optional(),
      variant: z.enum(["default", "success", "error"]).optional(),
    }),
    description: "Show a short notification.",
  },
  openCanvas: {
    params: z.object({ canvas: z.string() }),
    description: "Open (focus) a sidebar canvas by id.",
  },
}

export type ActionName = keyof typeof actionDefinitions

export const ACTION_NAMES = Object.keys(actionDefinitions) as ActionName[]

/**
 * Actions that leave the surface. They run only as the direct result of the user activating a control (see
 * ACTIVATION_EVENTS), are rate limited, and may need a confirm.
 */
export const OUTWARD_ACTIONS: ReadonlySet<ActionName> = new Set(["sendPrompt", "insertPrompt", "openLink", "copyText"])

/** Outward actions one activation may run: a short burst such as copyText then openLink. */
export const OUTWARD_BURST = 3

/** Minimum time between two activations of one surface that act outward, so a spec cannot flood the session. */
export const OUTWARD_INTERVAL_MS = 1000

/**
 * The events that are a deliberate, discrete activation of a control by the user: a press, a pick from a menu or list,
 * Enter in a field, a choice on a choice control. Outward actions run only from these. Every other binding never runs
 * them: watch, focus, blur, typing, slider movement.
 */
export const ACTIVATION_EVENTS: Readonly<Record<string, readonly string[]>> = {
  Button: ["press"],
  Link: ["press"],
  DropdownMenu: ["select"],
  Input: ["submit"],
  Table: ["select"],
  Select: ["change"],
  Radio: ["change"],
  Checkbox: ["change"],
  Switch: ["change"],
  Toggle: ["change"],
  ToggleGroup: ["change"],
  ButtonGroup: ["change"],
  Pagination: ["change"],
  Tabs: ["change"],
}

/** Whether `event` of a component of type `type` is an activation (ACTIVATION_EVENTS). */
export const isActivation = (type: string, event: string): boolean =>
  Object.hasOwn(ACTIVATION_EVENTS, type) && ACTIVATION_EVENTS[type]!.includes(event)

/** "a, b or c". */
export const listOf = (names: readonly string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`

/**
 * ACTIVATION_EVENTS in words, for the agent's instructions and the validator: "on.press of Button or Link, on.select of
 * DropdownMenu or Table, ...". Both come from this one table, so what the agent is told is what genui enforces.
 */
export function describeActivations(): string {
  const byEvent = new Map<string, string[]>()
  for (const [type, events] of Object.entries(ACTIVATION_EVENTS))
    for (const event of events) byEvent.set(event, [...(byEvent.get(event) ?? []), type])
  return listOf([...byEvent].map(([event, types]) => `on.${event} of ${listOf(types)}`))
}

/** The reserved param an action binding's `confirm` moves into, so the app's own dialog asks instead of json-render's. */
export const CONFIRM_PARAM = "__genuiConfirm"

/**
 * Reserved params a custom action's `onSuccess` and `onError` move into, so genui's handler runs them: only after the
 * action really succeeded or failed, never after it was refused (declined confirm, no activation, rate limit).
 */
export const ON_SUCCESS_PARAM = "__genuiOnSuccess"
export const ON_ERROR_PARAM = "__genuiOnError"

/**
 * The reserved param that marks a custom action bound where no activation can happen (`watch`, or an event that is not
 * in ACTIVATION_EVENTS, such as on.focus or on.blur). Its value says where, e.g. `watch["/q"]` or `on.blur`. Outward
 * actions with it are refused, and so is a confirm it asks for.
 */
export const PASSIVE_PARAM = "__genuiPassive"

/**
 * Marks an onSuccess/onError handler the normalizer refused because it was written as an expression (`{ "$state": ... }`
 * on the handler, its params or its `set`): it would only be resolved when the action fires, into a binding genui never
 * checked. The handler is replaced by `{ [IGNORED_CHAIN]: true }`, which runs nothing and which the validator reports.
 */
export const IGNORED_CHAIN = "__genuiIgnoredChain"

/** Every reserved param; handlers strip them before reading an action's own params. */
export const RESERVED_PARAMS: readonly string[] = [CONFIRM_PARAM, ON_SUCCESS_PARAM, ON_ERROR_PARAM, PASSIVE_PARAM]
