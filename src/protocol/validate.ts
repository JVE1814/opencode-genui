import { validateSpec, type Spec, type SpecIssue } from "@json-render/core"
import { getCatalog, type GenuiCatalog } from "../catalog/index.ts"
import { CANVAS_LANGUAGE, INLINE_LANGUAGE } from "../shared/constants.ts"
import { BOUND_PROPS, BUILTIN_ACTIONS, isExpression, isRecord, UI_STATE_ROOT, uiStatePath } from "./normalize.ts"
import type { LineError, SurfaceKind } from "./surface.ts"

export interface SurfaceIssue {
  readonly severity: "error" | "warning"
  /** json-render's SpecIssue code, or one of ours: unknown_component, missing_type, invalid_props, unknown_action, ... */
  readonly code: string
  /** Relative to the element when `elementKey` is set, e.g. `unknown component "Dropdown"`. */
  readonly message: string
  readonly elementKey?: string
}

// json-render's structural codes, by our severity. Root and children checks are our own (see checkStructure).
const SPEC_SEVERITY: Partial<Record<SpecIssue["code"], SurfaceIssue["severity"]>> = {
  invalid_visible: "error",
  repeat_without_children: "error",
  repeat_item_outside_scope: "error",
  // Often deliberate: state the agent fills later (pushState, sendPrompt replies). It renders nothing meanwhile.
  repeat_state_mismatch: "warning",
  // The normalizer fixes these; they only show on specs validated without it.
  visible_in_props: "warning",
  on_in_props: "warning",
  repeat_in_props: "warning",
  watch_in_props: "warning",
  orphaned_element: "warning",
}

const MAX_PROP_PROBLEMS = 3

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

function preview(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value), 40)
  } catch {
    return typeName(value)
  }
}

const typeName = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

const EXPECTED_NAMES: Record<string, string> = { int: "integer", record: "object" }
const expectedName = (expected: unknown) =>
  typeof expected !== "string"
    ? "a valid value"
    : Object.hasOwn(EXPECTED_NAMES, expected)
      ? EXPECTED_NAMES[expected]!
      : expected
