import { z } from "zod"

/**
 * The custom actions a spec can bind (besides json-render's built-ins setState, pushState, removeState and
 * validateForm). The GUI implements each one in src/gui/actions.ts; outward actions need a user gesture and may ask the
 * user to confirm.
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
    description: "Copy text to the clipboard and confirm with a toast.",
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

/** Actions that leave the surface: they need a user gesture, are rate limited, and may need a confirm. */
export const OUTWARD_ACTIONS: ReadonlySet<ActionName> = new Set(["sendPrompt", "insertPrompt", "openLink", "copyText"])

/** The reserved param an action binding's `confirm` moves into, so the app's own dialog asks instead of json-render's. */
export const CONFIRM_PARAM = "__genuiConfirm"
