import { autoFixSpec, type Spec, type UIElement } from "@json-render/core"
import {
  CONFIRM_PARAM,
  IGNORED_CHAIN,
  isActivation,
  ON_ERROR_PARAM,
  ON_SUCCESS_PARAM,
  PASSIVE_PARAM,
} from "../catalog/actions.ts"
import { componentDefinitions } from "../catalog/components.ts"
import { UI_SECRET_ROOT } from "../shared/constants.ts"
import { IGNORED_CHECK, SAFE_CHECKS } from "./pattern.ts"

/** The state subtree where auto-bound input values live: `/__genui/<element key>`. */
export const UI_STATE_ROOT = "__genui"

/** The state subtree where auto-bound password values live, never persisted: `/__genui_secret/<element key>`. */
export { UI_SECRET_ROOT }

/** Actions json-render runs itself, without a registered handler (and so without its confirm dialog). */
export const BUILTIN_ACTIONS: ReadonlySet<string> = new Set([
  "setState",
  "pushState",
  "removeState",
  "validateForm",
  "push",
  "pop",
])

/**
 * The two-way prop of each input component. The normalizer binds it to `/__genui/<key>` so what the user enters lives
 * in the surface's state store: it survives remounts and is persisted with the rest of the state.
 */
export const BOUND_PROPS: Readonly<Record<string, string>> = {
  Input: "value",
  Textarea: "value",
  Select: "value",
  Checkbox: "checked",
  Radio: "value",
  Switch: "checked",
  Slider: "value",
  Toggle: "pressed",
  ToggleGroup: "value",
  ButtonGroup: "selected",
  DropdownMenu: "value",
  Pagination: "page",
  Tabs: "value",
}

// Keys that must never become property names we assign, or state paths (src/protocol/patch.ts refuses them too).
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])
// Element fields json-render's autoFixSpec moves out of `props`.
const RELOCATED = ["visible", "on", "repeat", "watch"] as const

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Whether a prop value is a json-render expression (`$state`, `$bindState`, `$item`, `$index`, `$bindItem`,
 * `$cond`/`$then`/`$else`, `$computed`, `$template`) or a directive: any object with a key starting with "$".
 */
export const isExpression = (value: unknown): boolean =>
  isRecord(value) && Object.keys(value).some((key) => key.startsWith("$"))

/** RFC 6901 escaping of one pointer token. */
export const escapePointer = (token: string) => token.replace(/~/g, "~0").replace(/\//g, "~1")

/** The state path an element's auto-bound input value lives at. */
export const uiStatePath = (elementKey: string) => `/${UI_STATE_ROOT}/${escapePointer(elementKey)}`

/** The state path an auto-bound password Input's value lives at (never persisted). */
export const secretStatePath = (elementKey: string) => `/${UI_SECRET_ROOT}/${escapePointer(elementKey)}`

/**
 * Whether an Input keeps a secret: `type: "password"`, or a type only known at render time (an expression), which may
 * turn out to be one. Its value is bound under UI_SECRET_ROOT, which is never persisted.
 */
export const isSecretInput = (element: { readonly type: string; readonly props?: unknown }): boolean => {
  if (element.type !== "Input") return false
  const type = isRecord(element.props) ? element.props.type : undefined
  return type === "password" || isExpression(type)
}

// ---------------------------------------------------------------------------------------------------------------------
// Notes: what the normalizer removed or ignored because it cannot render or run. The validator reports them
// (validateSurface reads normalizeNotes), so a model's mistake reaches the issues footer and "Ask agent to fix" instead of
// silently disappearing.
// ---------------------------------------------------------------------------------------------------------------------

/** Something normalizeSpec removed or ignored, as a validation issue (src/protocol/validate.ts, SurfaceIssue). */
export interface NormalizeNote {
  readonly severity: "error" | "warning"
  readonly code: string
  /** Relative to the element when `elementKey` is set. */
  readonly message: string
  readonly elementKey?: string
}

/** A note about one element, before it knows the element's key. */
type LocalNote = Omit<NormalizeNote, "elementKey">

const NO_NOTES: readonly NormalizeNote[] = Object.freeze([])
const notesBySpec = new WeakMap<object, readonly NormalizeNote[]>()
const notesByElement = new WeakMap<object, readonly LocalNote[]>()

/** What normalizeSpec removed or ignored in the spec it returned (empty for any other spec). */
export const normalizeNotes = (spec: unknown): readonly NormalizeNote[] =>
  (isRecord(spec) && notesBySpec.get(spec)) || NO_NOTES

const typeName = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value)

