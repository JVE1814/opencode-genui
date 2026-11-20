import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { evaluateBundle } from "../../playground/host/loader.ts"
import { bundleDefinitionProblem } from "../../scripts/bundle-definition.ts"

// What the app refuses, check-bundle and the playground's loader refuse too (review 4, FIDELITY#8); and installing the
// package from git runs no build (FIDELITY#1).

const root = path.resolve(import.meta.dir, "../..")

describe("the app's check of a bundle's default export", () => {
  test.each([
    [
      "a catalog message that is not a string",
      { setup() {}, i18n: { en: { "confirm.title": 1 } } },
      'at ["i18n"]["en"]',
    ],
    [
      "a store schema that is not a Schema",
      { setup() {}, stores: { prefs: { scope: "global", schema: {} } } },
      "schema",
    ],
    [
      "a store of an unknown scope",
      { setup() {}, stores: { prefs: { scope: "window", schema: Schema.String } } },
      "scope",
    ],
    ["an unknown OS", { setup() {}, os: ["beos"] }, "os"],
    ["an icon that is not text", { setup() {}, icons: { logo: 1 } }, "icons"],
    ["a setup that is not a function", { setup: true }, "setup"],
    ["no setup at all", {}, "neither a window `setup` nor a `main` setup"],
  ])("refuses %s", (_, plugin, where) => {
    expect(bundleDefinitionProblem(plugin)).toContain(where)
  })

  test("accepts a well-formed definition", () => {
    expect(
      bundleDefinitionProblem({
        setup() {},
        i18n: { en: { "a.b": "text" } },
        stores: { prefs: { scope: "global", schema: Schema.Struct({ shown: Schema.Boolean }) } },
        os: ["macos", "linux"],
      }),
    ).toBeUndefined()
    expect(bundleDefinitionProblem({ main() {} })).toBeUndefined()
  })
})

describe("the playground's loader", () => {
  test("refuses what the app refuses", () => {
    expect(() => evaluateBundle('exports.default = { setup() {}, i18n: { en: { "a": 1 } } }')).toThrow(
      "Expected string",
    )
    expect(() =>
      evaluateBundle('exports.default = { setup() {}, stores: { s: { scope: "global", schema: {} } } }'),
    ).toThrow("schema")
  })

  test("takes what the app takes, from exports.default or module.exports", () => {
    expect(evaluateBundle("exports.default = { setup() {} }").setup).toBeTypeOf("function")
    expect(evaluateBundle("module.exports = { setup() {} }").setup).toBeTypeOf("function")
  })
})

describe("check-bundle", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "genui-check-bundle-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const check = (name: string, code: string) => {
    const file = path.join(dir, `${name}.cjs`)
    writeFileSync(file, code)
    const run = Bun.spawnSync(["bun", path.join(root, "scripts/check-bundle.ts"), file], { cwd: root })
    return { status: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` }
  }

  test("passes a bundle the app takes", () => {
    const result = check("ok", 'exports.default = { setup() {}, i18n: { en: { "a": "b" } } }')
    expect(result.output).toContain("ok")
    expect(result.status).toBe(0)
  })

  test.each([
    [
      "a catalog message that is not a string",
      'exports.default = { setup() {}, i18n: { en: { "a": 1 } } }',
      "Expected string",
    ],
    [
      "a store without an effect Schema",
      'exports.default = { setup() {}, stores: { s: { scope: "session", schema: {} } } }',
      '["stores"]["s"]["schema"]',
    ],
    [
      "`self` at module scope (Bun has it, Node does not)",
      "self.x = 1; exports.default = { setup() {} }",
      "self is not defined",
    ],
    ["`Worker` at module scope", "new Worker('x'); exports.default = { setup() {} }", "Worker is not defined"],
    ["`Bun` at module scope", "Bun.version; exports.default = { setup() {} }", "FAIL"],
    ["a main-only bundle (genui needs its window setup)", "exports.default = { main() {} }", "no window `setup`"],
  ])("fails %s", (name, code, expected) => {
    const result = check(name.replace(/\W+/g, "-"), code)
    expect(result.output).toContain(expected)
    expect(result.status).toBe(1)
  })

  test("leaves Bun's globals as they were", () => {
    check("self-again", "self.x = 1; exports.default = { setup() {} }")
    expect(typeof self).toBe("object")
  })
})

describe("installing from git runs no build", () => {
  // pacote (which npm and the app's installer use for a git dependency) runs `npm install` with dev dependencies in
  // the clone when package.json has any of these scripts (or workspaces), ignoring --ignore-scripts: it needs npm on
  // PATH, and installs every dev dependency, with their install scripts, on each install.
  const PREPARE_SCRIPTS = ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
    workspaces?: unknown
    dependencies?: Record<string, string>
    files?: string[]
  }

  test("package.json has none of the scripts that make a git install build", () => {
    expect(PREPARE_SCRIPTS.filter((name) => Object.hasOwn(manifest.scripts ?? {}, name))).toEqual([])
    expect(manifest.workspaces).toBeUndefined()
  })

  test("what the app loads is committed and shipped: the server entry, the skill and the desktop bundle", () => {
    expect(manifest.dependencies ?? {}).toEqual({})
    for (const file of ["src/index.ts", "skills", "dist/gui-experimental.cjs"]) expect(manifest.files).toContain(file)
  })
})
