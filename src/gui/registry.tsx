import type { DirectiveDefinition } from "@json-render/core"
import { createComponent, type Context, type JSX } from "solid-js"
import { standardDirectives } from "@json-render/directives"
import * as jsonRender from "@json-render/solid"
import {
  useRepeatScope,
  useStateStore,
  type ComponentRegistry,
  type ComponentRenderer,
  type Components,
} from "@json-render/solid"
import type { GenuiCatalog } from "../catalog/index.ts"
import { chartComponents } from "./components/chart.tsx"
import { choiceComponents } from "./components/choices.tsx"
import { contentComponents } from "./components/content.tsx"
import { dataComponents } from "./components/data.tsx"
import { inputComponents } from "./components/inputs.tsx"
import { layoutComponents } from "./components/layout.tsx"
import { overlayComponents } from "./components/overlay.tsx"
import { groupEditsBy } from "../runtime/state.ts"
import {
  buildRegistry,
  createElementRenderer,
  guardDirectives,
  type ElementImpl,
  type JsonRenderHooks,
} from "./element.ts"
import { UnknownElement } from "./fallback.tsx"

/**
 * json-render's current work (exported by the patch in patches/): one change and all it sets off, also across tasks.
 * State stores keep a user action's edits together by it (see groupEditsBy in src/runtime/state.ts).
 */
export const currentWork = (jsonRender as unknown as { readonly currentWork?: () => object }).currentWork

/**
 * What an element's evaluation that json-render defers to a later task is lent (see EvaluationLendContext in
 * patches/@json-render%2Fsolid): a function, called as it defers, that returns a runner to wrap the later evaluation in,
 * or undefined. Surfaces lend the activation that showed the element (see lendActivation in src/gui/outward.ts).
 */
type Lend = () => ((run: () => void) => void) | undefined
const EvaluationLendContext = (jsonRender as unknown as { readonly EvaluationLendContext?: Context<Lend | undefined> })
  .EvaluationLendContext

/** Provides `lend` to the evaluations json-render defers in `children` (see EvaluationLendContext). */
export function EvaluationLend(props: { readonly lend: Lend; readonly children: JSX.Element }): JSX.Element {
  if (!EvaluationLendContext) return props.children
  return createComponent(EvaluationLendContext.Provider, {
    value: props.lend,
    get children() {
      return props.children
    },
  })
}

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
    groupEditsBy(currentWork)
    const components = genuiComponents() as unknown as Record<string, ElementImpl>
    const RepeatRowsContext = (jsonRender as unknown as Pick<JsonRenderHooks, "RepeatRowsContext">).RepeatRowsContext
    const element = createElementRenderer(components, UnknownElement, {
      useStateStore,
      useRepeatScope,
      ...(RepeatRowsContext ? { RepeatRowsContext } : {}),
    })
    rendering = {
      registry: buildRegistry(Object.keys(components), element),
      fallback: element,
      directives: guardDirectives(standardDirectives),
    }
  }
  return rendering
}
