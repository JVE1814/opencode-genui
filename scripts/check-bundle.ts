#!/usr/bin/env bun
/**
 * Checks the desktop bundle (dist/gui-experimental.cjs) after `vite build`:
 *
 *   bun scripts/check-bundle.ts [path/to/bundle.cjs]
 *
 * 1. Every `require()` names a module the app provides to plugin GUIs; anything else would throw when the app loads it.
 * 2. Size budget: the app reads and evaluates the bundle in every window and in the main process.
 * 3. Main-process smoke test: the app also evaluates the bundle in Electron's main process, where Solid and the other
 *    window-only modules are inert placeholders and `@opencode/plugin/gui` is the main SDK (which has no window
 *    registries). Evaluation must not throw, and the default export must be a `Plugin.define` with a window `setup`.
 *
 * Exits 1 with a message per problem.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

// Copied from node_modules/@opencode/plugin/dist/gui/modules.js (@opencode/plugin 2.3.2), `pluginSharedModules` and
// `pluginWindowModules`. Checked against the installed SDK below, so an SDK update that changes them is reported.
const SHARED_MODULES = [
  "effect",
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/rpc",
  "@opencode/schema/rpc",
  "@opencode/client",
  "@opencode/client/effect",
] as const
const WINDOW_MODULES = [
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "@opencode/client/solid",
] as const

const BUDGET_BYTES = 600 * 1024

const problems: string[] = []
const warnings: string[] = []

const root = path.resolve(import.meta.dir, "..")
const file = path.resolve(process.cwd(), process.argv[2] ?? path.join(root, "dist/gui-experimental.cjs"))

let code: string
try {
  code = readFileSync(file, "utf8")
} catch (error) {
  console.error(`check-bundle: cannot read ${file}: ${(error as Error).message}. Run \`vite build\` first.`)
  process.exit(1)
}

// The installed SDK's own lists, read by path (its export map hides the file); a mismatch means this copy is stale.
try {
  const sdk = (await import(path.join(root, "node_modules/@opencode/plugin/dist/gui/modules.js"))) as {
    pluginSharedModules: readonly string[]
    pluginWindowModules: readonly string[]
  }
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))
  if (!same(sdk.pluginSharedModules, SHARED_MODULES) || !same(sdk.pluginWindowModules, WINDOW_MODULES))
    warnings.push(
      "the installed @opencode/plugin lists different provided modules than scripts/check-bundle.ts; update the copy",
    )
} catch {
  warnings.push("could not read the installed SDK's module lists to compare (node_modules/@opencode/plugin missing?)")
}

// 1. Required modules.
const provided = new Set<string>([...SHARED_MODULES, ...WINDOW_MODULES])
const required = new Set<string>()
for (const match of code.matchAll(/\brequire\(\s*(["'`])([^"'`]+)\1\s*\)/g)) required.add(match[2]!)
for (const name of required) {
  if (provided.has(name)) continue
  if (name === "electron" || name.startsWith("node:"))
    problems.push(`requires "${name}": only the main process has it; a window gets an inert placeholder`)
  else problems.push(`requires "${name}", which the app does not provide to plugin GUIs (bundle it instead)`)
}
const calls = code.match(/\brequire\s*\(/g)?.length ?? 0
const literal = [...code.matchAll(/\brequire\(\s*(["'`])([^"'`]+)\1\s*\)/g)].length
if (calls > literal) warnings.push(`${calls - literal} require( call(s) with a computed name; check they never run`)

// 2. Size.
const bytes = Buffer.byteLength(code)
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
if (bytes > BUDGET_BYTES) problems.push(`size ${kb(bytes)} is over the ${kb(BUDGET_BYTES)} budget`)

// 3. Main-process smoke test.
function inert(name: string): unknown {
  // Like the app's `inertModule` (packages/plugin/src/gui/host.ts): any read, call or construction returns another
  // placeholder; never a thenable; nothing is an instance of it.
  const label = `[inert module ${name}]`
  const handler: ProxyHandler<object> = {
    get(_, key) {
      if (key === "then") return undefined
      if (key === Symbol.toPrimitive || key === "toString") return () => label
      if (key === Symbol.hasInstance) return () => false
      return placeholder
    },
    set: () => true,
    defineProperty: () => true,
    deleteProperty: () => true,
    apply: () => placeholder,
    construct: () => placeholder,
  }
  const placeholder: object = new Proxy(function inert() {}, handler)
  return placeholder
}

const real = new Map<string, unknown>()
real.set("effect", await import("effect"))
// Main maps the window SDK's name to the main SDK, which shares Plugin, Store, Registry, Contract and Ipc but has no
// window registries (CodeBlock, Panel, ...): reading one at module scope in main yields undefined.
const mainSdk = await import("@opencode/plugin/gui/main")
real.set("@opencode/plugin/gui", mainSdk)
real.set("@opencode/plugin/gui/main", mainSdk)
for (const name of ["@opencode/plugin/rpc", "@opencode/schema/rpc", "@opencode/client", "@opencode/client/effect"])
  if (required.has(name))
    try {
      real.set(name, await import(name))
    } catch {
      warnings.push(`could not load "${name}" for the smoke test; using a placeholder`)
      real.set(name, inert(name))
    }

const mainRequire = (name: string): unknown => {
  if (real.has(name)) return real.get(name)
  if ((WINDOW_MODULES as readonly string[]).includes(name)) return inert(name)
  // Main has these for real; check 1 already reports them, so the smoke test goes on past them.
  if (name === "electron" || name.startsWith("node:")) return inert(name)
  throw new Error(`Plugin GUI bundle requires a module the app does not share: ${name}`)
}

try {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  // The bundle is this repository's own build output, evaluated exactly as the app evaluates it.
  new Function("require", "module", "exports", code)(mainRequire, module, module.exports)
  const plugin = (Object.hasOwn(module.exports, "default") ? module.exports.default : module.exports) as Record<
    string,
    unknown
  >
  if (typeof plugin !== "object" || plugin === null)
    problems.push("the default export is not an object (expected `export default Plugin.define({ ... })`)")
  else {
    if (typeof plugin.setup !== "function") problems.push("the default export has no window `setup` function")
    if (plugin.main !== undefined && typeof plugin.main !== "function") problems.push("`main` is not a function")
    const i18n = plugin.i18n as Record<string, unknown> | undefined
    if (i18n !== undefined && (typeof i18n !== "object" || typeof i18n.en !== "object"))
      problems.push("`i18n` must be an object with an `en` catalog")
    for (const [name, store] of Object.entries((plugin.stores ?? {}) as Record<string, Record<string, unknown>>))
      if (store?.scope !== "global" && store?.scope !== "session")
        problems.push(`store "${name}" is not a Store.global or Store.session declaration`)
  }
} catch (error) {
  problems.push(
    `evaluating the bundle as the main process does threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  )
}

const relative = path.relative(process.cwd(), file)
console.log(`check-bundle: ${relative.startsWith("..") || !relative ? file : relative}`)
console.log(`  size      ${kb(bytes)} (budget ${kb(BUDGET_BYTES)})`)
console.log(`  requires  ${[...required].sort().join(", ") || "(nothing)"}`)
for (const warning of warnings) console.warn(`  warning   ${warning}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`  FAIL      ${problem}`)
  process.exit(1)
}
console.log("  ok        provided modules only, within budget, evaluates in the main process")
