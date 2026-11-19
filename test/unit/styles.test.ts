import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// The rules in the header of src/gui/styles/base.css, checked over every genui stylesheet.
const STYLES = path.join(import.meta.dir, "../../src/gui/styles")
const TOKENS = path.join(import.meta.dir, "../../node_modules/@opencode/ui/src/styles")

/**
 * Selectors outside [data-genui], each one a documented host-markup exception in chrome.css (owned with the session
 * UI): progressive enhancements of the app's own markup, which is not a contract. Add one here only with a comment in
 * the stylesheet saying why.
 */
const HOST_MARKUP_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  "chrome.css": [
    // The app's raw code block while a spec or canvas block streams: kept short and faded.
    '[data-component="markdown-code"]:is([data-language="spec" i], [data-language="canvas" i]):not([data-code-content]) > pre',
  ],
}

/**
 * A selector that only matches inside a surface: it starts with [data-genui], or with a state of the app's root
 * (`:root[data-motion="reduce"]`, the app's reduced-motion setting) followed by [data-genui].
 */
const SCOPED = /^(?::root(?:\[[^\]]*\])*\s+)?\[data-genui\]/

const sheets = readdirSync(STYLES)
  .filter((name) => name.endsWith(".css"))
  .map((name) => ({ name, css: stripComments(readFileSync(path.join(STYLES, name), "utf8")) }))

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

interface Rule {
  readonly selector: string
  readonly body: string
}

/** Style rules with their selector lists, descending into conditional at-rules; @keyframes and @property are skipped. */
function rules(css: string): Rule[] {
  const out: Rule[] = []
  let index = 0
  while (index < css.length) {
    const open = css.indexOf("{", index)
    if (open < 0) break
    const prelude = css.slice(index, open).trim()
    let depth = 1
    let end = open + 1
    while (end < css.length && depth > 0) {
      if (css[end] === "{") depth++
      else if (css[end] === "}") depth--
      end++
    }
    const body = css.slice(open + 1, end - 1)
    if (prelude.startsWith("@")) {
      if (/^@(media|supports|container|layer|starting-style)\b/.test(prelude)) out.push(...rules(body))
    } else out.push({ selector: prelude.replace(/\s+/g, " "), body })
    index = end
  }
  return out
}

/** A selector list split at top-level commas (not inside :is(), :not() or attribute values). */
function selectors(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0
  for (let index = 0; index < list.length; index++) {
    const char = list[index]!
    if (quote) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[") depth++
    else if (char === ")" || char === "]") depth--
    else if (char === "," && depth === 0) {
      parts.push(list.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(list.slice(start).trim())
  return parts.filter(Boolean)
}

/** Custom properties a stylesheet defines (`--name:`). */
function definitions(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!))
}

/** Custom properties a stylesheet reads (`var(--name`). */
function uses(css: string): Set<string> {
  return new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!))
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return cssFiles(full)
    return name.endsWith(".css") ? [full] : []
  })
}

describe("genui stylesheets", () => {
  test("are all present", () => {
    expect(sheets.map((sheet) => sheet.name).toSorted()).toEqual(
      ["base", "chart", "chrome", "content", "data", "inputs", "layout", "overlay"].map((name) => `${name}.css`),
    )
  })

  test("scope every selector under [data-genui], except the listed host-markup exceptions", () => {
    const unscoped: string[] = []
    const allowed = new Set<string>()
    for (const sheet of sheets) {
      for (const rule of rules(sheet.css)) {
        for (const selector of selectors(rule.selector)) {
          if (SCOPED.test(selector)) continue
          const exceptions = HOST_MARKUP_EXCEPTIONS[sheet.name] ?? []
          if (exceptions.includes(selector)) allowed.add(`${sheet.name}: ${selector}`)
          else unscoped.push(`${sheet.name}: ${selector}`)
        }
      }
    }
    expect(unscoped).toEqual([])
    // Every listed exception still exists, so the list cannot grow stale.
    const listed = Object.entries(HOST_MARKUP_EXCEPTIONS).flatMap(([file, list]) =>
      list.map((item) => `${file}: ${item}`),
    )
    expect([...allowed].toSorted()).toEqual(listed.toSorted())
  })

  test("parse into rules (the checks above see every rule)", () => {
    for (const sheet of sheets) {
      const count = rules(sheet.css).length
      expect(count, sheet.name).toBeGreaterThan(5)
      expect(sheet.css.split("{").length - 1, sheet.name).toBe(sheet.css.split("}").length - 1)
    }
  })

  test("use only --gu-* aliases that base.css defines, and private --_* properties", () => {
    const base = sheets.find((sheet) => sheet.name === "base.css")!
    const aliases = new Set([...definitions(base.css)].filter((name) => name.startsWith("--gu-")))
    const problems: string[] = []
    for (const sheet of sheets) {
      for (const name of uses(sheet.css)) {
        if (name.startsWith("--gu-")) {
          if (!aliases.has(name)) problems.push(`${sheet.name}: ${name} is not defined in base.css`)
        } else if (!name.startsWith("--_") && sheet.name !== "base.css") {
          problems.push(`${sheet.name}: ${name} is not a --gu-* alias (add one to base.css)`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  test("set each private --_* property they read, in the same stylesheet or from a component's inline style", () => {
    const components = path.join(import.meta.dir, "../../src/gui/components")
    const inline = new Set(
      readdirSync(components)
        .flatMap((name) => [...readFileSync(path.join(components, name), "utf8").matchAll(/["'`](--_[\w-]+)["'`]/g)])
        .map((match) => match[1]!),
    )
    const problems: string[] = []
    for (const sheet of sheets) {
      const own = new Set([...definitions(sheet.css), ...inline])
      for (const name of uses(sheet.css))
        if (name.startsWith("--_") && !own.has(name)) problems.push(`${sheet.name}: ${name}`)
    }
    expect(problems).toEqual([])
  })

  test("map base.css aliases only to tokens @opencode/ui defines", () => {
    const tokens = new Set(cssFiles(TOKENS).flatMap((file) => [...definitions(readFileSync(file, "utf8"))]))
    expect(tokens.size).toBeGreaterThan(500)
    const base = sheets.find((sheet) => sheet.name === "base.css")!
    const missing = [...uses(base.css)].filter((name) => !name.startsWith("--gu-") && !name.startsWith("--_"))
    expect(missing.length).toBeGreaterThan(50)
    expect(missing.filter((name) => !tokens.has(name))).toEqual([])
  })
})
