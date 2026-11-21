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

/**
 * What one surface renders at most, in units (src/gui/element.ts): each element takes one, plus one for every
 * TEXT_PER_UNIT characters of text (and entries of lists and objects) in its resolved props. About 2,000 elements, or
 * half a million characters. The skill tells the agent.
 */
export const RENDER_UNITS = 2000
export const TEXT_PER_UNIT = 250

/**
 * How many child renderers one surface builds at most (src/runtime/budget.ts): each child of a rendered element, and
 * rows × children for a repeat, whether the child then fits or not.
 */
export const SLOT_UNITS = 2 * RENDER_UNITS

/**
 * How deep elements nest at most (the root is at depth 1, a repeat's rows one below it). Each level of nesting takes a
 * few hundred stack frames in json-render's renderer and Solid's, and past about 50 levels (about 30 when every level
 * is a repeat) the stack overflowed: the rest of the UI vanished with nothing said. An element nested deeper renders
 * nothing, and the surface says so (see GenuiElement in src/gui/element.ts). The skill tells the agent.
 */
export const MAX_DEPTH = 20

/** How many rows a repeat renders at most (the json-render patch in patches/ applies the same number). */
export const MAX_REPEAT_ROWS = 2000
