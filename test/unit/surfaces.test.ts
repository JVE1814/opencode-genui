import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearSurfaces,
  getSurface,
  MAX_SURFACES,
  peekSurface,
  surfaceKey,
  surfaceKeyPrefix,
} from "../../src/runtime/surfaces.ts"

beforeEach(() => clearSurfaces())

describe("surfaceKey", () => {
  test("separates sessions, kinds and ids", () => {
    const keys = new Set([
      surfaceKey("ses_1", "inline", "a"),
      surfaceKey("ses_1", "canvas", "a"),
      surfaceKey("ses_2", "inline", "a"),
      surfaceKey(undefined, "inline", "a"),
    ])
    expect(keys.size).toBe(4)
    expect(surfaceKey("ses_1", "canvas", "main").startsWith(surfaceKeyPrefix("ses_1"))).toBe(true)
    expect(surfaceKey("ses_10", "canvas", "main").startsWith(surfaceKeyPrefix("ses_1"))).toBe(false)
  })
})

describe("getSurface", () => {
  test("creates once and returns the same runtime afterwards", () => {
    const key = surfaceKey("ses_1", "inline", "x")
    expect(peekSurface(key)).toBeUndefined()
    const runtime = getSurface(key)
    runtime.height = 120
    runtime.store.set("/a", 1)
    expect(getSurface(key)).toBe(runtime)
    expect(peekSurface(key)?.height).toBe(120)
    expect(getSurface(key).store.get("/a")).toBe(1)
    expect(runtime.key).toBe(key)
  })

  test("evicts the least recently used beyond the limit", () => {
    for (let index = 0; index < MAX_SURFACES; index++) getSurface(`k${index}`)
    getSurface("k0")
    getSurface("new")
    expect(peekSurface("k0")).toBeDefined()
    expect(peekSurface("k1")).toBeUndefined()
    expect(peekSurface("k2")).toBeDefined()
    expect(peekSurface("new")).toBeDefined()
  })

  test("peek does not count as use", () => {
    for (let index = 0; index < MAX_SURFACES; index++) getSurface(`k${index}`)
    peekSurface("k0")
    getSurface("new")
    expect(peekSurface("k0")).toBeUndefined()
  })
})

describe("clearSurfaces", () => {
  test("clears matching keys or everything", () => {
    getSurface(surfaceKey("ses_1", "inline", "a"))
    getSurface(surfaceKey("ses_1", "canvas", "b"))
    getSurface(surfaceKey("ses_2", "inline", "a"))
    clearSurfaces((key) => key.startsWith(surfaceKeyPrefix("ses_1")))
    expect(peekSurface(surfaceKey("ses_1", "inline", "a"))).toBeUndefined()
    expect(peekSurface(surfaceKey("ses_1", "canvas", "b"))).toBeUndefined()
    expect(peekSurface(surfaceKey("ses_2", "inline", "a"))).toBeDefined()
    clearSurfaces()
    expect(peekSurface(surfaceKey("ses_2", "inline", "a"))).toBeUndefined()
  })
})
