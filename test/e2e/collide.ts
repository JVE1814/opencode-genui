// Crafts a ```spec block body whose 32-bit FNV-1a hash (src/protocol/surface.ts `hashText` over the block's normalized
// text) equals another block's, for the trust test in genui.spec.ts ([review-security#5]). A `//` comment line is
// ignored as a patch but kept in the hashed text, so a short suffix on it can steer the hash to any target. Based on
// the review's probe (scratchpad/sec/collide.ts).

const OFFSET = 0x811c9dc5 | 0
const PRIME = 0x01000193

// The inverse of PRIME modulo 2^32 (Newton's iteration).
let inverse = PRIME
for (let round = 0; round < 5; round++) inverse = Math.imul(inverse, 2 - Math.imul(PRIME, inverse))

const step = (hash: number, text: string) => {
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), PRIME)
  return hash
}

/** A block body as the plugin hashes it: lines trimmed, blank lines dropped. */
export const normalizeBody = (body: string) =>
  body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")

/** FNV-1a of a block body's normalized text, as 8 hex digits (what `parseBlock(body).hash` was when this was written). */
export const fnvOfBody = (body: string) => (step(OFFSET, normalizeBody(body)) >>> 0).toString(16).padStart(8, "0")

/**
 * `evil` with a final `// …` comment line chosen so that `fnvOfBody(result) === fnvOfBody(target)`. Four characters
 * are searched; the last one is solved for directly (FNV-1a's final step is invertible), so this takes milliseconds.
 */
export function collide(evil: string, target: string): string {
  const goal = Number.parseInt(fnvOfBody(target), 16) | 0
  const state = step(OFFSET, `${normalizeBody(evil)}\n// `)
  // The hash before the last character's multiply.
  const before = Math.imul(goal, inverse)
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  for (const a of alphabet)
    for (const b of alphabet)
      for (const c of alphabet)
        for (const d of alphabet) {
          const prefix = a + b + c + d
          const hash = step(state, prefix)
          if (hash >>> 16 !== before >>> 16) continue
          const code = (hash ^ before) & 0xffff
          const char = String.fromCharCode(code)
          // A printable character that trimming keeps and that is not half of a surrogate pair.
          if (code < 0x21 || (code >= 0xd800 && code <= 0xdfff) || char.trim() !== char) continue
          return `${evil}\n// ${prefix}${char}`
        }
  throw new Error("collide: no suffix found")
}