/** The validator's wording for a binding that is not one. */
export const notABinding = (where: string) => `${where} is not an action binding ({ "action": "...", "params": {...} })`

/** The validator's wording for an invalid `repeat`. */
export const INVALID_REPEAT = 'has an invalid "repeat" (expected { "statePath": "/path/to/array" })'

// ---------------------------------------------------------------------------------------------------------------------
// Element-local steps. They depend only on the element, so results are cached by the element's identity: the patch
// applier shares untouched elements between versions of a spec, and so do we, which keeps the renderer's updates small
// while a canvas streams.
// ---------------------------------------------------------------------------------------------------------------------

const localCache = new WeakMap<object, UIElement>()

function relocate(element: UIElement): UIElement {
  const props = element.props as Record<string, unknown>
  if (!RELOCATED.some((key) => props[key] !== undefined)) return element
  try {
    return autoFixSpec({ root: "", elements: { element } }, { lossy: false }).spec.elements.element ?? element
  } catch {
    return element
  }
}

/**
 * How many props an element keeps, and how many state paths it watches. json-render resolves every prop into a props
 * object of each instance's own (each entry of a parent's `children`, each row of a repeat) and subscribes every watched
 * path for each instance, before genui's render budget decides whether the instance renders, and whether it is
 * visible: 4,000 entries of an element with 7,000 props, or 7,000 watched paths, froze the window for 6 to 11 s. With
 * these bounds an instance costs at most a few dozen entries; the render budget bounds the instances (SLOT_UNITS).
 */
export const MAX_ELEMENT_PROPS = 32
export const MAX_WATCH_PATHS = 32

// The props each component's schema names, which an element over MAX_ELEMENT_PROPS keeps first.
const schemaProps = new Map<string, ReadonlySet<string>>()
function ownProps(type: string): ReadonlySet<string> {
  let names = schemaProps.get(type)
  if (!names) {
    const definition = Object.hasOwn(componentDefinitions, type)
      ? (componentDefinitions as Record<string, { readonly props?: { readonly shape?: object } }>)[type]
      : undefined
    names = new Set(Object.keys(definition?.props?.shape ?? {}))
    schemaProps.set(type, names)
  }
  return names
}

const count = (value: number) => value.toLocaleString("en-US")

// An element's props and watched paths past MAX_ELEMENT_PROPS and MAX_WATCH_PATHS are dropped, with a note.
function capElement(element: UIElement, notes: LocalNote[]): UIElement {
  let next = element
  const props = element.props as Record<string, unknown>
  const names = Object.keys(props)
  if (names.length > MAX_ELEMENT_PROPS) {
    const own = ownProps(element.type)
    const kept = new Set(names.filter((name) => own.has(name)).slice(0, MAX_ELEMENT_PROPS))
    for (const name of names) {
      if (kept.size >= MAX_ELEMENT_PROPS) break
      kept.add(name)
    }
    next = {
      ...next,
      props: Object.fromEntries(names.filter((name) => kept.has(name)).map((name) => [name, props[name]])),
    }
    notes.push({
      severity: "warning",
      code: "too_many_props",
      message: `has ${count(names.length)} props: an element keeps at most ${MAX_ELEMENT_PROPS} (its component's own first), the rest are ignored`,
    })
  }
  const watch: unknown = element.watch
  if (isRecord(watch)) {
    const paths = Object.keys(watch)
    if (paths.length > MAX_WATCH_PATHS) {
      next = {
        ...next,
        watch: Object.fromEntries(paths.slice(0, MAX_WATCH_PATHS).map((path) => [path, watch[path]])),
      } as UIElement
      notes.push({
        severity: "warning",
        code: "too_many_watches",
        message: `watches ${count(paths.length)} state paths: an element watches at most ${MAX_WATCH_PATHS}, the rest are ignored`,
      })
    }
  }
  return next
}

