import * as solid from "solid-js"
import * as solidStore from "solid-js/store"
import * as solidWeb from "solid-js/web"
import * as effect from "effect"
import type { Plugin } from "@opencode/plugin/gui"
import { bundleDefinitionProblem, defaultExport } from "../../scripts/bundle-definition.ts"
import * as sdk from "../fake-sdk/index.ts"

/**
 * The modules a window gives a plugin's `./gui-experimental` bundle, each the page's own instance, as the app's
 * packages/app/src/runtime/plugin/module.ts does. The SDK's names both map to the window SDK (here: the fake one).
 * The other modules the app shares (@opencode/plugin/rpc, @opencode/client, ...) are not available in the playground;
 * the genui GUI does not use them.
 */
const modules: Record<string, object> = {
  "solid-js": solid,
  "solid-js/web": solidWeb,
  "solid-js/store": solidStore,
  effect,
  "@opencode/plugin/gui": sdk,
  "@opencode/plugin/gui/main": sdk,
}

// A window answers `electron` and Node built-ins with an inert placeholder (they exist only in main).
const MAIN_ONLY = /^(electron|node:.*|fs|path|os|child_process|crypto|url|util|events|stream|buffer|http|https|net)$/

function inert(name: string): unknown {
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

/**
 * Evaluates a built bundle the way the app does (packages/plugin/src/gui/host.ts `evaluatePluginBundle`): CommonJS
 * code run with `new Function("require", "module", "exports", code)`, `require` limited to the shared modules, the
 * default export checked with the app's own schema (scripts/bundle-definition.ts): every store a Store.global or
 * Store.session with an effect Schema, every catalog message a string, a setup.
 */
export function evaluateBundle(code: string, required: string[] = []): Plugin.Definition {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  const require = (name: string) => {
    required.push(name)
    const found = modules[name]
    if (found) return found
    if (MAIN_ONLY.test(name)) return inert(name)
    throw new Error(`Plugin GUI bundle requires a module the app does not share: ${name}`)
  }
  new Function("require", "module", "exports", code)(require, module, module.exports)
  const plugin = defaultExport(module.exports)
  const problem = bundleDefinitionProblem(plugin)
  if (problem) throw new Error(`A plugin's ./gui-experimental bundle is refused: ${problem}`)
  return plugin as Plugin.Definition
}

/** Fetches and evaluates a bundle; `url` is one the playground serves (the built plugin or the stub). */
export async function loadBundle(
  url: string,
): Promise<{ definition: Plugin.Definition; required: string[]; size: number }> {
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText} (build it first)`)
  const code = await response.text()
  const required: string[] = []
  const definition = evaluateBundle(code, required)
  return { definition, required, size: code.length }
}
