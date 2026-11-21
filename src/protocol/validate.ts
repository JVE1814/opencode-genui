import { validateSpec, type Spec, type SpecIssue } from "@json-render/core"
import { standardDirectives } from "@json-render/directives"
import {
  CONFIRM_PARAM,
  describeActivations,
  getCatalog,
  IGNORED_CHAIN,
  isActivation,
  ON_ERROR_PARAM,
  ON_SUCCESS_PARAM,
  OUTWARD_ACTIONS,
  OUTWARD_BURST,
  RESERVED_PARAMS,
  type ActionName,
  type GenuiCatalog,
} from "../catalog/index.ts"
import { CANVAS_LANGUAGE, INLINE_LANGUAGE, UI_SECRET_ROOT } from "../shared/constants.ts"
import {
  BOUND_PROPS,
  BUILTIN_ACTIONS,
  INVALID_REPEAT,
  isExpression,
  isRecord,
  normalizeNotes,
  notABinding,
  secretStatePath,
  UI_STATE_ROOT,
  uiStatePath,
} from "./normalize.ts"
import { IGNORED_CHECK, patternProblem, SAFE_CHECKS } from "./pattern.ts"
import { pointerTooLarge } from "./patch.ts"
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

// Bound inputs read `{ "$bindState": "/__genui/<key>" }` (or `/__genui_secret/<key>`) after normalization; validate the
// seeded literal instead, so a wrong literal is still reported.
function propsForValidation(key: string, type: string, props: Record<string, unknown>, state: unknown) {
  const prop = Object.hasOwn(BOUND_PROPS, type) ? BOUND_PROPS[type]! : undefined
  if (!prop) return props
  const value = props[prop]
  if (!isRecord(value) || Object.keys(value).length !== 1) return props
  const root =
    value.$bindState === uiStatePath(key)
      ? UI_STATE_ROOT
      : value.$bindState === secretStatePath(key)
        ? UI_SECRET_ROOT
        : undefined
  if (!root) return props
  const seeds = isRecord(state) ? state[root] : undefined
  const { [prop]: _bound, ...rest } = props
  return isRecord(seeds) && Object.hasOwn(seeds, key) ? { ...rest, [prop]: seeds[key] } : rest
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

/** A param's expected type for a message: "string", "a value", ... */
const paramList = (shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }>) =>
  Object.entries(shape)
    .map(([name, schema]) => (schema.safeParse(undefined).success ? `${name}?` : name))
    .join(", ")

/**
 * A custom action's params against its schema in the catalog (src/catalog/actions.ts), as the handler will read them: the
 * reserved params the normalizer adds are left out, and values that are expressions are only known when the action runs,
 * so problems under one are skipped. Unknown params are reported too: the handler ignores them (`{ "href": ... }` for
 * openLink's `url`), which is how a misnamed param fails silently.
 */
function checkActionParams(
  action: string,
  params: Record<string, unknown>,
  where: string,
  definition: { readonly params?: unknown } | undefined,
): string | undefined {
  const schema = definition?.params as
    | { shape?: unknown; safeParse?: (value: unknown) => { success: boolean; error?: { issues: unknown } } }
    | undefined
  if (!isRecord(schema?.shape) || typeof schema.safeParse !== "function") return undefined
  const shape = schema.shape as Record<string, { safeParse: (value: unknown) => { success: boolean } }>
  const own = Object.fromEntries(Object.entries(params).filter(([name]) => !RESERVED_PARAMS.includes(name)))
  let result: { success: boolean; error?: { issues: unknown } }
  try {
    result = schema.safeParse(own)
  } catch {
    return undefined
  }
  const problems =
    result.success || !Array.isArray(result.error?.issues)
      ? []
      : (result.error.issues as ZodIssueLike[])
          .filter((issue) => !touchesExpression(own, issue.path))
          .map((issue) => describePropIssue(issue, own))
  for (const name of Object.keys(own))
    if (!Object.hasOwn(shape, name)) problems.push(`unknown param "${truncate(name, 40)}"`)
  const unique = [...new Set(problems)]
  if (unique.length === 0) return undefined
  return `${action} in ${where} has invalid params: ${unique.slice(0, MAX_PROP_PROBLEMS).join("; ")}${
    unique.length > MAX_PROP_PROBLEMS ? ` (and ${unique.length - MAX_PROP_PROBLEMS} more)` : ""
  }. It takes { ${paramList(shape)} }`
}

