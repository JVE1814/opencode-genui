/**
 * A seeded generator for randomized tests: `draw(n)` is an integer in [0, n). A 32-bit linear congruential generator in
 * integer arithmetic (Math.imul: `seed * 1103515245` in doubles loses its low bits past 2^53, which made the sequence
 * fall into a short cycle), read from its high bits (the low bits of an LCG have short periods).
 */
export function seeded(seed: number): (n: number) => number {
  let state = seed >>> 0
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return Math.floor((state / 2 ** 32) * n)
  }
}
