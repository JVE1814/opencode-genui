import type { SurfaceIssue } from "../protocol/validate.ts"
import { POOL_SURFACES, type PoolKind } from "../runtime/budget.ts"
import { RENDER_UNITS, TEXT_PER_UNIT } from "../shared/constants.ts"
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
      : `the UI is too large, so part of it is not shown: a UI shows at most about ${count(RENDER_UNITS)} elements, or ${count(RENDER_UNITS * TEXT_PER_UNIT)} characters of text, in all, and ${shared} (a repeat counts its rows times its children, a repeat inside a repeat the product of both lists, and a long text read in every row once per row): show fewer items or less text`,
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
    "part of what one change set off was skipped: one change runs at most 8,000 state actions, 4,000 watch wakes and 64 awaited actions (validateForm, custom actions) or actions of watches woken by other watches, and waits for later tasks at most 40 times: do less per change",
})
