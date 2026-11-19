import { useActions, useStateStore } from "@json-render/solid"
import type { ChainLink } from "./actions.ts"

/**
 * Connects genui's action handlers to json-render's provider, for onSuccess/onError chains (see ChainLink in
 * src/gui/actions.ts): a chained action runs through json-render's own `execute`, and a `set` through its state store,
 * so watches see it. Render it inside `JSONUIProvider`, before the renderer. It renders nothing.
 */
export function ChainBridge(props: { readonly link: ChainLink }): null {
  const actions = useActions()
  const state = useStateStore()
  props.link.execute = (binding) => actions.execute(binding)
  props.link.set = (path, value) => state.set(path, value)
  return null
}
