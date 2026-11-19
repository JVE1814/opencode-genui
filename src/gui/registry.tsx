import type { DirectiveDefinition } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import type { ComponentRegistry, ComponentRenderer, Components } from "@json-render/solid"
import type { GenuiCatalog } from "../catalog/index.ts"
import { chartComponents } from "./components/chart.tsx"
import { choiceComponents } from "./components/choices.tsx"
import { contentComponents } from "./components/content.tsx"
import { dataComponents } from "./components/data.tsx"
import { inputComponents } from "./components/inputs.tsx"
import { layoutComponents } from "./components/layout.tsx"
import { overlayComponents } from "./components/overlay.tsx"
import { buildRegistry, createElementRenderer, guardDirectives, type ElementImpl } from "./element.ts"
import { UnknownElement } from "./fallback.tsx"

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

/** What every surface renders with: json-render's `registry`, the Renderer's `fallback`, and the `directives`. */
export interface Rendering {
  readonly registry: ComponentRegistry
  readonly fallback: ComponentRenderer
  readonly directives: DirectiveDefinition[]
}

let rendering: Rendering | undefined

/**
 * Built on first use (the bundle is also evaluated in the desktop's main process, where it must stay cheap).
 *
 * Every element, known type or not, renders through one element renderer (src/gui/element.ts) that keeps children
 * mounted while the element changes and follows changes of its type; it is both each registry entry and the
 * fallback. Action handlers are not part of it: each surface passes its own (src/gui/actions.ts) to its provider.
 */
export function getRendering(): Rendering {
  if (!rendering) {
    const components = genuiComponents() as unknown as Record<string, ElementImpl>
    const element = createElementRenderer(components, UnknownElement)
    rendering = {
      registry: buildRegistry(Object.keys(components), element),
      fallback: element,
      directives: guardDirectives(standardDirectives),
    }
  }
  return rendering
}
