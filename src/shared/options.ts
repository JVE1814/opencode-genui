/**
 * Plugin options, read from the plugin's entry in `opencode.json(c)`:
 *
 * ```jsonc
 * { "plugins": [{ "package": "opencode-genui", "options": { "instructions": "always" } }] }
 * ```
 *
 * The server part and the GUI receive the same options. Parsing never throws: unknown or malformed values fall back to
 * the defaults.
 */
export interface GenuiOptions {
  /**
   * How the agent learns it can render UI. The full catalog is always available as the `genui` skill.
   * - `session` (default): the desktop app attaches a short hint to each session it opens, so only sessions shown in
   *   the desktop app are told to emit UI.
   * - `always`: the server adds the hint to every agent request, including terminal sessions.
   * - `off`: no hint; the agent only uses UI when asked or when it finds the skill.
   */
  readonly instructions: "session" | "always" | "off"
  /** Extra rules appended to the agent's UI instructions. */
  readonly rules: readonly string[]
}

export const DEFAULT_OPTIONS: GenuiOptions = { instructions: "session", rules: [] }

const INSTRUCTIONS = new Set<GenuiOptions["instructions"]>(["session", "always", "off"])

export function parseOptions(input: unknown): GenuiOptions {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const instructions = INSTRUCTIONS.has(raw.instructions as GenuiOptions["instructions"])
    ? (raw.instructions as GenuiOptions["instructions"])
    : DEFAULT_OPTIONS.instructions
  const rules = Array.isArray(raw.rules)
    ? raw.rules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0).slice(0, 50)
    : []
  return { instructions, rules }
}
