import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import plugin, { readSkill, SKILL_FILE, stripFrontmatter } from "../../src/index.ts"
import { PLUGIN_ID, SKILL_ID } from "../../src/shared/constants.ts"
import { HINT, hintFor, SKILL_DESCRIPTION } from "../../src/shared/hint.ts"

type Setup = Parameters<typeof plugin.setup>[0]
type SkillLike = { id: string; name: string; description?: string; autoinvoke?: boolean; path: string; content: string }
type ContextEvent = { system: { type: "text"; text: string }[] }

/** A fake plugin context that records what setup registers. `existing` skills are already in the editor. */
function fakeContext(options: unknown, existing: SkillLike[] = []) {
  const skills = [...existing]
  const added: SkillLike[] = []
  const transforms: ((editor: unknown) => void)[] = []
  const hooks: { name: string; callback: (event: ContextEvent) => unknown }[] = []
  const registration = { dispose: async () => {} }
  const editor = {
    list: () => skills,
    get: (id: string) => skills.find((skill) => skill.id === id),
    add: (skill: SkillLike) => {
      skills.push(skill)
      added.push(skill)
    },
    update: () => {
      throw new Error("not expected")
    },
    remove: () => {
      throw new Error("not expected")
    },
  }
  const ctx = {
    options,
    skill: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback)
        callback(editor)
        return registration
      },
    },
    session: {
      hook: async (name: string, callback: (event: ContextEvent) => unknown) => {
        hooks.push({ name, callback })
        return registration
      },
    },
  }
  return { ctx: ctx as unknown as Setup, added, transforms, hooks }
}

const skillFile = await readFile(SKILL_FILE, "utf8")

describe("server plugin", () => {
  test("is defined with the plugin id", () => {
    expect(plugin.id).toBe(PLUGIN_ID)
    expect(typeof plugin.setup).toBe("function")
  })

  test.each([["session"], ["always"], ["off"], [undefined]])(
    "registers the genui skill (instructions: %p)",
    async (instructions) => {
      const fake = fakeContext(instructions === undefined ? undefined : { instructions })
      await plugin.setup(fake.ctx)
      expect(fake.transforms).toHaveLength(1)
      expect(fake.added).toHaveLength(1)
      const skill = fake.added[0]!
      expect(skill.id).toBe(SKILL_ID)
      expect(skill.name).toBe(SKILL_ID)
      expect(skill.description).toBe(SKILL_DESCRIPTION)
      expect(skill.autoinvoke).toBe(true)
      expect(isAbsolute(skill.path)).toBe(true)
      expect(skill.path).toBe(fileURLToPath(SKILL_FILE))
      expect(skill.path.endsWith(join("skills", "genui", "SKILL.md"))).toBe(true)
      expect(skill.content).toBe(`${stripFrontmatter(skillFile).trim()}\n`)
      expect(skill.content.startsWith("# Interactive UI in OpenCode\n")).toBe(true)
      expect(skill.content).not.toContain("description:")
    },
  )

  test("adds the hint to every agent request only with instructions: always", async () => {
    for (const instructions of ["session", "off", "bogus"]) {
      const fake = fakeContext({ instructions })
      await plugin.setup(fake.ctx)
      expect(fake.hooks).toEqual([])
    }

    const fake = fakeContext({ instructions: "always" })
    await plugin.setup(fake.ctx)
    expect(fake.hooks.map((hook) => hook.name)).toEqual(["context"])
    const event: ContextEvent = { system: [{ type: "text", text: "OpenCode's own instructions" }] }
    await fake.hooks[0]!.callback(event)
    expect(event.system).toEqual([
      { type: "text", text: "OpenCode's own instructions" },
      { type: "text", text: HINT },
    ])
    // A request that already carries the hint does not get it twice.
    await fake.hooks[0]!.callback(event)
    expect(event.system).toHaveLength(2)
    // Each model call builds a fresh system array, which gets the hint again.
    const next: ContextEvent = { system: [] }
    await fake.hooks[0]!.callback(next)
    expect(next.system).toEqual([{ type: "text", text: HINT }])
  })

  test("appends configured rules to the skill and the hint", async () => {
    const options = { instructions: "always" as const, rules: ["Prefer canvases.", 7, "Keep forms short."] }
    const fake = fakeContext(options)
    await plugin.setup(fake.ctx)
    const rules = "Additional UI rules from the user's configuration:\n- Prefer canvases.\n- Keep forms short."
    expect(fake.added[0]!.content.endsWith(`\n\n${rules}\n`)).toBe(true)
    const event: ContextEvent = { system: [] }
    await fake.hooks[0]!.callback(event)
    expect(event.system[0]!.text).toBe(
      hintFor({ instructions: "always", rules: ["Prefer canvases.", "Keep forms short."] }),
    )
    expect(event.system[0]!.text.endsWith(rules)).toBe(true)
  })

  test("keeps a genui skill that is already registered", async () => {
    const existing: SkillLike = { id: SKILL_ID, name: SKILL_ID, path: "/custom/SKILL.md", content: "custom" }
    const fake = fakeContext({}, [existing])
    await plugin.setup(fake.ctx)
    expect(fake.transforms).toHaveLength(1)
    expect(fake.added).toEqual([])
  })
})

