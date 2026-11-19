import type { Spec } from "@json-render/core"
import { normalizeSpec } from "./normalize.ts"
import { applyPatches, EMPTY_SPEC } from "./patch.ts"
import type { ParsedBlock } from "./surface.ts"
import { validateSurface, type SurfaceIssue } from "./validate.ts"

export interface CompiledSurface {
  /** The normalized spec, or null when there is nothing to render (no spec, or a root that cannot render). */
  readonly spec: Spec | null
  readonly issues: readonly SurfaceIssue[]
  /** Nothing can render. Never set while streaming, when a missing root only means it has not arrived yet. */
  readonly fatal: boolean
}

export interface CompileOptions {
  /** The spec is still being written: hide what is expected mid-stream (missing children, no root yet). */
  readonly streaming?: boolean
}

// Issues a spec has while its patches are still arriving: references to elements written later, the root or the state
// a repeat reads not set yet.
const MID_STREAM = new Set(["missing_child", "missing_root", "root_not_found", "empty_spec", "repeat_state_mismatch"])

const NOTHING: CompiledSurface = Object.freeze({ spec: null, issues: Object.freeze([]), fatal: false })

interface Entry {
  final?: CompiledSurface
  streaming?: CompiledSurface
}

const specCache = new WeakMap<object, Entry>()
const blockCache = new WeakMap<object, Entry>()

function compile(raw: Spec, streaming: boolean): CompiledSurface {
  const spec = normalizeSpec(raw)
  const { issues, fatal } = validateSurface(spec)
  const shown = streaming ? issues.filter((issue) => !MID_STREAM.has(issue.code)) : issues
  return Object.freeze({
    spec: fatal ? null : spec,
    issues: Object.freeze(shown),
    fatal: streaming ? false : fatal,
  })
}

function memo(cache: WeakMap<object, Entry>, key: unknown, streaming: boolean, build: () => CompiledSurface) {
  if (typeof key !== "object" || key === null) return build()
  let entry = cache.get(key)
  if (!entry) cache.set(key, (entry = {}))
  const slot = streaming ? "streaming" : "final"
  return (entry[slot] ??= build())
}

/**
 * Normalizes and validates a spec for rendering. Results are memoized by the input's identity: a canvas recompiles on
 * every streamed delta, and a spec that did not change returns the very same CompiledSurface.
 */
export function compileSpec(raw: Spec | null, options: CompileOptions = {}): CompiledSurface {
  if (raw === null || raw === undefined) return NOTHING
  const streaming = options.streaming === true
  return memo(specCache, raw, streaming, () => compile(raw, streaming))
}

/** Builds a block's spec from its patches and compiles it, memoized by the block's identity. */
export function compileBlock(block: ParsedBlock, options: CompileOptions = {}): CompiledSurface {
  const streaming = options.streaming === true
  return memo(blockCache, block, streaming, () => compileSpec(applyPatches(EMPTY_SPEC, block.patches), { streaming }))
}
