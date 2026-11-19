import { defineCatalog } from "@json-render/core"
import { schema } from "@json-render/solid/schema"
import { actionDefinitions } from "./actions.ts"
import { componentDefinitions } from "./components.ts"

export * from "./actions.ts"
export * from "./components.ts"

const create = () => defineCatalog(schema, { components: componentDefinitions, actions: actionDefinitions })

export type GenuiCatalog = ReturnType<typeof create>

let catalog: GenuiCatalog | undefined

/** The catalog, built on first use so evaluating the bundle (also in the desktop's main process) stays cheap. */
export function getCatalog(): GenuiCatalog {
  catalog ??= create()
  return catalog
}