// The params of the built-ins that name a state path. At the top of a bound action's params, `{ "$item": "field" }`
// resolves to the item's path; inside an onSuccess/onError chain json-render resolves it as a prop, to the item's value.
const PATH_PARAMS = ["statePath", "clearStatePath"]

/** Why an outward action or a confirm in a passive binding never runs; part of the validator's message. */
export const ACTIVATION_RULE = `outward actions (${[...OUTWARD_ACTIONS].join(", ")}) and confirms run only when the user activates a control: ${describeActivations()}.`

const MAX_CHAIN_DEPTH = 8

/** The most outward actions one run of a binding (or a list of them) can reach, along any onSuccess/onError path. */
function outwardCount(binding: unknown, depth = 0): number {
  if (Array.isArray(binding)) return binding.reduce((sum: number, entry) => sum + outwardCount(entry, depth), 0)
  if (!isRecord(binding) || typeof binding.action !== "string") return 0
  const own = OUTWARD_ACTIONS.has(binding.action as ActionName) ? 1 : 0
  // A built-in runs neither chain.
  if (BUILTIN_ACTIONS.has(binding.action) || depth >= MAX_CHAIN_DEPTH) return own
  const params = isRecord(binding.params) ? binding.params : {}
  return (
    own +
    Math.max(
      outwardCount(binding.onSuccess ?? params[ON_SUCCESS_PARAM], depth + 1),
      outwardCount(binding.onError ?? params[ON_ERROR_PARAM], depth + 1),
    )
  )
}

/**
 * Action bindings of an element's `on` and `watch` maps, with their onSuccess/onError chains (as written, or moved into
 * reserved params by the normalizer): unknown actions, bindings that are not bindings, custom actions whose params do
 * not match the catalog, outward actions or confirms where no activation can happen (watch, on.focus, on.blur, ...),
 * which never run, more outward actions than one activation runs, and chains on built-ins, which never run.
 */