function sanitizeChildren(element: UIElement, notes: LocalNote[]): UIElement {
  const children: unknown = element.children
  if (!Array.isArray(children)) {
    // (Leaving `children` out is fine for a leaf.)
    if (children !== undefined)
      notes.push({
        severity: "error",
        code: "invalid_children",
        message: `"children" should be an array of element keys, got ${typeName(children)}: its children do not render`,
      })
    return { ...element, children: [] }
  }
  if (children.every((child) => typeof child === "string")) return element
  notes.push({
    severity: "error",
    code: "invalid_children",
    message: `"children" should hold element keys (strings): ${children.filter((child) => typeof child !== "string").length} entries are not, and do not render`,
  })
  return { ...element, children: children.filter((child): child is string => typeof child === "string") }
}

// json-render iterates slots and reads `repeat.statePath`; shapes it does not expect would throw in the validator.
function sanitizeStructure(element: UIElement, notes: LocalNote[]): UIElement {
  let next = element
  const repeat: unknown = next.repeat
  if (repeat !== undefined) {
    const statePath = isRecord(repeat) ? repeat.statePath : undefined
    const valid = typeof statePath === "string" || (isRecord(statePath) && typeof statePath.$item === "string")
    if (!valid) {
      notes.push({
        severity: "error",
        code: "invalid_repeat",
        message: `${INVALID_REPEAT}: it renders its children once`,
      })
      const { repeat: _repeat, ...rest } = next
      next = rest as UIElement
    }
  }
  const slots: unknown = next.slots
  if (slots !== undefined) {
    const clean = isRecord(slots)
      ? Object.fromEntries(
          Object.entries(slots)
            .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
            .map(([name, keys]) => [name, keys.filter((key): key is string => typeof key === "string")]),
        )
      : undefined
    const unchanged =
      clean !== undefined &&
      isRecord(slots) &&
      Object.keys(clean).length === Object.keys(slots).length &&
      Object.entries(clean).every(([name, keys]) => (slots[name] as unknown[]).length === keys.length)
    if (!unchanged) {
      const { slots: _slots, ...rest } = next
      next = (clean ? { ...rest, slots: clean } : rest) as UIElement
    }
  }
  return next
}

/** How deep onSuccess/onError chains may nest; deeper handlers are dropped. */
const MAX_CHAIN_DEPTH = 8

const CHAINS = [
  ["onSuccess", ON_SUCCESS_PARAM],
  ["onError", ON_ERROR_PARAM],
] as const

const isItemReference = (value: unknown): value is { $item: string } =>
  isRecord(value) && typeof value.$item === "string"

const IGNORED_HANDLER: Readonly<Record<string, unknown>> = Object.freeze({ [IGNORED_CHAIN]: true })

/**
 * Whether an onSuccess/onError handler is written as an expression: on itself, its params or its `set`. A moved chain is
 * one of the bound action's params, and json-render resolves those deeply when the action fires, so such a handler would
 * become a binding this rewrite never saw (no passive tag, its confirm and chains unmoved).
 */
const isDynamicHandler = (handler: Record<string, unknown>) =>
  isExpression(handler) || isExpression(handler.params) || isExpression(handler.set)

// An onSuccess/onError handler: an action binding (rewritten like any binding), or `{ set }`. A handler written as an
// expression becomes IGNORED_HANDLER (reported by the validator); anything else (`navigate`: genui has no navigation) is
// dropped, with a note.
function rewriteHandler(
  handler: unknown,
  passive: string | undefined,
  depth: number,
  where: string,
  notes: LocalNote[] | undefined,
): unknown {
  const drop = (why: string) => {
    notes?.push({ severity: "warning", code: "invalid_chain", message: `${where} is ignored: ${why}` })
    return undefined
  }
  if (handler === undefined || handler === null) return undefined
  if (depth > MAX_CHAIN_DEPTH) return drop(`onSuccess/onError chains nest at most ${MAX_CHAIN_DEPTH} deep`)
  if (!isRecord(handler)) return drop('write it as { "action": "...", "params": {...} } or { "set": {...} }')
  if (handler[IGNORED_CHAIN] === true && Object.keys(handler).length === 1) return handler
  if (handler[IGNORED_CHAIN] === true || isDynamicHandler(handler)) return IGNORED_HANDLER
  if (typeof handler.action === "string") return rewriteBinding(handler, passive, depth, where, notes)
  if (isRecord(handler.set)) return Object.keys(handler).length === 1 ? handler : { set: handler.set }
  return drop(
    'genui runs only { "action": "...", "params": {...} } or { "set": {...} } handlers (there is no navigation)',
  )
}

