import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { COMPONENT_NAMES } from "../../src/catalog/components.ts"

// Bun cannot load Solid's JSX without a DOM, so this reads the sources: which component maps src/gui/registry.tsx
// spreads into the registry, and which keys each map in src/gui/components/*.tsx exports. (TypeScript checks the same
// from the other side: the registry `satisfies Components<GenuiCatalog>`.)
const GUI = path.join(import.meta.dir, "../../src/gui")
const read = (file: string) => readFileSync(path.join(GUI, file), "utf8")

function registryMaps(): Map<string, string> {
  const source = read("registry.tsx")
  const imports = new Map<string, string>()
  for (const match of source.matchAll(/import \{ (\w+Components) \} from "\.\/(components\/\w+\.tsx)"/g))
    imports.set(match[1]!, match[2]!)
  const body = source.slice(source.indexOf("export function genuiComponents"))
  const spread = [...body.matchAll(/\.\.\.(\w+Components)/g)].map((match) => match[1]!)
  return new Map(spread.map((name) => [name, imports.get(name) ?? ""]))
}

function mapKeys(file: string, name: string): string[] {
  const source = read(file)
  const start = source.indexOf(`export const ${name} = {`)
  if (start < 0) return []
  const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("}", start))
  return body
    .split(",")
    .map((entry) => entry.trim().split(":")[0]!.trim())
    .filter(Boolean)
}

describe("registry", () => {
  test("spreads every component map it imports", () => {
    const maps = registryMaps()
    expect(maps.size).toBe(7)
    for (const [name, file] of maps) expect(file, name).not.toBe("")
  })

  test("covers exactly the catalog's components, once each", () => {
    const keys = [...registryMaps()].flatMap(([name, file]) => mapKeys(file, name))
    expect(keys.length).toBe(new Set(keys).size)
    expect(keys.toSorted()).toEqual([...COMPONENT_NAMES].toSorted())
  })
})
