import { ErrorBoundary, onMount, Show, untrack, type JSX } from "solid-js"
import { PluginContext } from "../fake-sdk/internal.ts"
import type { App } from "./app.ts"

/**
 * Renders one plugin contribution as the app does (packages/app/src/runtime/plugin/render.tsx `Contribution`): under
 * the plugin's context, so `usePlugin()` works, and with error isolation: a render that throws records the error,
 * renders nothing and calls `failed`, and the rest of the window keeps working. The render runs once, untracked; its
 * own reactivity updates it.
 */
export function Contribution(props: {
  readonly app: App
  readonly plugin: string
  readonly where: string
  readonly failed?: () => void
  readonly children: () => JSX.Element
}) {
  return (
    <Show when={props.app.contexts()[props.plugin]} keyed>
      {(context) => (
        <ErrorBoundary
          fallback={(error) => {
            onMount(() => {
              props.app.fail(props.plugin, props.where, error)
              props.failed?.()
            })
            return null
          }}
        >
          <PluginContext.Provider value={context}>{untrack(props.children)}</PluginContext.Provider>
        </ErrorBoundary>
      )}
    </Show>
  )
}
