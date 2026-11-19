import { defineRegistry, type Actions, type ComponentRegistry, type Components } from "@json-render/solid"
import { ACTION_NAMES } from "../catalog/actions.ts"
import { getCatalog, type GenuiCatalog } from "../catalog/index.ts"
import { chartComponents } from "./components/chart.tsx"
import { choiceComponents } from "./components/choices.tsx"
import { contentComponents } from "./components/content.tsx"
import { dataComponents } from "./components/data.tsx"
import { inputComponents } from "./components/inputs.tsx"
import { layoutComponents } from "./components/layout.tsx"
import { overlayComponents } from "./components/overlay.tsx"

/** Every catalog component's native implementation. `satisfies` makes a missing one a type error. */
export function genuiComponents(): Components<GenuiCatalog> {
  return {
    ...layoutComponents,
    ...contentComponents,
    ...inputComponents,
    ...choiceComponents,
    ...dataComponents,
    ...chartComponents,
    ...overlayComponents,
  } satisfies Components<GenuiCatalog>
}

let registry: ComponentRegistry | undefined

/**
 * The component registry every surface renders with, built on first use (the bundle is also evaluated in the desktop's
 * main process, where it must stay cheap). The registry's own action handlers are no-ops: each surface passes the real
 * ones (src/gui/actions.ts) to its JSONUIProvider, bound to that surface.
 */
export function getRegistry(): ComponentRegistry {
  if (!registry) {
    const actions = Object.fromEntries(
      ACTION_NAMES.map((name) => [name, async () => {}]),
    ) as unknown as Actions<GenuiCatalog>
    registry = defineRegistry(getCatalog(), { components: genuiComponents(), actions }).registry
  }
  return registry
}
