import type { SurfaceIssue } from "../protocol/validate.ts"
import { POOL_SURFACES, type PoolKind } from "../runtime/budget.ts"
import { MAX_CANVASES } from "../protocol/fold.ts"
import { MAX_HASHED_ITEMS } from "../runtime/state.ts"
import { MAX_DEPTH, RENDER_UNITS, TEXT_PER_UNIT } from "../shared/constants.ts"
import { MAX_MARKDOWN_TEXT, MAX_PARAGRAPH } from "./components/markdown.ts"
import {
  ITEM_LISTS,
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  type ListComponent,
} from "./costs.ts"
import type { SurfaceContext } from "./host.ts"

// Issues a surface reports about the bounds on its work: which window-wide render pool it charges (see POOL_SURFACES in
// src/runtime/budget.ts) and what it reports when its elements do not fit, and work json-render skipped.

const count = (value: number) => value.toLocaleString("en-US")

// What shares each pool, for the issue below.
const POOL_NAMES: Readonly<Record<PoolKind, string>> = {
  canvas: "the canvases in view",
  inline: "the agent's UIs in view",
  superseded: "older copies of UIs sent again",
  untrusted: "the UIs in tool output and files in view",
}

/**
 * The issue a surface of pool `kind` reports while elements do not fit in its render budget or its pool (see
 * RenderBudget). `pooled`: all of them would fit in its own budget, so the room went to other surfaces of the pool, and
 * the UI itself needs no change.
 */
export function tooLarge(kind: PoolKind, pooled = false): SurfaceIssue {
  const shared = `${POOL_NAMES[kind]} share about ${count(POOL_SURFACES[kind] * RENDER_UNITS)} elements`
  return {
    severity: "warning",
    code: "too_large",
    message: pooled
      ? `part of the UI is not shown yet: ${shared}, and other UIs hold that room now; it shows once they free it`
      : `the UI is too large, so part of it is not shown: a UI shows at most about ${count(RENDER_UNITS)} elements, or ${count(RENDER_UNITS * TEXT_PER_UNIT)} characters of text, in all, and ${shared} (a repeat counts its rows times its children, a repeat inside a repeat the product of both lists, and an element's text, or a long text read in every row, once per row or entry that shows it): show fewer items or less text`,
  }
}

/** The window-wide pool a surface's elements share with the other surfaces of its kind. */
export const poolKind = (info: Pick<SurfaceContext, "kind" | "trusted">, superseded = false): PoolKind =>
  info.kind === "canvas" ? "canvas" : !info.trusted ? "untrusted" : superseded ? "superseded" : "inline"

/**
 * The issue a surface reports once json-render skipped part of the work a change of its state set off (the bounds in
 * patches/@json-render%2Fsolid): a select-all whose row watches write more than these allow stops partway.
 */
export const SKIPPED_WORK: SurfaceIssue = Object.freeze({
  severity: "warning",
  code: "work_skipped",
  message:
    "part of what one change set off was skipped: one change runs at most 8,000 state actions, 4,000 watch wakes and 64 awaited actions (validateForm, custom actions) or actions of watches woken by other watches, and what the UI sets off while lists wait for later tasks waits at most 40 times: do less per change",
})

/**
 * The issue a surface reports once the agent's change left some of the user's edits of list items unmatched (see
 * TrackedStore.editsUnmatched in src/runtime/state.ts): an edit stayed at its index or was dropped, unchecked.
 */
export const EDITS_UNMATCHED: SurfaceIssue = Object.freeze({
  severity: "warning",
  code: "edits_unmatched",
  message: `after the agent's last change, some of the user's edits of list items were not matched to their items (one change looks through at most ${count(MAX_HASHED_ITEMS)} list items for them): each stayed at its index where its list kept its length, and was dropped otherwise: keep such lists shorter`,
})

// --- What a component leaves out --------------------------------------------------------------------------------------
// Reported by the component's element while it is mounted (see useCut in src/gui/components/shared.tsx), so the agent
// learns what the user does not see, whether the list or text came from the spec or from state.

