import { createEffect, createRoot, getOwner, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import type { Plugin, PluginOptions, SetupContext } from "@opencode/plugin/gui"
import { PluginContext } from "../fake-sdk/internal.ts"
import { createApp, type App, type AppOptions } from "./app.ts"
import { Shell } from "./chrome.tsx"
import { createPluginContext } from "./context.ts"
import { createRegion, type Region } from "./region.ts"
import type { Lifetime } from "./registry.ts"
import { applyTheme } from "./theme.ts"

export type { App } from "./app.ts"

export interface PluginInstance {
  readonly id: string
  readonly context: SetupContext<Plugin.Definition>
  /** Disposes the plugin as the app does when it is disabled or reloaded: cleanups run, `ctx.signal` aborts. */
  dispose(): void
}

export interface PlaygroundHost {
  readonly app: App
  readonly region: Region
  /** Loads a plugin: builds its context and runs its window `setup` synchronously under its own Solid root. */
  load(input: {
    readonly id: string
    readonly definition: Plugin.Definition
    readonly options?: PluginOptions
  }): PluginInstance
  /** Renders the fake app window into `element`. */
  mount(element: HTMLElement, chrome?: Omit<Parameters<typeof Shell>[0], "app" | "region">): () => void
}

/**
 * Creates the fake desktop host. With `definition`, it also loads that plugin (as `id`, default "genui"), so
 * `createHost({ definition, options })` is enough to run a plugin; `host.load` adds more.
 */
export function createHost(
  input: {
    readonly definition?: Plugin.Definition
    readonly options?: PluginOptions
    readonly id?: string
    readonly app?: Partial<AppOptions>
  } = {},
): PlaygroundHost & { readonly plugin?: PluginInstance } {
  // The app lives as long as the page, under one root of its own.
  const app = createRoot(() =>
    createApp({
      persist: input.app?.persist ?? true,
      window: input.app?.window ?? 20,
      locale: input.app?.locale ?? "en",
      mode: input.app?.mode ?? "light",
    }),
  )
  const region = createRoot(() => createRegion(app))
  // The theme follows the mode, as the app's ThemeProvider does.
  createRoot(() => createEffect(() => applyTheme(app.mode())))

  const load: PlaygroundHost["load"] = (plugin) =>
    createRoot((dispose) => {
      const controller = new AbortController()
      const cleanups: (() => void)[] = []
      const lifetime: Lifetime & { disposed: boolean } = {
        disposed: false,
        onDispose: (cleanup) => void cleanups.push(cleanup),
      }
      const context = createPluginContext({
        app,
        region,
        id: plugin.id,
        definition: plugin.definition,
        options: plugin.options ?? {},
        lifetime,
        signal: controller.signal,
      })
      // Setup runs under the plugin's root owner, which carries its context: usePlugin() works in setup too.
      const owner = getOwner()!
      owner.context = { ...owner.context, [PluginContext.id]: context }
      app.setContext(plugin.id, context)

      onCleanup(() => {
        lifetime.disposed = true
        controller.abort()
        for (const cleanup of cleanups.splice(0)) cleanup()
        app.setContext(plugin.id, undefined)
        app.toasts.dismissPlugin(plugin.id)
      })

      try {
        const result = plugin.definition.setup?.(context) as unknown
        if (result && typeof (result as PromiseLike<unknown>).then === "function")
          throw new Error("A plugin's window setup must be synchronous; it returned a promise")
        if (typeof result === "function")
          onCleanup(() => {
            try {
              void (result as () => unknown)()
            } catch (error) {
              app.fail(plugin.id, "setup cleanup", error)
            }
          })
      } catch (error) {
        app.fail(plugin.id, "setup", error)
        dispose()
        throw error
      }
      return { id: plugin.id, context, dispose }
    })

  const host: PlaygroundHost & { plugin?: PluginInstance } = {
    app,
    region,
    load,
    mount(element, chrome) {
      applyTheme(app.mode())
      return render(() => <Shell app={app} region={region} {...chrome} />, element)
    },
  }
  if (input.definition)
    host.plugin = load({ id: input.id ?? "genui", definition: input.definition, options: input.options })
  return host
}
