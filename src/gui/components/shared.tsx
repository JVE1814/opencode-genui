import { createSignal, type Accessor } from "solid-js"
import { useFieldValidation, useStateStore, type BaseComponentProps, type ComponentFn } from "@json-render/solid"
import type { GenuiCatalog } from "../../catalog/index.ts"
import type { ComponentName } from "../../catalog/components.ts"

/**
 * Conventions for every genui component (src/gui/components/*.tsx):
 *
 * - Signature: `const X: GenuiComponent<"X"> = (ctx) => ...`. Read `ctx.props.*` inside JSX or memos, never destructure
 *   `ctx` or `ctx.props` (they are getters and update as the agent streams or state changes).
 * - Props are model-written and may be missing or the wrong type even when the schema says otherwise: guard with the
 *   helpers below (`str`, `num`, `list`, `bool`) and render something sensible.
 * - The root element carries `data-gu="<kebab-name>"`; parts carry `data-slot="..."`; variants are data attributes.
 *   Styles live in src/gui/styles/<group>.css and use only --gu-* aliases from base.css.
 * - Use the app's components from `useHost().ui` where one exists and supports what the component needs; otherwise
 *   render native elements styled to match @opencode/ui (see node_modules/@opencode/ui/src for measurements).
 * - Copy that the component itself adds (aria labels, "Show more") comes from `useHost().t(key)`; model-written text is
 *   shown as is. Never render model text as HTML.
 * - Two-way props (`value`, `checked`, ...) go through `useBound`; events fire with `ctx.emit(name)` after the write.
 */
export type GenuiComponent<K extends ComponentName> = ComponentFn<GenuiCatalog, K>

export const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : fallback

export const num = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback
}

export const bool = (value: unknown, fallback = false): boolean => (typeof value === "boolean" ? value : fallback)

export const list = <T = unknown,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

export const oneOf = <const T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback

/** Text for any cell-like value: strings and numbers as is, booleans as ✓/–, objects as compact JSON. */
export function display(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : ""
  if (typeof value === "boolean") return value ? "✓" : "–"
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

/**
 * A two-way prop. When the spec binds it (`{ "$bindState": "/path" }`, `{ "$bindItem": "field" }`) reads come from the
 * resolved prop and writes go to the state store, so the value persists and other elements see it. Unbound props fall
 * back to local state seeded from the prop. (The normalizer binds most input props automatically, see
 * src/protocol/normalize.ts, so local state is rare.)
 */
export function useBound<T>(
  ctx: BaseComponentProps<Record<string, unknown>>,
  prop: string,
  fallback: T,
  coerce: (value: unknown) => T | undefined = (value) => value as T | undefined,
): [Accessor<T>, (value: T) => void] {
  const store = useStateStore()
  const [local, setLocal] = createSignal<{ value: T } | undefined>()
  const path = () => ctx.bindings?.[prop]

  const value = () => {
    if (!path()) {
      const own = local()
      if (own) return own.value
    }
    return coerce(ctx.props[prop]) ?? fallback
  }

  const set = (next: T) => {
    const target = path()
    if (target) store.set(target, next)
    else setLocal({ value: next })
  }

  return [value, set]
}

/**
 * Validation for a bound form field: the `checks` prop, run on `validateOn` (blur by default). Returns the first error
 * message, and `validate` to call from the component's change/blur handlers.
 */
export function useChecks(ctx: BaseComponentProps<Record<string, unknown>>, prop: string) {
  const path = ctx.bindings?.[prop] ?? ""
  const checks = () => list<{ type: string; message: string; args?: Record<string, unknown> }>(ctx.props.checks)
  const validateOn = () => oneOf(ctx.props.validateOn, ["change", "blur", "submit"] as const, "blur")
  const enabled = () => !!path && checks().length > 0
  const field = useFieldValidation(path, enabled() ? { checks: checks(), validateOn: validateOn() } : undefined)

  return {
    error: (): string | undefined => (enabled() ? field.errors()[0] : undefined),
    validate: (on: "change" | "blur") => {
      if (enabled() && validateOn() === on) field.validate()
    },
  }
}

/** A stable id for labels and aria attributes within one surface. */
let counter = 0
export const uid = (prefix: string) => `gu-${prefix}-${(++counter).toString(36)}`