/**
 * An onSuccess/onError handler as the action it chains from resolved it, rewritten again before it runs (defence in
 * depth for rewriteHandler): an action binding with its confirm and chains moved into reserved params and the parent's
 * passive tag, or `{ set }`. Undefined for anything else, including a handler the normalizer ignored.
 */
export function normalizeChained(handler: unknown, passive: string | undefined): Record<string, unknown> | undefined {
  if (!isRecord(handler) || handler[IGNORED_CHAIN] === true || isDynamicHandler(handler)) return undefined
  if (typeof handler.action === "string") return rewriteBinding(handler, passive, 1, "", undefined)
  return isRecord(handler.set) ? { set: handler.set } : undefined
}

/**
 * One action binding of an `on` or `watch` map, or of an onSuccess/onError chain. `passive` says where it runs when
 * that is not an activation (`watch["/q"]`, `on.blur`), else undefined.
 *
 * Built-ins: json-render runs them itself and ignores their `confirm`, so it is only dropped. Custom actions:
 * - `confirm` moves into CONFIRM_PARAM, so the GUI's handler asks with the app's dialog and json-render's own (unstyled,
 *   and in Solid never shown) ConfirmDialog never opens.
 * - `onSuccess`/`onError` move into ON_SUCCESS_PARAM/ON_ERROR_PARAM, rewritten the same way, so the handler runs them
 *   only after a genuine success or failure, never after a refusal.
 * - A top-level `{ "$item": "field" }` param becomes `{ "$bindItem": "field" }`: json-render resolves the first to the
 *   item's state path (meant for setState), the second to its value, which is what a custom action's text, url or data
 *   needs.
 * - A passive binding gets PASSIVE_PARAM, so its outward actions are refused.
 */
function rewriteBinding(
  binding: Record<string, unknown>,
  passive: string | undefined,
  depth: number,
  where: string,
  notes: LocalNote[] | undefined,
): Record<string, unknown> {
  const action = binding.action
  if (typeof action !== "string" || BUILTIN_ACTIONS.has(action)) {
    if (!("confirm" in binding)) return binding
    const { confirm, ...rest } = binding
    if (typeof action === "string" && confirm !== undefined && confirm !== null && confirm !== false)
      notes?.push({
        severity: "warning",
        code: "confirm_on_builtin",
        message: `${where} runs ${action} without asking: "confirm" works on the custom actions only`,
      })
    return rest
  }

  const rest: Record<string, unknown> = { ...binding }
  const params: Record<string, unknown> = isRecord(binding.params) ? { ...binding.params } : {}
  let changed = !isRecord(binding.params) && binding.params !== undefined

  if ("confirm" in rest) {
    const confirm = rest.confirm
    delete rest.confirm
    changed = true
    if (confirm !== undefined && confirm !== null) params[CONFIRM_PARAM] = confirm
  }
  for (const [field, param] of CHAINS) {
    // The field wins over a reserved param the model wrote itself; either way the handler is rewritten.
    const moved = field in rest
    const handler = moved ? rest[field] : params[param]
    if (moved) {
      delete rest[field]
      changed = true
    } else if (!(param in params)) continue
    const rewritten = rewriteHandler(handler, passive, depth + 1, `${where}.${field}`, notes)
    if (rewritten === undefined) {
      if (param in params) changed = true
      delete params[param]
    } else if (rewritten !== params[param]) {
      params[param] = rewritten
      changed = true
    }
  }
  for (const [key, value] of Object.entries(params)) {
    if (key === CONFIRM_PARAM || key === ON_SUCCESS_PARAM || key === ON_ERROR_PARAM || !isItemReference(value)) continue
    params[key] = { $bindItem: value.$item }
    changed = true
  }
  if (passive !== undefined && params[PASSIVE_PARAM] !== passive) {
    params[PASSIVE_PARAM] = passive
    changed = true
  }
  return changed ? { ...rest, params } : binding
}