function checkBindings(
  key: string,
  element: Record<string, unknown>,
  known: ReadonlySet<string>,
  definitions: Readonly<Record<string, { readonly params?: unknown }>>,
): SurfaceIssue[] {
  const issues: SurfaceIssue[] = []
  const type = typeof element.type === "string" ? element.type : ""
  const check = (binding: unknown, where: string, passive: "watch" | "event" | undefined, depth: number) => {
    if (!isRecord(binding) || typeof binding.action !== "string") {
      issues.push({ severity: "warning", code: "invalid_binding", message: notABinding(where), elementKey: key })
      return
    }
    const action = binding.action
    const params = isRecord(binding.params) ? binding.params : {}
    const definition = known.has(action) && Object.hasOwn(definitions, action) ? definitions[action] : undefined
    const paramsProblem = checkActionParams(action, params, where, definition)
    if (paramsProblem)
      issues.push({ severity: "warning", code: "invalid_action_params", message: paramsProblem, elementKey: key })
    if (BUILTIN_ACTIONS.has(action) && depth > 0)
      for (const name of PATH_PARAMS) {
        const value = params[name]
        if (isRecord(value) && typeof value.$item === "string" && Object.keys(value).length === 1)
          issues.push({
            severity: "warning",
            code: "item_path_in_chain",
            message: `${where}: { "$item": "${truncate(value.$item, 40)}" } as ${action}'s ${name} gives the item's value here, not its state path ($item gives a path only in the params of an action bound directly): bind ${action} directly instead, e.g. as the next entry of the event's array of bindings`,
            elementKey: key,
          })
      }
    if (!known.has(action))
      issues.push({
        severity: "warning",
        code: "unknown_action",
        message: `unknown action "${truncate(action, 60)}" in ${where}`,
        elementKey: key,
      })
    else if (passive && OUTWARD_ACTIONS.has(action as ActionName))
      issues.push({
        severity: "warning",
        code: `outward_action_in_${passive}`,
        message: `${action} in ${where} never runs: ${ACTIVATION_RULE}`,
        elementKey: key,
      })
    else if (
      passive &&
      !BUILTIN_ACTIONS.has(action) &&
      ((binding.confirm !== undefined && binding.confirm !== null && binding.confirm !== false) ||
        (params[CONFIRM_PARAM] !== undefined && params[CONFIRM_PARAM] !== null && params[CONFIRM_PARAM] !== false))
    )
      issues.push({
        severity: "warning",
        code: `confirm_in_${passive}`,
        message: `${action} in ${where} asks for a confirm, so it never runs: ${ACTIVATION_RULE}`,
        elementKey: key,
      })
    if (BUILTIN_ACTIONS.has(action)) {
      // json-render runs a built-in itself and returns before looking at its chain.
      const chained = (["onSuccess", "onError"] as const).filter((field) => binding[field] != null)
      if (chained.length > 0)
        issues.push({
          severity: "warning",
          code: "chain_on_builtin",
          message: `${where}.${chained.join("/")} never runs: ${action} runs no onSuccess or onError (only the custom actions do). List the next action after it in an array instead, e.g. "press": [{ "action": "${action}", ... }, { "action": "showToast", ... }]`,
          elementKey: key,
        })
      return
    }
    if (depth >= MAX_CHAIN_DEPTH) return
    for (const [field, param] of [
      ["onSuccess", ON_SUCCESS_PARAM],
      ["onError", ON_ERROR_PARAM],
    ] as const) {
      const next = binding[field] ?? params[param]
      if (!isRecord(next)) continue
      if (next[IGNORED_CHAIN] === true || isExpression(next) || isExpression(next.params) || isExpression(next.set))
        issues.push({
          severity: "warning",
          code: "dynamic_chain",
          message: `${where}.${field} is ignored: write it out as { "action": "...", "params": {...} } or { "set": {...} }, not as an expression or from state`,
          elementKey: key,
        })
      else if (typeof next.action === "string") check(next, `${where}.${field}`, passive, depth + 1)
    }
  }
  for (const field of ["on", "watch"] as const) {
    const map = element[field]
    if (!isRecord(map)) continue
    for (const [name, value] of Object.entries(map)) {
      const where = field === "on" ? `on.${name}` : `watch["${name}"]`
      const passive = field === "watch" ? "watch" : isActivation(type, name) ? undefined : "event"
      if (Array.isArray(value)) value.forEach((binding, index) => check(binding, `${where}[${index}]`, passive, 0))
      else check(value, where, passive, 0)
      const outward = passive ? 0 : outwardCount(value)
      if (outward > OUTWARD_BURST)
        issues.push({
          severity: "warning",
          code: "outward_burst",
          message: `${where} runs ${outward} of ${[...OUTWARD_ACTIONS].join(", ")}, but one activation runs at most ${OUTWARD_BURST}: the ones after that are refused`,
          elementKey: key,
        })
    }
  }
  return issues
}

/**
 * Validation checks genui does not run: lists or entries written as expressions (the normalizer replaces them with a
 * check that always passes) and patterns the safe matcher cannot run (src/protocol/pattern.ts).
 */
function checkChecks(key: string, props: Record<string, unknown>): SurfaceIssue[] {
  const checks = props.checks
  const ignored = (where: string): SurfaceIssue => ({
    severity: "warning",
    code: "dynamic_check",
    message: `${where} is ignored: write each check out as { "type": "...", "message": "..." }, not as an expression or from state`,
    elementKey: key,
  })
  if (isExpression(checks)) return [ignored("checks")]
  if (!Array.isArray(checks)) return []
  return checks.flatMap((check: unknown, index): SurfaceIssue[] => {
    if (!isRecord(check)) return []
    if (isExpression(check) || isExpression(check.type) || check.type === IGNORED_CHECK)
      return [ignored(`checks[${index}]`)]
    if (check.type !== "pattern" && check.type !== SAFE_CHECKS.pattern) return []
    const pattern = isRecord(check.args) ? check.args.pattern : undefined
    const problem = typeof pattern === "string" ? patternProblem(pattern) : undefined
    return problem
      ? [
          {
            severity: "warning",
            code: "unsupported_pattern",
            message: `the pattern of checks[${index}] is ignored: ${problem}`,
            elementKey: key,
          },
        ]
      : []
  })
}

const DIRECTIVE_NAMES = new Set(standardDirectives.map((directive) => directive.name))
const MAX_EXPRESSION_DEPTH = 16