/** A component that draws a list item by item drew only its first `max` of `total` items (see ITEM_LISTS). */
export function listCut(type: ListComponent, total: number): SurfaceIssue {
  const { max, noun } = ITEM_LISTS[type]
  return {
    severity: "warning",
    code: "list_cut",
    message: `shows only its first ${count(max)} of ${count(total)} ${noun}: ${/^[AEIOU]/.test(type) ? "an" : "a"} ${type} shows at most ${count(max)}`,
  }
}

/** A Table showed only part of its rows or columns (see tableRows in src/gui/costs.ts). */
export function tableCut(rows: number, totalRows: number, columns: number, totalColumns: number): SurfaceIssue {
  return {
    severity: "warning",
    code: "list_cut",
    message: `shows ${count(rows)} of its ${count(totalRows)} rows and ${count(columns)} of its ${count(totalColumns)} columns: a Table shows at most ${count(MAX_TABLE_ROWS)} rows, ${count(MAX_TABLE_COLUMNS)} columns and ${count(MAX_TABLE_CELLS)} cells`,
  }
}

/** A Chart drew only part of its labels or series. */
export function chartCut(points: number, totalPoints: number, series: number, totalSeries: number): SurfaceIssue {
  return {
    severity: "warning",
    code: "list_cut",
    message: `draws ${count(points)} of its ${count(totalPoints)} labels and ${count(series)} of its ${count(totalSeries)} series: a Chart draws at most ${count(MAX_CHART_POINTS)} labels and ${count(MAX_CHART_SERIES)} series`,
  }
}

/** A Markdown text showed only its first `shown` of `total` characters (see shownLength in components/markdown.ts). */
export function markdownCut(shown: number, total: number, reason: "text" | "paragraph"): SurfaceIssue {
  return {
    severity: "warning",
    code: "text_cut",
    message: `shows only the first ${count(shown)} of its ${count(total)} characters of Markdown: ${
      reason === "paragraph"
        ? `a paragraph (or a list item, or a table row) runs past ${count(MAX_PARAGRAPH)} characters there: split it into shorter ones`
        : `a Markdown text shows at most ${count(MAX_MARKDOWN_TEXT)}`
    }`,
  }
}

/** How many of a surface's distinct cut issues it lists one by one; the rest are counted in one more (see moreCuts). */
export const MAX_CUT_ISSUES = 20

/** The issue that counts the elements past MAX_CUT_ISSUES that also leave part of their content out. */
export const moreCuts = (more: number): SurfaceIssue => ({
  severity: "warning",
  code: "list_cut",
  message: `${count(more)} more elements show only part of their lists or text`,
})

/** The issue the newest canvas shows when blocks named more canvases than MAX_CANVASES (see src/protocol/fold.ts). */
export const canvasesRefused = (refused: number): SurfaceIssue => ({
  severity: "warning",
  code: "too_many_canvases",
  message: `${count(refused)} more ${refused === 1 ? "canvas was" : "canvases were"} not opened: a session has at most ${MAX_CANVASES} canvases open at once; close one with {"canvas":"<id>","close":true} and send it again whole, or reuse an id`,
})

/** Elements nested deeper than MAX_DEPTH render nothing (see GenuiElement in src/gui/element.ts). */
export const tooDeep = (elements: number): SurfaceIssue => ({
  severity: "warning",
  code: "too_deep",
  message: `${count(elements)} ${elements === 1 ? "element is" : "elements are"} nested more than ${MAX_DEPTH} levels deep and not shown: nest less`,
})

/** Elements whose component threw render nothing (see GenuiElement in src/gui/element.ts). */
export const renderFailed = (errors: readonly string[]): SurfaceIssue => ({
  severity: "error",
  code: "render_error",
  message: `${count(errors.length)} ${errors.length === 1 ? "element" : "elements"} could not render: ${errors[0]}`,
})
