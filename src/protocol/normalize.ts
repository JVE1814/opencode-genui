import { autoFixSpec, type Spec, type UIElement } from "@json-render/core"
import { CONFIRM_PARAM } from "../catalog/actions.ts"

/** The state subtree where auto-bound input values live: `/__genui/<element key>`. */
export const UI_STATE_ROOT = "__genui"

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

function sanitizeChildren(element: UIElement): UIElement {
  const children: unknown = element.children
  if (!Array.isArray(children)) return { ...element, children: [] }
  if (children.every((child) => typeof child === "string")) return element
  return { ...element, children: children.filter((child): child is string => typeof child === "string") }
}

// json-render iterates slots and reads `repeat.statePath`; shapes it does not expect would throw in the validator.
function sanitizeStructure(element: UIElement): UIElement {
  let next = element
  const repeat: unknown = next.repeat
  if (repeat !== undefined) {
    const statePath = isRecord(repeat) ? repeat.statePath : undefined
    const valid = typeof statePath === "string" || (isRecord(statePath) && typeof statePath.$item === "string")
    if (!valid) {
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

// Moves `confirm` into the reserved param, so the GUI's handler asks with the app's dialog and json-render's own
// (unstyled) ConfirmDialog never opens. Built-ins ignore `confirm` anyway, so there it is only dropped.
function rewriteBinding(binding: Record<string, unknown>): Record<string, unknown> {
  if (!("confirm" in binding)) return binding
  const { confirm, ...rest } = binding
  if (confirm === undefined || confirm === null) return rest
  if (typeof rest.action === "string" && BUILTIN_ACTIONS.has(rest.action)) return rest
  const params = isRecord(rest.params) ? rest.params : {}
  return { ...rest, params: { ...params, [CONFIRM_PARAM]: confirm } }
}

// Rewrites each binding of an `on` or `watch` map. Bindings that are not objects are dropped: the renderer reads
// fields of every binding when an event fires and would throw on them.
function rewriteBindings(element: UIElement, field: "on" | "watch"): UIElement {
  const map: unknown = element[field]
  if (map === undefined) return element
  if (!isRecord(map)) {
    const { [field]: _dropped, ...rest } = element
    return rest as UIElement
  }
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(map)) {
    if (FORBIDDEN_KEYS.has(name)) {
      changed = true
      continue
    }
    if (Array.isArray(value)) {
      const bindings = value.filter(isRecord)
      const rewritten = bindings.map(rewriteBinding)
      if (bindings.length !== value.length || rewritten.some((binding, index) => binding !== bindings[index])) {
        changed = true
        if (rewritten.length > 0) next[name] = rewritten
      } else next[name] = value
    } else if (isRecord(value)) {
      const rewritten = rewriteBinding(value)
      if (rewritten !== value) changed = true
      next[name] = rewritten
    } else changed = true
  }
  return changed ? ({ ...element, [field]: next } as UIElement) : element
}

/** The element-local normalization of one element, or undefined when it cannot be an element at all. */
function normalizeElement(raw: unknown): UIElement | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined
  const cached = localCache.get(raw)
  if (cached) return cached

  let element = raw as unknown as UIElement
  if (!isRecord(element.props)) element = { ...element, props: {} }
  element = relocate(element)
  element = sanitizeChildren(element)
  element = sanitizeStructure(element)
  element = rewriteBindings(element, "on")
  element = rewriteBindings(element, "watch")

  localCache.set(raw, element)
  // Normalizing a normalized element is a no-op; remember that so a second pass keeps identity too.
  if ((element as unknown) !== raw) localCache.set(element, element)
  return element
}

// ---------------------------------------------------------------------------------------------------------------------
// Auto-binding of input state.
// ---------------------------------------------------------------------------------------------------------------------

const bindCache = new WeakMap<UIElement, Map<string, { element: UIElement; seed: unknown }>>()

/** The element with its input prop bound to `/__genui/<key>`, and the value to seed there (undefined for none). */
function bindInput(key: string, element: UIElement): { element: UIElement; seed: unknown } | undefined {
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
  const result = {
    element: { ...element, props: { ...props, [prop]: { $bindState: uiStatePath(key) } } },
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

function seedState(
  state: Record<string, unknown> | undefined,
  seeds: readonly (readonly [string, unknown])[],
): Record<string, unknown> | undefined {
  const existing = state && isRecord(state[UI_STATE_ROOT]) ? (state[UI_STATE_ROOT] as Record<string, unknown>) : {}
  const added = seeds.filter(([key]) => !Object.hasOwn(existing, key))
  if (added.length === 0) return state

  const ui: Record<string, unknown> = { ...existing }
  for (const [key, value] of added) ui[key] = value
  const previous = state ? stateCache.get(state) : stateFromNothing
  const previousUi = previous?.[UI_STATE_ROOT]
  if (
    isRecord(previousUi) &&
    Object.keys(previousUi).length === Object.keys(ui).length &&
    Object.entries(ui).every(([key, value]) => Object.hasOwn(previousUi, key) && Object.is(previousUi[key], value))
  )
    return previous

  const next = { ...state, [UI_STATE_ROOT]: ui }
  if (state) stateCache.set(state, next)
  else stateFromNothing = next
  return next
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Turns a model-written spec into one the renderer can take safely. Pure: it never throws and never mutates its input;
 * what it changes is copied and the rest is shared, and a spec that needs no change comes back as the same object.
 *
 * 1. json-render's autoFixSpec moves `visible`/`on`/`repeat`/`watch` out of `props` (lossless fixes only: dangling
 *    children stay, so the validator can report them).
 * 2. Every element gets an object `props` and a string-array `children`; elements that are not objects or have no
 *    string `type` are removed, with the references to them.
 * 3. An action binding's `confirm` moves into `params[CONFIRM_PARAM]`, so the app's dialog asks instead of
 *    json-render's.
 * 4. Input props (BOUND_PROPS) that hold a literal, or nothing, are bound to `/__genui/<key>` and seeded from the
 *    literal, unless the element renders inside a `repeat`.
 */
export function normalizeSpec(spec: Spec): Spec {
  if (!isRecord(spec)) return { root: "", elements: {} }
  const source = spec as unknown as Record<string, unknown>
  const root = typeof source.root === "string" ? source.root : ""
  const rawElements = isRecord(source.elements) ? source.elements : {}
  const rawState = isRecord(source.state) ? source.state : undefined

  let changed = root !== source.root || rawElements !== source.elements || rawState !== source.state
  const elements: Record<string, UIElement> = {}
  const removed = new Set<string>()
  for (const [key, raw] of Object.entries(rawElements)) {
    const element = key === "__proto__" ? undefined : normalizeElement(raw)
    if (!element) {
      removed.add(key)
      changed = true
      continue
    }
    if ((element as unknown) !== raw) changed = true
    elements[key] = element
  }

  // References to removed elements go, and so do references that would resolve to an inherited property
  // ("toString") instead of an element.
  const dangling = (child: string) => removed.has(child) || (!Object.hasOwn(elements, child) && child in elements)
  for (const [key, element] of Object.entries(elements)) {
    const children = element.children ?? []
    if (!children.some(dangling)) continue
    elements[key] = { ...element, children: children.filter((child) => !dangling(child)) }
    changed = true
  }

  const inRepeat = repeatedKeys(root, elements)
  const seeds: [string, unknown][] = []
  for (const [key, element] of Object.entries(elements)) {
    if (inRepeat.has(key)) continue
    const bound = bindInput(key, element)
    if (!bound) continue
    elements[key] = bound.element
    changed = true
    if (bound.seed !== undefined) seeds.push([key, bound.seed])
  }

  const state = seedState(rawState, seeds)
  if (state !== source.state) changed = true
  if (!changed) return spec

  const { state: _state, ...rest } = source
  return { ...rest, root, elements, ...(state ? { state } : {}) } as Spec
}
