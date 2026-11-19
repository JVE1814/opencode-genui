import { Plugin, Skill } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { PLUGIN_ID, SKILL_ID } from "./shared/constants.ts"
import { formatRules, hintFor, SKILL_DESCRIPTION } from "./shared/hint.ts"
import { parseOptions } from "./shared/options.ts"

// The server part. OpenCode loads this file as TypeScript source and the package ships only it, src/shared and skills/,
// so it may import nothing but @opencode/plugin, node: built-ins and src/shared.

/** The generated skill (scripts/build-skill.ts), shipped in the package next to src/. */
export const SKILL_FILE = new URL("../skills/genui/SKILL.md", import.meta.url)

/** Removes a leading YAML frontmatter block (`---` lines around it) and the blank lines after it. */
export function stripFrontmatter(markdown: string): string {
  const text = markdown.replace(/^﻿/, "")
  const match = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text)
  return (match ? text.slice(match[0].length) : text).replace(/^(?:[ \t]*\r?\n)+/, "")
}

/**
 * Reads the skill file and returns its body with the configured extra rules appended. A missing or empty file is
 * logged and returns undefined, so the plugin still loads without the skill.
 */
export async function readSkill(file: URL, rules: readonly string[]): Promise<string | undefined> {
  let markdown: string
  try {
    markdown = await readFile(file, "utf8")
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] skill not registered: cannot read ${fileURLToPath(file)}: ${(error as Error).message}`)
    return undefined
  }
  const body = stripFrontmatter(markdown).trim()
  if (!body) {
    console.warn(`[${PLUGIN_ID}] skill not registered: ${fileURLToPath(file)} is empty`)
    return undefined
  }
  const extra = formatRules(rules)
  return extra ? `${body}\n\n${extra}\n` : `${body}\n`
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options)

    const content = await readSkill(SKILL_FILE, options.rules)
    if (content !== undefined) {
      const skill = Skill.Info.make({
        id: Skill.ID.make(SKILL_ID),
        name: Skill.Name.make(SKILL_ID),
        description: SKILL_DESCRIPTION,
        autoinvoke: true,
        path: Skill.Info.fields.path.make(fileURLToPath(SKILL_FILE)),
        content,
      })
      // A skill of the same id from the user's own config wins.
      await ctx.skill.transform((editor) => {
        if (!editor.get(skill.id)) editor.add(skill)
      })
    }

    // With "session" the desktop app attaches the hint to the sessions it shows; "always" reaches every agent request.
    if (options.instructions === "always") {
      const hint = hintFor(options)
      await ctx.session.hook("context", (event) => {
        if (event.system.some((part) => part.text.includes(hint))) return
        event.system.push({ type: "text", text: hint })
      })
    }
  },
})