const withArticle = (name: string) =>
  /^(a |an )/.test(name) ? name : /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`

/** `tabs[0].label` for the path ["tabs", 0, "label"]. */
function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : index === 0 ? String(segment) : `.${String(segment)}`,
    )
    .join("")
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined
    const key = typeof segment === "symbol" ? segment : String(segment)
    if (!Object.hasOwn(current, key)) return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}

/** Whether a path runs through (or ends at) an expression, whose value only exists at render time. */
function touchesExpression(root: unknown, path: readonly PropertyKey[]): boolean {
  let current = root
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return false
    const key = typeof segment === "symbol" ? segment : String(segment)
    if (!Object.hasOwn(current, key)) return false
    current = (current as Record<PropertyKey, unknown>)[key]
    if (isExpression(current)) return true
  }
  return false
}

interface ZodIssueLike {
  readonly code?: string
  readonly path: readonly PropertyKey[]
  readonly message: string
  readonly expected?: unknown
  readonly values?: readonly unknown[]
  readonly minimum?: unknown
  readonly maximum?: unknown
  readonly origin?: unknown
  readonly errors?: readonly (readonly ZodIssueLike[])[]
}

function describePropIssue(issue: ZodIssueLike, props: Record<string, unknown>): string {
  const name = issue.path.length > 0 ? `"${formatPath(issue.path)}"` : "props"
  const received = valueAt(props, issue.path)
  const got = received === undefined ? "" : `, got ${typeName(received)}`
  switch (issue.code) {
    case "invalid_type":
      return received === undefined
        ? `${name} is required (${expectedName(issue.expected)})`
        : `${name} should be ${withArticle(expectedName(issue.expected))}${got}`
    case "invalid_union": {
      const expected = [
        ...new Set(
          (issue.errors ?? [])
            .flat()
            .filter((inner) => inner.path.length === 0 && inner.code === "invalid_type")
            .map((inner) => expectedName(inner.expected)),
        ),
      ]
      if (expected.length === 0) return `${name} is invalid${got}`
      return received === undefined
        ? `${name} is required (${expected.join(" or ")})`
        : `${name} should be ${expected.map(withArticle).join(" or ")}${got}`
    }
    case "invalid_value":
      return `${name} should be one of ${(issue.values ?? []).map((value) => preview(value)).join(", ")}${
        received === undefined ? "" : `, got ${preview(received)}`
      }`
    case "too_small":
    case "too_big": {
      const bound = issue.code === "too_small" ? issue.minimum : issue.maximum
      const relation = issue.code === "too_small" ? "at least" : "at most"
      const unit = issue.origin === "array" ? " items" : issue.origin === "string" ? " characters" : ""
      return `${name} should be ${relation} ${String(bound)}${unit}`
    }
    default:
      return `${name}: ${issue.message}`
  }
}

// Bound inputs read `{ "$bindState": "/__genui/<key>" }` after normalization; validate the seeded literal instead, so a
// wrong literal is still reported.
function propsForValidation(key: string, type: string, props: Record<string, unknown>, state: unknown) {
  const prop = Object.hasOwn(BOUND_PROPS, type) ? BOUND_PROPS[type]! : undefined
  if (!prop) return props
  const value = props[prop]
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.$bindState !== uiStatePath(key)) return props
  const ui = isRecord(state) ? state[UI_STATE_ROOT] : undefined
  const { [prop]: _bound, ...rest } = props
  return isRecord(ui) && Object.hasOwn(ui, key) ? { ...rest, [prop]: ui[key] } : rest
}

function checkProps(
  key: string,
  type: string,
  props: Record<string, unknown>,
  state: unknown,
  schema: unknown,
): SurfaceIssue | undefined {
  if (typeof schema !== "object" || schema === null) return undefined
  const safeParse = (schema as { safeParse?: unknown }).safeParse
  if (typeof safeParse !== "function") return undefined
  const input = propsForValidation(key, type, props, state)
  let result: { success: boolean; error?: { issues: readonly ZodIssueLike[] } }
  try {
    result = safeParse.call(schema, input)
  } catch {
    return undefined
  }
  if (result.success || !result.error) return undefined
  const problems = result.error.issues
    .filter((issue) => !touchesExpression(input, issue.path))
    .map((issue) => describePropIssue(issue, input))
  const unique = [...new Set(problems)]
  if (unique.length === 0) return undefined
  const shown = unique.slice(0, MAX_PROP_PROBLEMS).join("; ")
  const more = unique.length > MAX_PROP_PROBLEMS ? ` (and ${unique.length - MAX_PROP_PROBLEMS} more)` : ""
  return {
    severity: "warning",
    code: "invalid_props",
    message: `invalid props for ${type}: ${shown}${more}`,
    elementKey: key,
  }
}

function checkBindings(key: string, element: Record<string, unknown>, known: ReadonlySet<string>): SurfaceIssue[] {
  const issues: SurfaceIssue[] = []
  const check = (binding: unknown, where: string) => {
    if (!isRecord(binding) || typeof binding.action !== "string") {
      issues.push({
        severity: "warning",
        code: "invalid_binding",
        message: `${where} is not an action binding ({ "action": "...", "params": {...} })`,
        elementKey: key,
      })
      return
    }
    if (!known.has(binding.action))
      issues.push({
        severity: "warning",
        code: "unknown_action",
        message: `unknown action "${truncate(binding.action, 60)}" in ${where}`,
        elementKey: key,
      })
    for (const handler of ["onSuccess", "onError"] as const) {
      const next = binding[handler]
      if (isRecord(next) && typeof next.action === "string" && !known.has(next.action))
        issues.push({
          severity: "warning",
          code: "unknown_action",
          message: `unknown action "${truncate(next.action, 60)}" in ${where}.${handler}`,
          elementKey: key,
        })
    }
  }
  for (const field of ["on", "watch"] as const) {
    const map = element[field]
    if (!isRecord(map)) continue
    for (const [name, value] of Object.entries(map)) {
      const where = field === "on" ? `on.${name}` : `watch["${name}"]`
      if (Array.isArray(value)) value.forEach((binding, index) => check(binding, `${where}[${index}]`))
      else check(value, where)
    }
  }
  return issues
}

// Root and children, with own-property lookups (a child named "toString" must not count as defined).
function checkStructure(root: unknown, elements: Record<string, unknown>): SurfaceIssue[] {
  const issues: SurfaceIssue[] = []
  if (Object.keys(elements).length === 0)
    issues.push({ severity: "error", code: "empty_spec", message: "the spec has no elements" })
  else if (typeof root !== "string" || !root)
    issues.push({
      severity: "error",
      code: "missing_root",
      message: 'no root is set (add "/root" with an element key)',
    })
  else if (!Object.hasOwn(elements, root) || !isRecord(elements[root]))
    issues.push({
      severity: "error",
      code: "root_not_found",
      message: `the root element "${truncate(root, 60)}" is not defined`,
    })

  for (const [key, element] of Object.entries(elements)) {
    if (!isRecord(element)) continue
    const refs: [string, string | undefined][] = []
    if (Array.isArray(element.children))
      for (const child of element.children) if (typeof child === "string") refs.push([child, undefined])
    if (isRecord(element.slots))
      for (const [slot, keys] of Object.entries(element.slots))
        if (Array.isArray(keys)) for (const child of keys) if (typeof child === "string") refs.push([child, slot])
    for (const [child, slot] of refs) {
      if (Object.hasOwn(elements, child) && isRecord(elements[child])) continue
      issues.push({
        severity: "error",
        code: "missing_child",
        message: `child "${truncate(child, 60)}"${slot === undefined ? "" : ` in slot "${slot}"`} is not defined`,
        elementKey: key,
      })
    }
  }
  return issues
}

const validRepeat = (repeat: unknown) =>
  isRecord(repeat) &&
  (typeof repeat.statePath === "string" || (isRecord(repeat.statePath) && typeof repeat.statePath.$item === "string"))

// validateSpec iterates children and slots and reads repeat paths without checking their shapes.
function forJsonRender(element: Record<string, unknown>): Record<string, unknown> {
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  const { children, slots, repeat, ...rest } = element
  return {
    ...rest,
    children: strings(children),
    ...(isRecord(slots)
      ? { slots: Object.fromEntries(Object.entries(slots).map(([name, keys]) => [name, strings(keys)])) }
      : {}),
    ...(validRepeat(repeat) ? { repeat } : {}),
  }
}

// json-render's own checks (visible conditions, repeat scopes, fields misplaced in props), minus the ones we do above.
function checkWithJsonRender(spec: Spec, elements: Record<string, unknown>): SurfaceIssue[] {
  const userState = isRecord(spec.state) ? spec.state : undefined
  // The normalizer may create `state` only to seed inputs; that must not make json-render start checking repeat paths
  // against a state the agent never wrote.
  const state = userState && Object.keys(userState).every((key) => key === UI_STATE_ROOT) ? undefined : userState
  const safeElements = Object.fromEntries(
    Object.entries(elements).flatMap(([key, element]) => (isRecord(element) ? [[key, forJsonRender(element)]] : [])),
  )
  let result: ReturnType<typeof validateSpec>
  try {
    result = validateSpec({
      root: typeof spec.root === "string" ? spec.root : "",
      elements: safeElements as unknown as Spec["elements"],
      ...(state ? { state } : {}),
    })
  } catch (error) {
    return [
      {
        severity: "error",
        code: "invalid_spec",
        message: `the spec could not be checked: ${(error as Error).message}`,
      },
    ]
  }
  return result.issues.flatMap((issue): SurfaceIssue[] => {
    const severity = SPEC_SEVERITY[issue.code]
    if (!severity) return []
    const prefix = issue.elementKey === undefined ? "" : `Element "${issue.elementKey}" `
    const message = prefix && issue.message.startsWith(prefix) ? issue.message.slice(prefix.length) : issue.message
    return [
      {
        severity,
        code: issue.code,
        message,
        ...(issue.elementKey === undefined ? {} : { elementKey: issue.elementKey }),
      },
    ]
  })
}

/**
 * Checks a spec against json-render's structural rules and the catalog: unknown component types, props that do not
 * match the component's schema (values that are expressions are only known at render time and are skipped), and
 * unknown actions. `fatal` means nothing can render: no root, no root element, or a root of an unknown type.
 */
export function validateSurface(
  spec: Spec,
  catalog: GenuiCatalog = getCatalog(),
): { issues: SurfaceIssue[]; fatal: boolean } {
  if (!isRecord(spec))
    return { issues: [{ severity: "error", code: "invalid_spec", message: "the spec is not an object" }], fatal: true }

  const elements: Record<string, unknown> = isRecord(spec.elements) ? spec.elements : {}
  const components = catalog.data.components as Record<string, { props?: unknown }>
  const componentNames = new Set(catalog.componentNames)
  const known = new Set([...BUILTIN_ACTIONS, ...catalog.actionNames])

  const issues: SurfaceIssue[] = [...checkStructure(spec.root, elements), ...checkWithJsonRender(spec, elements)]

  for (const [key, element] of Object.entries(elements)) {
    if (!isRecord(element)) {
      issues.push({ severity: "error", code: "invalid_element", message: "is not an element object", elementKey: key })
      continue
    }
    const type = element.type
    if (typeof type !== "string" || !type) {
      issues.push({ severity: "error", code: "missing_type", message: "has no component type", elementKey: key })
      continue
    }
    if (!componentNames.has(type) || !Object.hasOwn(components, type)) {
      issues.push({
        severity: "error",
        code: "unknown_component",
        message: `unknown component "${truncate(type, 60)}"`,
        elementKey: key,
      })
    } else {
      const props = isRecord(element.props) ? element.props : {}
      const issue = checkProps(key, type, props, spec.state, components[type]?.props)
      if (issue) issues.push(issue)
    }
    if (element.repeat !== undefined && !validRepeat(element.repeat))
      issues.push({
        severity: "error",
        code: "invalid_repeat",
        message: 'has an invalid "repeat" (expected { "statePath": "/path/to/array" })',
        elementKey: key,
      })
    issues.push(...checkBindings(key, element, known))
  }

  const root = spec.root
  const rootElement = typeof root === "string" && root && Object.hasOwn(elements, root) ? elements[root] : undefined
  const fatal = !isRecord(rootElement) || typeof rootElement.type !== "string" || !componentNames.has(rootElement.type)

  const seen = new Set<string>()
  const unique = issues.filter((issue) => {
    const id = `${issue.severity}\u0000${issue.code}\u0000${issue.elementKey ?? ""}\u0000${issue.message}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return { issues: unique, fatal }
}

