import * as solid from "solid-js"
import * as solidStore from "solid-js/store"
import * as solidWeb from "solid-js/web"
import * as effect from "effect"
import type { Plugin, StoreDeclaration } from "@opencode/plugin/gui"
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
 * default export checked to be a `Plugin.define` with a setup.
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
  const plugin = (Object.hasOwn(module.exports, "default") ? module.exports.default : module.exports) as unknown
  if (typeof plugin !== "object" || plugin === null)
    throw new Error("A plugin's ./gui-experimental bundle must default-export a `Plugin.define` object")
  const definition = plugin as Plugin.Definition
  if (typeof definition.setup !== "function" && typeof definition.main !== "function")
    throw new Error("A plugin's GUI must have a window `setup`, a `main` setup, or both")
  if (definition.i18n !== undefined && (typeof definition.i18n !== "object" || typeof definition.i18n.en !== "object"))
    throw new Error("A plugin's `i18n` must be an object with an `en` catalog")
  for (const [name, store] of Object.entries(definition.stores ?? {}) as [string, StoreDeclaration | undefined][])
    if (
      !store ||
      (store.scope !== "global" && store.scope !== "session") ||
      (typeof store.schema !== "object" && typeof store.schema !== "function")
    )
      throw new Error(`Store ${name} is not a Store.global or Store.session declaration`)
  return definition
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