// Rewrites each binding of an `on` or `watch` map. Bindings that are not objects are dropped, with a note: the renderer
// reads fields of every binding when an event fires and would throw on them.
function rewriteBindings(element: UIElement, field: "on" | "watch", notes: LocalNote[]): UIElement {
  const map: unknown = element[field]
  if (map === undefined) return element
  if (!isRecord(map)) {
    notes.push({
      severity: "warning",
      code: "invalid_binding",
      message:
        field === "on"
          ? `"on" should map events to action bindings, e.g. { "press": { "action": "...", "params": {...} } }, got ${typeName(map)}`
          : `"watch" should map state paths to action bindings, got ${typeName(map)}`,
    })
    const { [field]: _dropped, ...rest } = element
    return rest as UIElement
  }
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(map)) {
    const where = field === "on" ? `on.${name}` : `watch[${JSON.stringify(name)}]`
    if (FORBIDDEN_KEYS.has(name)) {
      notes.push({
        severity: "warning",
        code: "invalid_binding",
        message: `${where} is ignored: "${name}" is reserved`,
      })
      changed = true
      continue
    }
    const passive = field === "watch" || !isActivation(element.type, name) ? where : undefined
    if (Array.isArray(value)) {
      const kept: [Record<string, unknown>, number][] = []
      value.forEach((binding: unknown, index) => {
        if (isRecord(binding)) kept.push([binding, index])
        else notes.push({ severity: "warning", code: "invalid_binding", message: notABinding(`${where}[${index}]`) })
      })
      const rewritten = kept.map(([binding, index]) => rewriteBinding(binding, passive, 0, `${where}[${index}]`, notes))
      if (kept.length !== value.length || rewritten.some((binding, index) => binding !== kept[index]![0])) {
        changed = true
        if (rewritten.length > 0) next[name] = rewritten
      } else next[name] = value
    } else if (isRecord(value)) {
      const rewritten = rewriteBinding(value, passive, 0, where, notes)
      if (rewritten !== value) changed = true
      next[name] = rewritten
    } else {
      notes.push({ severity: "warning", code: "invalid_binding", message: notABinding(where) })
      changed = true
    }
  }
  return changed ? ({ ...element, [field]: next } as UIElement) : element
}

const SAFE_CHECK_TYPES: Readonly<Record<string, string>> = { pattern: SAFE_CHECKS.pattern, email: SAFE_CHECKS.email }
const IGNORED: Readonly<Record<string, unknown>> = Object.freeze({ type: IGNORED_CHECK, message: "" })

// Validation runs on the app's main thread, and json-render's `pattern` and `email` built-ins can take minutes on a
// crafted pattern or value: they become genui's safe checks (src/protocol/pattern.ts). A check written as an expression
// could resolve to a built-in at render time, so it is replaced by one that always passes, which the validator reports.
function sanitizeChecks(element: UIElement): UIElement {
  const props = element.props as Record<string, unknown>
  const checks = props.checks
  let next: unknown[]
  if (Array.isArray(checks)) {
    let changed = false
    next = checks.map((check: unknown) => {
      if (!isRecord(check)) return check
      if (isExpression(check) || isExpression(check.type)) {
        changed = true
        return IGNORED
      }
      if (typeof check.type !== "string" || !Object.hasOwn(SAFE_CHECK_TYPES, check.type)) return check
      changed = true
      return { ...check, type: SAFE_CHECK_TYPES[check.type] }
    })
    if (!changed) return element
  } else if (isExpression(checks)) next = [IGNORED]
  else return element
  return { ...element, props: { ...props, checks: next } }
}

/** The element-local normalization of one element, or undefined when it cannot be an element at all. */
function normalizeElement(raw: unknown): UIElement | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined
  const cached = localCache.get(raw)
  if (cached) return cached

  const notes: LocalNote[] = []
  let element = raw as unknown as UIElement
  if (!isRecord(element.props)) element = { ...element, props: {} }
  element = relocate(element)
  element = capElement(element, notes)
  element = sanitizeChildren(element, notes)
  element = sanitizeStructure(element, notes)
  element = sanitizeChecks(element)
  element = rewriteBindings(element, "on", notes)
  element = rewriteBindings(element, "watch", notes)

  if (notes.length > 0) notesByElement.set(element, Object.freeze(notes))
  localCache.set(raw, element)
  // Normalizing a normalized element is a no-op; remember that so a second pass keeps identity too.
  if ((element as unknown) !== raw) localCache.set(element, element)
  return element
}

