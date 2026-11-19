import { CANVAS_LANGUAGE, INLINE_LANGUAGE, SKILL_ID } from "./constants.ts"
import type { GenuiOptions } from "./options.ts"

// This module is shared by the server part (no runtime dependencies) and the desktop GUI, so it imports nothing else.

const FENCE = "```"

/** The `genui` skill's description: what the agent reads when deciding whether to load the skill. */
export const SKILL_DESCRIPTION =
  `Full reference for showing interactive UI in the OpenCode desktop app: how to write json-render specs in ` +
  `${FENCE}${INLINE_LANGUAGE} (inline) and ${FENCE}${CANVAS_LANGUAGE} (sidebar canvas) blocks, the components, ` +
  `actions, state and canvas updates. Load it before writing your first UI in a session.`

const EXAMPLE = [
  `${FENCE}${INLINE_LANGUAGE}`,
  `{"op":"add","path":"/root","value":"card"}`,
  `{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Choose a plan"},"children":["plan","go"]}}`,
  `{"op":"add","path":"/elements/plan","value":{"type":"Radio","props":{"label":"Plan","options":["Basic","Pro"],"value":{"$bindState":"/form/plan"}},"children":[]}}`,
  `{"op":"add","path":"/elements/go","value":{"type":"Button","props":{"label":"Continue","variant":"primary"},"on":{"press":{"action":"sendPrompt","params":{"text":"Continue with this plan","data":{"$state":"/form"}}}},"children":[]}}`,
  `{"op":"add","path":"/state/form","value":{"plan":"Basic"}}`,
  FENCE,
].join("\n")

/**
 * The short hint that tells the agent it can render UI and where the full instructions are (the `genui` skill). The
 * desktop app attaches it to each session it shows (`instructions: "session"`); with `"always"` the server adds it to
 * every agent request.
 */
export const HINT = [
  "You are running in the OpenCode desktop app. Besides text, it renders interactive UI that you write as a json-render spec: JSONL lines of RFC 6902 JSON Patch in a fenced block of your reply. The UI takes the app's own design.",
  "",
  "Use UI when it helps more than prose: collecting input (forms), choosing between options, dashboards and status, comparisons, previews, step-by-step flows. Use plain text for explanations, short answers and code.",
  "",
  `- ${FENCE}${INLINE_LANGUAGE} blocks render inline in your reply once the block closes.`,
  `- ${FENCE}${CANVAS_LANGUAGE} blocks render in a sidebar canvas tab that stays open. First line: {"canvas":"<id>","title":"..."}. Later blocks for the same id patch or replace it, so you can keep it up to date.`,
  "",
  "What the user does in your UI (submitting a form, pressing a button) comes back to you as a user message.",
  "",
  `Before your first UI in a session, load the \`${SKILL_ID}\` skill: it has the components, actions and rules. Minimal example:`,
  "",
  EXAMPLE,
].join("\n")

/** Extra rules from the plugin options, as a list to append to the agent's UI instructions; empty without rules. */
export function formatRules(rules: readonly string[]): string {
  const items = rules.map((rule) => rule.trim()).filter(Boolean)
  if (items.length === 0) return ""
  return [
    "Additional UI rules from the user's configuration:",
    ...items.map((rule) => `- ${rule.replace(/\r?\n/g, "\n  ")}`),
  ].join("\n")
}

/** The hint for the given options: HINT, then the configured extra rules. */
export function hintFor(options: GenuiOptions): string {
  const rules = formatRules(options.rules)
  return rules ? `${HINT}\n\n${rules}` : HINT
}