describe("server part dependencies", () => {
  // The package ships only src/index.ts, src/shared and skills/, and the server loads them without bundling.
  test("imports only @opencode/plugin, node: built-ins and src/shared", async () => {
    const root = new URL("../../src/", import.meta.url)
    const seen = new Set<string>()
    const visit = async (file: URL) => {
      if (seen.has(file.href)) return
      seen.add(file.href)
      const source = await readFile(file, "utf8")
      for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\b[^"']*?from\s+["']([^"']+)["']/gm)) {
        if (specifier!.startsWith(".")) {
          const target = new URL(specifier!, file)
          expect(target.href.startsWith(new URL("shared/", root).href)).toBe(true)
          await visit(target)
        } else expect(specifier === "@opencode/plugin" || specifier!.startsWith("node:")).toBe(true)
      }
    }
    await visit(new URL("index.ts", root))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe("readSkill", () => {
  test("returns the body of the skill file with rules appended", async () => {
    const content = await readSkill(SKILL_FILE, ["One more rule."])
    expect(content).toBe(
      `${stripFrontmatter(skillFile).trim()}\n\nAdditional UI rules from the user's configuration:\n- One more rule.\n`,
    )
  })

  test("logs and returns undefined when the file is missing or empty", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const dir = await mkdtemp(join(tmpdir(), "genui-skill-"))
    try {
      expect(await readSkill(pathToFileURL(join(dir, "missing", "SKILL.md")), [])).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain("skill not registered")

      const empty = join(dir, "SKILL.md")
      await writeFile(empty, "---\nname: genui\n---\n\n")
      expect(await readSkill(pathToFileURL(empty), [])).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("stripFrontmatter", () => {
  test.each([
    ["---\nname: genui\ndescription: x\n---\n\n# Body\n", "# Body\n"],
    ["---\r\nname: genui\r\n---\r\n# Body", "# Body"],
    ["﻿---\nname: genui\n---\nBody", "Body"],
    ["---\n---\nBody", "Body"],
    ["---\nname: genui\n---", ""],
    ["# No frontmatter\n---\nnot: frontmatter\n---\n", "# No frontmatter\n---\nnot: frontmatter\n---\n"],
    ["Body only", "Body only"],
  ])("%j", (input, expected) => {
    expect(stripFrontmatter(input)).toBe(expected)
  })

  test("keeps a horizontal rule inside the body", () => {
    expect(stripFrontmatter("---\nname: genui\n---\nOne\n\n---\n\nTwo")).toBe("One\n\n---\n\nTwo")
  })
})