// ---------------------------------------------------------------------------------------------------------------------
// Auto-binding of input state.
// ---------------------------------------------------------------------------------------------------------------------

interface Bound {
  readonly element: UIElement
  /** UI_STATE_ROOT, or UI_SECRET_ROOT for a password Input. */
  readonly root: string
  readonly seed: unknown
}

const bindCache = new WeakMap<UIElement, Map<string, Bound>>()

/**
 * The element with its input prop bound to `/__genui/<key>` (`/__genui_secret/<key>` for a password Input, see
 * isSecretInput), and the value to seed there (undefined for none).
 */
function bindInput(key: string, element: UIElement): Bound | undefined {
  const prop = Object.hasOwn(BOUND_PROPS, element.type) ? BOUND_PROPS[element.type] : undefined
  if (!prop || FORBIDDEN_KEYS.has(key)) return undefined
  const props = element.props as Record<string, unknown>
  const current = props[prop]
  if (isExpression(current)) return undefined

  const perElement = bindCache.get(element)
  const cached = perElement?.get(key)
  if (cached) return cached

  let seed = current
  if (seed === undefined && element.type === "Tabs" && !isExpression(props.defaultValue)) seed = props.defaultValue
  const secret = isSecretInput(element)
  const result: Bound = {
    element: {
      ...element,
      props: { ...props, [prop]: { $bindState: secret ? secretStatePath(key) : uiStatePath(key) } },
    },
    root: secret ? UI_SECRET_ROOT : UI_STATE_ROOT,
    seed: seed === null ? undefined : seed,
  }
  if (perElement) perElement.set(key, result)
  else bindCache.set(element, new Map([[key, result]]))
  return result
}

/** Keys of the elements that render inside a `repeat` (descendants of a repeating element, following children). */
function repeatedKeys(root: string, elements: Readonly<Record<string, UIElement>>): Set<string> {
  const inside = new Set<string>()
  const seen = new Set<string>()
  const queue: [string, boolean][] = [[root, false]]
  while (queue.length > 0) {
    const [key, inRepeat] = queue.pop()!
    const mark = `${inRepeat ? 1 : 0}${key}`
    if (seen.has(mark) || !Object.hasOwn(elements, key)) continue
    seen.add(mark)
    if (inRepeat) inside.add(key)
    const element = elements[key]!
    const childInRepeat = inRepeat || element.repeat !== undefined
    for (const child of element.children ?? []) queue.push([child, childInRepeat])
  }
  return inside
}

// The last seeded state per original state, so a stream of patches that leave the seeds alone keeps `state` stable.
const stateCache = new WeakMap<object, Record<string, unknown>>()
let stateFromNothing: Record<string, unknown> | undefined

