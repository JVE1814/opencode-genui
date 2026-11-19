import { describe, expect, test } from "bun:test"
import type { Spec } from "@json-render/core"
import { readFile } from "node:fs/promises"
import { renderSkill, SKILL_PATH } from "../../scripts/build-skill.ts"
import {
  ACTION_NAMES,
  ACTIVATION_EVENTS,
  actionDefinitions,
  COMPONENT_NAMES,
  componentDefinitions,
  describeActivations,
  OUTWARD_BURST,
} from "../../src/catalog/index.ts"
import { applyPromptFixes, buildPrompt, catalogPrompt, PROMPT_FIXES } from "../../src/catalog/prompt.ts"
import { scanFences } from "../../src/protocol/fence.ts"
import { applyPatches, EMPTY_SPEC } from "../../src/protocol/patch.ts"
import { canvasIdOf, parseBlock } from "../../src/protocol/surface.ts"
import { CANVAS_LANGUAGE, INLINE_LANGUAGE, SKILL_ID } from "../../src/shared/constants.ts"
import { formatRules, HINT, hintFor, SKILL_DESCRIPTION } from "../../src/shared/hint.ts"
import { formatSentMessage, MAX_SENT_MESSAGE } from "../../src/shared/message.ts"
import { DEFAULT_OPTIONS } from "../../src/shared/options.ts"

const tokens = (text: string) => text.length / 4
const prompt = buildPrompt()
const BUILTIN_ACTIONS = ["setState", "pushState", "removeState", "validateForm"]

type Element = {
  type: string
  props?: Record<string, unknown>
  children?: string[]
  on?: Record<string, unknown>
  watch?: Record<string, unknown>
}

const knownAction = (action: string) => (ACTION_NAMES as string[]).includes(action) || BUILTIN_ACTIONS.includes(action)

/** Problems in one element written in our docs: unknown component, props, events or actions, missing required props. */
function elementProblems(key: string, element: Element): string[] {
  const definition = componentDefinitions[element.type as keyof typeof componentDefinitions]
  if (!definition) return [`${key}: unknown component ${element.type}`]
  const problems: string[] = []
  const shape = definition.props.shape as Record<string, { safeParse(value: unknown): { success: boolean } }>
  for (const prop of Object.keys(element.props ?? {}))
    if (!(prop in shape)) problems.push(`${key}: ${element.type} has no prop ${prop}`)
  for (const [prop, schema] of Object.entries(shape))
    if (!schema.safeParse(undefined).success && !(prop in (element.props ?? {})))
      problems.push(`${key}: ${element.type} needs prop ${prop}`)
  if (!Array.isArray(element.children)) problems.push(`${key}: children is not an array`)
  for (const [event, binding] of Object.entries(element.on ?? {})) {
    const events: readonly string[] = "events" in definition ? definition.events : []
    if (!events.includes(event)) problems.push(`${key}: ${element.type} has no event ${event}`)
    for (const item of [binding].flat() as { action: string }[])
      if (!knownAction(item.action)) problems.push(`${key}: unknown action ${item.action}`)
  }
  for (const binding of Object.values(element.watch ?? {}))
    for (const item of [binding].flat() as { action: string }[])
      if (!knownAction(item.action)) problems.push(`${key}: unknown action ${item.action} in watch`)
  return problems
}

/** Problems in a whole spec: those of its elements, plus a root or children that do not resolve. */
function specProblems(spec: Spec): string[] {
  const elements = spec.elements as Record<string, Element>
  const problems = elements[spec.root] ? [] : [`root "${spec.root}" is not an element`]
  for (const [key, element] of Object.entries(elements)) {
    problems.push(...elementProblems(key, element))
    for (const child of element.children ?? []) if (!elements[child]) problems.push(`${key}: missing child ${child}`)
  }
  return problems
}

/**
 * The single elements the text shows as JSON on one line, outside fenced blocks: `{"type":...}` objects and the values
 * of `{"op":"add","path":"/elements/..."}` patches. Placeholders such as "<ComponentName>" are skipped.
 */