/**
 * Prop expressions json-render cannot evaluate: an object with two directive keys (`$format` and `$concat`), or a
 * `$cond` whose condition is not a condition (a path string such as "/isAdmin" instead of `{ "$state": "/isAdmin" }`).
 * The renderer shows such a prop as empty; this says why.
 */
/**
 * State paths an element writes or follows that are too deep or long to be paths (see MAX_POINTER_DEPTH in
 * ./patch.ts): its repeat's list, its watched paths, its two-way bindings and the paths its actions write. Nothing can
 * be written to such a path, so the agent hears of it here.
 */
function checkPaths(key: string, element: Record<string, unknown>): SurfaceIssue[] {
  const found: [where: string, path: string][] = []
  const repeat = element.repeat
  if (isRecord(repeat) && typeof repeat.statePath === "string") found.push(["repeat.statePath", repeat.statePath])
  if (isRecord(element.watch)) for (const path of Object.keys(element.watch)) found.push(["a watched path", path])
  if (isRecord(element.props))
    for (const [name, value] of Object.entries(element.props))
      if (isRecord(value) && typeof value.$bindState === "string") found.push([`props.${name}`, value.$bindState])
  for (const field of ["on", "watch"] as const) {
    const map = element[field]
    if (!isRecord(map)) continue
    for (const [name, value] of Object.entries(map))
      for (const binding of Array.isArray(value) ? value : [value]) {
        const params = isRecord(binding) && isRecord(binding.params) ? binding.params : undefined
        for (const param of PATH_PARAMS)
          if (typeof params?.[param] === "string") found.push([`${field}.${name}'s ${param}`, params[param]])
      }
  }
  for (const [where, path] of found) {
    const problem = pointerTooLarge(path.startsWith("/") ? path : `/${path}`)
    if (problem)
      return [{ severity: "warning", code: "path_too_large", message: `${where}: ${problem}`, elementKey: key }]
  }
  return []
}

function checkExpressions(key: string, props: Record<string, unknown>): SurfaceIssue[] {
  const issues: SurfaceIssue[] = []
  const visit = (value: unknown, where: string, depth: number) => {
    if (depth > MAX_EXPRESSION_DEPTH || typeof value !== "object" || value === null) return
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${where}[${index}]`, depth + 1))
    const record = value as Record<string, unknown>
    const directives = Object.keys(record).filter((name) => DIRECTIVE_NAMES.has(name))
    if (directives.length > 1)
      issues.push({
        severity: "warning",
        code: "invalid_expression",
        message: `"${where}" has several directives (${directives.join(", ")}) in one object, so it shows nothing: nest them instead`,
        elementKey: key,
      })
    if ("$cond" in record) {
      const condition = record.$cond
      if (typeof condition !== "boolean" && (typeof condition !== "object" || condition === null))
        issues.push({
          severity: "warning",
          code: "invalid_expression",
          message: `"${where}" has a $cond that is not a condition, so it shows nothing: write { "$state": "/path" } (with eq, neq, gt, ... if needed), not ${preview(condition)}`,
          elementKey: key,
        })
    }
    for (const [name, member] of Object.entries(record)) visit(member, `${where}.${name}`, depth + 1)
  }
  for (const [name, value] of Object.entries(props)) visit(value, name, 0)
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
  const state =
    userState && Object.keys(userState).every((key) => key === UI_STATE_ROOT || key === UI_SECRET_ROOT)
      ? undefined
      : userState
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
 * match the component's schema (values that are expressions are only known at render time and are skipped), unknown
 * actions and bindings that cannot run as written. For a spec from normalizeSpec, also what the normalizer removed or
 * ignored (see normalizeNotes). `fatal` means nothing can render: no root, no root element, or a root of an unknown type.
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
  const definitions = (isRecord(catalog.data.actions) ? catalog.data.actions : {}) as Record<
    string,
    { readonly params?: unknown }
  >

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
      issues.push(...checkChecks(key, props))
      issues.push(...checkExpressions(key, props))
    }
    if (element.repeat !== undefined && !validRepeat(element.repeat))
      issues.push({ severity: "error", code: "invalid_repeat", message: INVALID_REPEAT, elementKey: key })
    issues.push(...checkBindings(key, element, known, definitions))
    issues.push(...checkPaths(key, element))
  }
  // What the normalizer removed or ignored before this spec got here (nothing, for a spec it did not produce).
  issues.push(...normalizeNotes(spec))

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
