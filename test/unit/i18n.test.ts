import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { en } from "../../src/gui/i18n/en.ts"

const SRC = path.join(import.meta.dir, "../../src")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === "i18n" ? [] : sources(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

interface Use {
  readonly file: string
  readonly key: string
}

function collect(pattern: RegExp): Use[] {
  return sources(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(pattern)].flatMap((match) =>
      match.slice(1).flatMap((key) => (key === undefined ? [] : [{ file: path.relative(SRC, file), key }])),
    ),
  )
}

// The app's shared keys (`common.*`) are not ours to define.
const ours = (use: Use) => !use.key.startsWith("common.")

describe("i18n", () => {
  test("every literal t(...) key used in src exists in en", () => {
    const uses = [
      ...collect(/\bt\(\s*"([^"]+)"/g),
      // t(count === 1 ? "a.one" : "a.other", ...)
      ...collect(/\bt\(\s*[^"()`]+\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g),
    ].filter(ours)
    expect(uses.length).toBeGreaterThan(50)
    expect(uses.some((use) => use.key === "c.chart.points.other")).toBe(true)
    const missing = uses.filter((use) => !Object.hasOwn(en, use.key)).map((use) => `${use.file}: ${use.key}`)
    expect(missing).toEqual([])
  })

  test("every plural(...) key has .one and .other forms", () => {
    const uses = collect(/\bplural\(\s*(?:[\w.]+,\s*)?"([^"]+)"/g).filter(ours)
    const missing = uses
      .flatMap((use) => [`${use.key}.one`, `${use.key}.other`].map((key) => ({ ...use, key })))
      .filter((use) => !Object.hasOwn(en, use.key))
      .map((use) => `${use.file}: ${use.key}`)
    expect(missing).toEqual([])
  })

  test("every t(`prefix${...}`) template matches at least one key", () => {
    const uses = collect(/\bt\(\s*`([^`$]+)\$\{/g).filter(ours)
    const keys = Object.keys(en)
    const missing = uses
      .filter((use) => !keys.some((key) => key.startsWith(use.key)))
      .map((use) => `${use.file}: ${use.key}…`)
    expect(missing).toEqual([])
  })

  test("messages are non-empty and their placeholders are well formed", () => {
    for (const [key, message] of Object.entries(en)) {
      expect(message.trim().length, key).toBeGreaterThan(0)
      expect(message.replace(/\{\{\s*[\w.-]+\s*\}\}/g, ""), key).not.toMatch(/\{\{|\}\}/)
    }
  })
})