function inlineElements(text: string): { line: string; element: Element }[] {
  const found: { line: string; element: Element }[] = []
  for (const line of text.split("\n")) {
    const start = line.search(/\{"(type|op)":/)
    if (start < 0) continue
    let value: unknown
    try {
      value = JSON.parse(line.slice(start).replace(/\.$/, ""))
    } catch {
      continue
    }
    const record = value as { type?: unknown; op?: unknown; path?: unknown; value?: unknown }
    const element = (
      typeof record.op === "string" && typeof record.path === "string" && record.path.startsWith("/elements/")
        ? record.value
        : record
    ) as Element
    if (typeof element?.type === "string" && !element.type.startsWith("<")) found.push({ line, element })
  }
  return found
}

/** Folds every spec and canvas block of a text the way the GUI would, and returns the resulting specs. */
function examples(text: string): { label: string; spec: Spec }[] {
  const result: { label: string; spec: Spec }[] = []
  const canvases = new Map<string, Spec>()
  for (const fence of scanFences(text)) {
    if (fence.language !== INLINE_LANGUAGE && fence.language !== CANVAS_LANGUAGE) continue
    const block = parseBlock(fence.body)
    expect(block.errors).toEqual([])
    expect(block.patches.length).toBeGreaterThan(0)
    if (fence.language === INLINE_LANGUAGE) {
      expect(block.hasRoot).toBe(true)
      result.push({ label: `spec #${fence.ordinal}`, spec: applyPatches(EMPTY_SPEC, block.patches) })
      continue
    }
    const id = canvasIdOf(block.header)
    const base = block.hasRoot ? EMPTY_SPEC : canvases.get(id)
    expect(base).toBeDefined()
    canvases.set(id, applyPatches(base!, block.patches))
  }
  for (const [id, spec] of canvases) result.push({ label: `canvas ${id}`, spec })
  return result
}

describe("buildPrompt", () => {
  test("mentions every component and action", () => {
    for (const name of COMPONENT_NAMES) expect(prompt).toContain(`- ${name}: `)
    for (const name of ACTION_NAMES) expect(prompt).toContain(`- ${name}: `)
    for (const name of BUILTIN_ACTIONS) expect(prompt).toContain(`- ${name}: `)
  })

  test("explains both fences, the canvas header and the canvas operations", () => {
    expect(prompt).toContain("```" + INLINE_LANGUAGE)
    expect(prompt).toContain("```" + CANVAS_LANGUAGE)
    expect(prompt).toContain('{"canvas":"<id>","title":"..."}')
    expect(prompt).toContain('{"canvas":"<id>","close":true}')
    expect(prompt).toContain('{"id":"<stable-id>","title":"..."}')
    expect(prompt).toMatch(/without \/root patches the canvas/)
    expect(prompt).toMatch(/compacted/)
  })

  test("puts the OpenCode section before json-render's reference", () => {
    expect(prompt.startsWith("# Interactive UI in OpenCode\n")).toBe(true)
    const reference = prompt.indexOf("# Spec format and catalog (json-render)")
    expect(reference).toBeGreaterThan(0)
    expect(prompt.indexOf("## Canvas")).toBeLessThan(reference)
    expect(prompt.indexOf("AVAILABLE COMPONENTS")).toBeGreaterThan(reference)
  })

  test("describes the exact message sendPrompt sends", () => {
    const sent = formatSentMessage({ text: "Deploy with these settings", data: { env: "production", replicas: 3 } })
    const indented = sent
      .split("\n")
      .map((line) => (line ? `  ${line}` : line))
      .join("\n")
    expect(prompt).toContain(indented)
    expect(prompt).toContain(MAX_SENT_MESSAGE.toLocaleString("en-US"))
  })

  test("a sent message stays within MAX_SENT_MESSAGE, with or without data", () => {
    expect(formatSentMessage({ text: "x".repeat(50_000) })).toHaveLength(MAX_SENT_MESSAGE)
    const withData = formatSentMessage({ text: "y".repeat(50_000), data: { blob: "z".repeat(50_000) } })
    expect(withData.length).toBeLessThanOrEqual(MAX_SENT_MESSAGE)
    expect(withData).toContain("```json\n")
    expect(withData).toContain("... (truncated)")
  })

  test("states the outward-action rules genui enforces, from the same table", () => {
    expect(prompt).toContain(`activates a control: ${describeActivations()}.`)
    for (const [type, events] of Object.entries(ACTIVATION_EVENTS)) {
      expect(componentDefinitions[type as keyof typeof componentDefinitions]).toBeDefined()
      for (const event of events) {
        expect(describeActivations()).toContain(`on.${event} of`)
        expect(describeActivations()).toContain(type)
        expect(
          (componentDefinitions[type as keyof typeof componentDefinitions] as { events?: string[] }).events,
        ).toContain(event)
      }
    }
    expect(prompt).toContain(`at most ${OUTWARD_BURST} of them`)
    expect(prompt).toContain("never run from watch")
    expect(prompt).not.toContain("(loading data,")
    expect(prompt).not.toContain('{ "$item": "field" } resolves to the absolute state path,')
  })

  test("uses an agent's system line, not json-render's default", () => {
    expect(prompt).not.toContain("You are a UI generator")
    expect(prompt).toContain("You can answer with interactive UI as well as text.")
  })

  test("every json-render fix applies to the generated text", () => {
    const raw = catalogPrompt()
    for (const fix of PROMPT_FIXES) {
      expect(raw).toContain(fix.from)
      expect(fix.to).not.toContain(fix.from)
      expect(prompt).not.toContain(fix.from)
      expect(prompt).toContain(fix.to)
    }
  })

  test("leaves nothing that contradicts OpenCode", () => {
    expect(prompt).not.toContain("loadCities")
    expect(prompt).not.toMatch(/"color"/)
    expect(prompt).not.toMatch(/#[0-9a-f]{6}\b/i)
    expect(prompt).not.toMatch(/"type":"Stack"[^\n]*"on":/)
    // Every place json-render demands the spec fence also allows the canvas one.
    for (const line of prompt.split("\n").filter((line) => /wrap all JSONL patches/.test(line)))
      expect(line).toContain("```" + CANVAS_LANGUAGE)
  })

  test("applyPromptFixes is a no-op on text without the fixed phrases", () => {
    expect(applyPromptFixes("nothing to fix")).toBe("nothing to fix")
  })

  test("appends configured rules to the rules list", () => {
    const withRules = buildPrompt({ rules: ["Prefer canvases for anything the user will revisit."] })
    expect(withRules).toMatch(/\n\d+\. Prefer canvases for anything the user will revisit\.$/)
    expect(prompt).not.toContain("Prefer canvases")
  })

  test("stays within the token budget", () => {
    expect(tokens(prompt)).toBeLessThanOrEqual(9000)
  })

  test("its one-line element examples use only real components, props, events and actions", () => {
    const found = inlineElements(prompt)
    expect(found.length).toBeGreaterThanOrEqual(10)
    for (const { line, element } of found)
      expect({ line, problems: elementProblems(element.type, element) }).toEqual({ line, problems: [] })
  })

  test("its examples use only real components, props, events and actions", () => {
    const found = examples(prompt)
    expect(found.length).toBeGreaterThanOrEqual(2)
    for (const { label, spec } of found)
      expect({ label, problems: specProblems(spec) }).toEqual({ label, problems: [] })
  })
})

describe("HINT", () => {
  test("stays short", () => {
    expect(tokens(HINT)).toBeGreaterThanOrEqual(250)
    expect(tokens(HINT)).toBeLessThanOrEqual(400)
  })

  test("names both surfaces, the canvas header and the skill", () => {
    expect(HINT).toContain("```" + INLINE_LANGUAGE)
    expect(HINT).toContain("```" + CANVAS_LANGUAGE)
    expect(HINT).toContain('{"canvas":"<id>","title":"..."}')
    expect(HINT).toContain(`\`${SKILL_ID}\` skill`)
    expect(HINT).toMatch(/user message/)
  })

  test("its example is a valid spec of 6-10 lines", () => {
    const fences = scanFences(HINT).filter((fence) => fence.language === INLINE_LANGUAGE)
    expect(fences).toHaveLength(1)
    const lines = fences[0]!.body.split("\n").length + 2
    expect(lines).toBeGreaterThanOrEqual(6)
    expect(lines).toBeLessThanOrEqual(10)
    const [example] = examples(HINT)
    expect(specProblems(example!.spec)).toEqual([])
  })
})

describe("hintFor", () => {
  test("is HINT without rules", () => {
    expect(hintFor(DEFAULT_OPTIONS)).toBe(HINT)
    expect(hintFor({ instructions: "always", rules: ["  ", ""] })).toBe(HINT)
  })

  test("appends the rules as a list", () => {
    const hint = hintFor({ instructions: "session", rules: ["Prefer canvases.", " Keep forms short. "] })
    expect(hint.startsWith(`${HINT}\n\n`)).toBe(true)
    expect(hint.endsWith("\n- Prefer canvases.\n- Keep forms short.")).toBe(true)
  })

  test("keeps a multi-line rule inside its list item", () => {
    expect(formatRules(["First line\nsecond line"])).toEndWith("- First line\n  second line")
    expect(formatRules([])).toBe("")
  })
})

describe("skills/genui/SKILL.md", () => {
  test("is up to date (bun scripts/build-skill.ts)", async () => {
    expect(await readFile(SKILL_PATH, "utf8")).toBe(renderSkill())
  })

  test("has frontmatter with the skill's name and description", () => {
    const skill = renderSkill()
    const match = /^---\n([\s\S]*?)\n---\n\n/.exec(skill)
    expect(match).not.toBeNull()
    expect(Bun.YAML.parse(match![1]!)).toEqual({ name: SKILL_ID, description: SKILL_DESCRIPTION })
    expect(skill.slice(match![0].length)).toBe(`${prompt}\n`)
  })

  test("the description says when to load it", () => {
    expect(SKILL_DESCRIPTION).toMatch(/Load it before writing your first UI/)
  })
})

test("action descriptions exist for every action", () => {
  for (const name of ACTION_NAMES) expect(actionDefinitions[name].description.length).toBeGreaterThan(10)
})
