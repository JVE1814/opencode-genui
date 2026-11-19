// Writes skills/genui/SKILL.md, the `genui` skill the server part registers: frontmatter, then the agent's full UI
// instructions (src/catalog/prompt.ts). The file is committed, since OpenCode installs plugins with scripts disabled.
//
//   bun scripts/build-skill.ts           write the file
//   bun scripts/build-skill.ts --check   exit 1 when the committed file is stale (CI)

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { buildPrompt } from "../src/catalog/prompt.ts"
import { SKILL_ID } from "../src/shared/constants.ts"
import { SKILL_DESCRIPTION } from "../src/shared/hint.ts"

export const SKILL_PATH = fileURLToPath(new URL("../skills/genui/SKILL.md", import.meta.url))

/** The skill file's full contents. The description is JSON-quoted, which is valid YAML for any text. */
export function renderSkill(): string {
  return `---\nname: ${SKILL_ID}\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${buildPrompt()}\n`
}

async function readCurrent(): Promise<string | undefined> {
  try {
    return await readFile(SKILL_PATH, "utf8")
  } catch {
    return undefined
  }
}

async function main(args: readonly string[]) {
  const expected = renderSkill()
  const current = await readCurrent()
  const shown = relative(process.cwd(), SKILL_PATH) || SKILL_PATH

  if (args.includes("--check")) {
    if (current === expected) {
      console.log(`${shown} is up to date (~${Math.round(expected.length / 4)} tokens)`)
      return
    }
    console.error(
      current === undefined
        ? `${shown} is missing. Run \`bun scripts/build-skill.ts\` and commit the result.`
        : `${shown} is stale: it does not match the catalog and prompt sources. Run \`bun scripts/build-skill.ts\` and commit the result.`,
    )
    process.exit(1)
  }

  if (current === expected) {
    console.log(`${shown} unchanged (~${Math.round(expected.length / 4)} tokens)`)
    return
  }
  await mkdir(dirname(SKILL_PATH), { recursive: true })
  await writeFile(SKILL_PATH, expected)
  console.log(`wrote ${shown} (~${Math.round(expected.length / 4)} tokens)`)
}

if (import.meta.main) await main(process.argv.slice(2))
