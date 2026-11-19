/** The plugin's id, shared by the server part and the desktop GUI (`ctx.id`). */
export const PLUGIN_ID = "genui"

/** The skill that holds the full component catalog and protocol, loaded by the agent on demand. */
export const SKILL_ID = "genui"

/** The key of the per-session instruction entry that tells the agent it can render UI. */
export const INSTRUCTION_KEY = "genui"

/** Fence language of a UI rendered inline in the transcript (json-render's own chat convention). */
export const INLINE_LANGUAGE = "spec"

/** Fence language of a UI rendered in a sidebar canvas tab. */
export const CANVAS_LANGUAGE = "canvas"

/** The fence languages the GUI renders. */
export const LANGUAGES = [INLINE_LANGUAGE, CANVAS_LANGUAGE] as const

/** The canvas a `canvas` block targets when its header names none. */
export const DEFAULT_CANVAS = "main"

/** Prefix of the canvas panel's tab ids; a tab's host key is `${PLUGIN_ID}:${CANVAS_TAB_PREFIX}${canvasId}`. */
export const CANVAS_TAB_PREFIX = "canvas."

/**
 * State root for UI state the user types that must never be persisted (password inputs). The normalizer binds secret
 * inputs under it; the tracked store keeps edits under it in memory only.
 */
export const UI_SECRET_ROOT = "__genui_secret"