const sameShallow = (a: unknown, b: unknown) =>
  a === b ||
  (isRecord(a) &&
    isRecord(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(b).every(([key, value]) => Object.hasOwn(a, key) && Object.is(a[key], value)))

/** The state with each seed `[root, key, value]` added at `/<root>/<key>`, unless the state already has that key. */
function seedState(
  state: Record<string, unknown> | undefined,
  seeds: readonly (readonly [string, string, unknown])[],
): Record<string, unknown> | undefined {
  const added = new Map<string, Record<string, unknown>>()
  for (const [root, key, value] of seeds) {
    const existing = state && isRecord(state[root]) ? (state[root] as Record<string, unknown>) : {}
    if (Object.hasOwn(existing, key)) continue
    let values = added.get(root)
    if (!values) added.set(root, (values = { ...existing }))
    values[key] = value
  }
  if (added.size === 0) return state

  const previous = state ? stateCache.get(state) : stateFromNothing
  if (
    previous &&
    [UI_STATE_ROOT, UI_SECRET_ROOT].every((root) => sameShallow(previous[root], added.get(root) ?? state?.[root]))
  )
    return previous

  const next = { ...state, ...Object.fromEntries(added) }
  if (state) stateCache.set(state, next)
  else stateFromNothing = next
  return next
}

// ---------------------------------------------------------------------------------------------------------------------
// Secret paths.
// ---------------------------------------------------------------------------------------------------------------------

const NO_SECRETS: readonly string[] = Object.freeze([])
const secretCache = new WeakMap<object, readonly string[]>()

/** How many item path patterns one element may have; past it, its items match at any depth (`/**`). */
export const MAX_SECRET_BASES = 64

/**
 * The state paths a spec's password Inputs (see isSecretInput) write to besides the secret root: an explicit
 * `{ "$bindState": "/form/pw" }`, or `{ "$bindItem": "pw" }` inside a repeat, as `/<repeat statePath>/*\/pw` (`*` is
 * any item; a repeat whose path is not known statically gives `**\/pw`, any depth). The state store never persists
 * what the user types there.
 *
 * Linear in the spec: each element's parents are kept once each, and each element's patterns are worked out once. An
 * element that is its own ancestor (a cycle, whose rows nest without end) or has more than MAX_SECRET_BASES patterns
 * (a lattice of repeats doubles them at every level) gets the any-depth pattern, which covers more paths, never fewer.
 */
export function secretPaths(spec: Spec | null | undefined): readonly string[] {
  if (!isRecord(spec) || !isRecord(spec.elements)) return NO_SECRETS
  const cached = secretCache.get(spec)
  if (cached) return cached
  const elements = spec.elements as Record<string, UIElement>
  const parents = new Map<string, Set<string>>()
  for (const [key, element] of Object.entries(elements))
    for (const child of Array.isArray(element?.children) ? element.children : [])
      if (typeof child === "string") {
        let set = parents.get(child)
        if (!set) parents.set(child, (set = new Set()))
        set.add(key)
      }

  // The state paths of the items of the repeats `key` renders inside, as patterns.
  const bases = new Map<string, readonly string[]>()
  const open = new Set<string>()
  const ANY: readonly string[] = ["/**"]
  const itemBases = (key: string): readonly string[] => {
    const known = bases.get(key)
    if (known) return known
    open.add(key)
    const result = new Set<string>()
    let any = false
    for (const parent of parents.get(key) ?? []) {
      if (open.has(parent)) {
        any = true
        break
      }
      const repeat: unknown = elements[parent]?.repeat
      const statePath = isRecord(repeat) ? repeat.statePath : undefined
      if (typeof statePath === "string") result.add(`${statePath.startsWith("/") ? statePath : `/${statePath}`}/*`)
      else if (isRecord(statePath) && typeof statePath.$item === "string") {
        const field = statePath.$item ? `/${statePath.$item}` : ""
        const outer = itemBases(parent)
        for (const base of outer.length > 0 ? outer.map((base) => `${base}${field}/*`) : [`/**${field}/*`])
          result.add(base)
      } else for (const base of itemBases(parent)) result.add(base)
      if (result.size > MAX_SECRET_BASES) {
        any = true
        break
      }
    }
    open.delete(key)
    const list = any ? ANY : [...result]
    bases.set(key, list)
    return list
  }

  const paths = new Set<string>()
  for (const [key, element] of Object.entries(elements)) {
    if (!isRecord(element) || !isSecretInput(element)) continue
    const value = isRecord(element.props) ? element.props.value : undefined
    if (!isRecord(value)) continue
    if (typeof value.$bindState === "string" && value.$bindState) {
      const path = value.$bindState.startsWith("/") ? value.$bindState : `/${value.$bindState}`
      if (!path.startsWith(`/${UI_SECRET_ROOT}/`)) paths.add(path)
    } else if (typeof value.$bindItem === "string") {
      const field = value.$bindItem ? `/${value.$bindItem}` : ""
      const found = itemBases(key)
      // (Outside any repeat json-render writes nothing for it.)
      if (found.length === 0 && !field) continue
      for (const base of found.length > 0 ? found : ["/**"]) paths.add(`${base}${field}`)
    }
  }
  const result = paths.size === 0 ? NO_SECRETS : Object.freeze([...paths].sort())
  secretCache.set(spec, result)
  return result
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Turns a model-written spec into one the renderer can take safely. Pure: it never throws and never mutates its input;
 * what it changes is copied and the rest is shared, and a spec that needs no change comes back as the same object.
 *
 * 1. json-render's autoFixSpec moves `visible`/`on`/`repeat`/`watch` out of `props` (lossless fixes only: dangling
 *    children stay, so the validator can report them).
 * 2. Every element gets an object `props` and a string-array `children`; elements that are not objects or have no
 *    string `type` are removed, with the references to them. What is removed or ignored this way (elements, children,
 *    an invalid `repeat`, bindings and onSuccess/onError handlers that are not bindings, a built-in's `confirm`) is
 *    recorded for the validator (see normalizeNotes).
 * 3. `pattern` and `email` validation checks become genui's safe checks (src/protocol/pattern.ts); checks written as
 *    expressions are replaced by one that always passes (see sanitizeChecks).
 * 4. Custom actions' `confirm`, `onSuccess` and `onError` move into reserved params, `{ "$item": ... }` params resolve
 *    to the item's value, and bindings that run without an activation (watch, on.focus, on.blur, ...) are tagged so
 *    their outward actions are refused (see rewriteBinding).
 * 5. Input props (BOUND_PROPS) that hold a literal, or nothing, are bound to `/__genui/<key>` (a password Input's to
 *    `/__genui_secret/<key>`, which is never persisted) and seeded from the literal, unless the element renders inside
 *    a `repeat`.
 */
export function normalizeSpec(spec: Spec): Spec {
  if (!isRecord(spec)) return { root: "", elements: {} }
  const source = spec as unknown as Record<string, unknown>
  const root = typeof source.root === "string" ? source.root : ""
  const rawElements = isRecord(source.elements) ? source.elements : {}
  const rawState = isRecord(source.state) ? source.state : undefined

  let changed = root !== source.root || rawElements !== source.elements || rawState !== source.state
  const notes: NormalizeNote[] = []
  const elements: Record<string, UIElement> = {}
  const removed = new Set<string>()
  for (const [key, raw] of Object.entries(rawElements)) {
    const element = key === "__proto__" ? undefined : normalizeElement(raw)
    if (!element) {
      notes.push(
        key === "__proto__"
          ? { severity: "error", code: "invalid_element", message: 'the key "__proto__" cannot name an element' }
          : isRecord(raw)
            ? { severity: "error", code: "missing_type", message: "has no component type", elementKey: key }
            : { severity: "error", code: "invalid_element", message: "is not an element object", elementKey: key },
      )
      removed.add(key)
      changed = true
      continue
    }
    if ((element as unknown) !== raw) changed = true
    elements[key] = element
    for (const note of notesByElement.get(element) ?? []) notes.push({ ...note, elementKey: key })
  }

  // References to removed elements go (their own note says why), and so do references that would resolve to an
  // inherited property ("toString") instead of an element.
  const dangling = (child: string) => removed.has(child) || (!Object.hasOwn(elements, child) && child in elements)
  for (const [key, element] of Object.entries(elements)) {
    const children = element.children ?? []
    if (!children.some(dangling)) continue
    for (const child of children)
      if (!removed.has(child) && dangling(child))
        notes.push({
          severity: "error",
          code: "missing_child",
          message: `child "${child.length > 60 ? `${child.slice(0, 57)}...` : child}" is not defined`,
          elementKey: key,
        })
    elements[key] = { ...element, children: children.filter((child) => !dangling(child)) }
    changed = true
  }

  const inRepeat = repeatedKeys(root, elements)
  const seeds: [string, string, unknown][] = []
  for (const [key, element] of Object.entries(elements)) {
    if (inRepeat.has(key)) continue
    const bound = bindInput(key, element)
    if (!bound) continue
    elements[key] = bound.element
    changed = true
    if (bound.seed !== undefined) seeds.push([bound.root, key, bound.seed])
  }

  const state = seedState(rawState, seeds)
  if (state !== source.state) changed = true
  // (A spec that needed no change has nothing to note: a normalized spec passed again keeps its notes.)
  if (!changed) return spec

  const { state: _state, ...rest } = source
  const result = { ...rest, root, elements, ...(state ? { state } : {}) } as Spec
  if (notes.length > 0) notesBySpec.set(result, Object.freeze(notes))
  return result
}
