/** Helpers that write json-render JSONL patch lines from objects, so scenario specs are always well-formed JSON. */

export type Line = string

export const add = (path: string, value: unknown): Line => JSON.stringify({ op: "add", path, value })

export const replace = (path: string, value: unknown): Line => JSON.stringify({ op: "replace", path, value })

export const remove = (path: string): Line => JSON.stringify({ op: "remove", path })

export const root = (key: string): Line => add("/root", key)

/** An element: `{"op":"add","path":"/elements/<key>","value":{"type","props","children",...extra}}`. */
export const element = (
  key: string,
  type: string,
  props: Record<string, unknown>,
  children: readonly string[] = [],
  extra: Record<string, unknown> = {},
): Line => add(`/elements/${key}`, { type, props, children, ...extra })

export const state = (path: string, value: unknown): Line =>
  add(`/state${path.startsWith("/") ? path : `/${path}`}`, value)

/** A fenced block: the optional header line, then the patch lines. */
export function block(language: string, header: Record<string, unknown> | undefined, lines: readonly Line[]): string {
  const body = [...(header ? [JSON.stringify(header)] : []), ...lines].join("\n")
  return `\`\`\`${language}\n${body}\n\`\`\``
}
