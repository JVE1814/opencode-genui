import type { Spec } from "@json-render/core"
import { CANVAS_LANGUAGE, DEFAULT_CANVAS } from "../shared/constants.ts"
import { pointerTooLarge, type Patch } from "./patch.ts"

/**
 * The optional first line of a block: a JSON object without `op`. Stock json-render tooling skips it, since it is not a
 * patch.
 *
 * ```text
 * ```canvas
 * {"canvas":"deploy","title":"Deploy dashboard"}
 * {"op":"add","path":"/root","value":"main"}
 * ...
 * ```
 */
export interface SurfaceHeader {
  /** The canvas the block targets. Presence makes even a `spec` block a canvas block. */
  readonly canvas?: string
  /** The canvas tab's title, or the inline surface's accessible label. */
  readonly title?: string
  /** A stable id for an inline surface, so its UI state survives edits to the block. */
  readonly id?: string
  /** `replace` starts the canvas over, `patch` edits it. Inferred from whether the block sets `/root`. */
  readonly mode?: "replace" | "patch"
  /** Closes (removes) the canvas. */
  readonly close?: boolean
}

export interface LineError {
  /** 1-based line within the block body. */
  readonly line: number
  readonly text: string
  readonly message: string
}

export interface ParsedBlock {
  readonly header: SurfaceHeader
  readonly patches: readonly Patch[]
  readonly errors: readonly LineError[]
  /** Whether a patch sets `/root`, which makes a canvas block start a new generation. */
  readonly hasRoot: boolean
  /**
   * The normalized body: its lines trimmed, without blank lines. Two copies of a block (the agent's reply and the code
   * block the app renders) have the same text; trust compares it exactly.
   */
  readonly text: string
  /**
   * A hash of the normalized body, for change detection and display ids. Not collision resistant: never decide trust,
   * or which state a block shares, by it (see contentId in src/protocol/digest.ts).
   */
  readonly hash: string
}

export type SurfaceKind = "inline" | "canvas"

const OPS = new Set(["add", "replace", "remove", "move", "copy", "test"])
const MAX_ID = 64

/** Canvas and surface ids are model-written; keep them short and safe to use in keys and tab ids. */
export function sanitizeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID)
  return id || undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function toPatch(value: unknown): Patch | undefined {
  if (!isRecord(value) || typeof value.op !== "string" || !OPS.has(value.op) || typeof value.path !== "string") return
  return {
    op: value.op as Patch["op"],
    path: value.path,
    ...("value" in value ? { value: value.value } : {}),
    ...(typeof value.from === "string" ? { from: value.from } : {}),
  }
}

function toHeader(value: Record<string, unknown>): SurfaceHeader {
  const canvas = "canvas" in value ? (sanitizeId(value.canvas) ?? DEFAULT_CANVAS) : undefined
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 120) : undefined
  return {
    ...(canvas ? { canvas } : {}),
    ...(title ? { title } : {}),
    ...(sanitizeId(value.id) ? { id: sanitizeId(value.id) } : {}),
    ...(value.mode === "replace" || value.mode === "patch" ? { mode: value.mode } : {}),
    ...(value.close === true ? { close: true } : {}),
  }
}

/** A whole spec (`{ root, elements, state? }`) written as one JSON document, turned into the patches that build it. */
export function specToPatches(spec: Spec): Patch[] {
  const patches: Patch[] = [{ op: "add", path: "/root", value: spec.root }]
  for (const [key, element] of Object.entries(spec.elements ?? {}))
    patches.push({ op: "add", path: `/elements/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, value: element })
  if (spec.state !== undefined) patches.push({ op: "add", path: "/state", value: spec.state })
  return patches
}

const isSpecDocument = (value: unknown): value is Spec =>
  isRecord(value) && typeof value.root === "string" && isRecord(value.elements)

/**
 * FNV-1a over UTF-16 code units, as 8 hex digits. Not cryptographic (a colliding text takes milliseconds to craft):
 * used for ids and change detection, never for trust.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * Parses a block body: an optional header (the first line that is not blank or a `//` comment), then one JSON patch per
 * line. Blank lines are skipped. A body that is one whole spec document (possibly spread over many lines) is accepted
 * too, after the header or without one. `partial: true` treats an unparsable last line as still streaming instead of as
 * an error.
 */
export function parseBlock(body: string, options: { partial?: boolean } = {}): ParsedBlock {
  const lines = body.split("\n").map((line) => line.trim())
  const patches: Patch[] = []
  const errors: LineError[] = []
  let header: SurfaceHeader = {}
  let headerLine = -1
  let lastContent = -1
  lines.forEach((line, index) => {
    if (line) lastContent = index
  })
  // The header can only be the first line that is not blank or a comment. Further down, an object without `op` is a
  // line of something else: a member of a spec document written over several lines (an array item on its own line is
  // valid JSON by itself), or a mistake.
  const firstContent = lines.findIndex((line) => line !== "" && !line.startsWith("//"))

  lines.forEach((line, index) => {
    if (!line || line.startsWith("//")) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      if (options.partial && index === lastContent) return
      errors.push({ line: index + 1, text: line.slice(0, 200), message: (error as Error).message })
      return
    }
    const patch = toPatch(value)
    if (patch) {
      // A path too deep or long to walk (see MAX_POINTER_DEPTH) is refused here, so the agent hears of it.
      const tooLarge =
        pointerTooLarge(patch.path) ?? (patch.from === undefined ? undefined : pointerTooLarge(patch.from))
      if (tooLarge) errors.push({ line: index + 1, text: line.slice(0, 200), message: tooLarge })
      else patches.push(patch)
      return
    }
    if (isSpecDocument(value)) {
      patches.push(...specToPatches(value))
      return
    }
    if (isRecord(value) && !("op" in value) && index === firstContent) {
      header = toHeader(value)
      headerLine = index
      return
    }
    errors.push({ line: index + 1, text: line.slice(0, 200), message: "Not a JSON patch" })
  })

  // A whole spec spread over several lines fails line by line; try the body as one document, or what follows the
  // header line when there is one.
  if (patches.length === 0 && errors.length > 0) {
    const afterHeader =
      headerLine >= 0
        ? body
            .split("\n")
            .slice(0, headerLine + 1)
            .join("\n").length + 1
        : undefined
    const starts = new Set([body.indexOf("{"), afterHeader === undefined ? -1 : body.indexOf("{", afterHeader)])
    for (const start of starts) {
      if (start < 0) continue
      try {
        const value: unknown = JSON.parse(body.slice(start))
        if (isSpecDocument(value)) {
          patches.push(...specToPatches(value))
          errors.length = 0
          break
        }
      } catch {
        // Keep the line errors.
      }
    }
  }

  const normalized = lines.filter(Boolean).join("\n")
  return {
    header,
    patches,
    errors,
    hasRoot: patches.some((patch) => (patch.op === "add" || patch.op === "replace") && patch.path === "/root"),
    text: normalized,
    hash: hashText(normalized),
  }
}

/** Whether a block targets a canvas: the `canvas` language, or any block whose header names a canvas. */
export function blockKind(language: string, header: SurfaceHeader): SurfaceKind {
  return language === CANVAS_LANGUAGE || header.canvas !== undefined ? "canvas" : "inline"
}

/** The canvas a canvas block targets. */
export const canvasIdOf = (header: SurfaceHeader) => header.canvas ?? DEFAULT_CANVAS

/** Whether a block has anything to render or do: patches, or a canvas instruction such as close. */
export const isMeaningful = (block: ParsedBlock) => block.patches.length > 0 || block.header.close === true