/** Longest "Ask agent to fix" message, in characters. */
export const MAX_AGENT_MESSAGE = 2000

// Issue text is model-influenced; keep each bullet on one line and free of backticks that would break the formatting.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const code = (text: string) => `\`${oneLine(text).replace(/`/g, "'")}\``

/**
 * The message "Ask agent to fix" sends as the user: what is wrong (errors first, deduplicated, at most
 * MAX_AGENT_MESSAGE characters), then a request to resend the block.
 */
export function formatIssuesForAgent(input: {
  issues: readonly SurfaceIssue[]
  lineErrors?: readonly LineError[]
  kind: SurfaceKind
  id: string
  title?: string
}): string {
  const title = input.title ? oneLine(input.title).replace(/"/g, "'") : ""
  const id = code(truncate(input.id, 80))
  const where = input.kind === "canvas" ? `canvas ${id}` : `inline spec ${id}`
  const header = `The UI ${title ? `"${truncate(title, 120)}" ` : ""}(${where}) has problems:`
  const language = input.kind === "canvas" ? CANVAS_LANGUAGE : INLINE_LANGUAGE
  const footer = `Please resend the corrected \`\`\`${language} block.`

  const describe = (issue: SurfaceIssue) =>
    `- ${issue.elementKey === undefined ? "" : `element ${code(truncate(issue.elementKey, 80))}: `}${oneLine(issue.message)}`
  const describeLine = (error: LineError) =>
    `- line ${error.line}: ${oneLine(error.message)} in ${code(truncate(oneLine(error.text), 60))}`

  const ordered = [
    ...input.issues.filter((issue) => issue.severity === "error").map(describe),
    ...(input.lineErrors ?? []).map(describeLine),
    ...input.issues.filter((issue) => issue.severity !== "error").map(describe),
  ]
  const lines = [...new Set(ordered.map((line) => truncate(line, 400)))]
  if (lines.length === 0) lines.push("- the UI could not be rendered")

  // Room for the header, footer, separators and a "more" line.
  let budget = MAX_AGENT_MESSAGE - header.length - footer.length - 4 - 40
  const kept: string[] = []
  for (const line of lines) {
    if (line.length + 1 > budget) break
    kept.push(line)
    budget -= line.length + 1
  }
  if (kept.length < lines.length) kept.push(`- ... and ${lines.length - kept.length} more`)
  return `${header}\n${kept.join("\n")}\n\n${footer}`
}
