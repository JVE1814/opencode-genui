import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type Accessor,
  type Setter,
} from "solid-js"
import type { ValidationConfig } from "@json-render/core"
import {
  useRepeatScope,
  useStateStore,
  useValidation,
  type BaseComponentProps,
  type ComponentFn,
} from "@json-render/solid"
import type { GenuiCatalog } from "../../catalog/index.ts"
import type { ComponentName } from "../../catalog/components.ts"
import { elementKeyOf } from "../element.ts"

/**
 * Conventions for every genui component (src/gui/components/*.tsx):
 *
 * - Signature: `const X: GenuiComponent<"X"> = (ctx) => ...`. Read `ctx.props.*` inside JSX or memos, never destructure
 *   `ctx` or `ctx.props` (they are getters and update as the agent streams or state changes).
 * - `ctx.children` is the exception: it is the same rendered list for the element's lifetime (src/gui/element.ts reads
 *   json-render's children getter once, untracked, because each read of that getter re-creates every child), so read
 *   it anywhere. Never render it in two places at once; slotted components split it with `children()`.
 * - The element renderer remounts a component when the element's `type` changes, so a component never needs to
 *   handle another type's props.
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

/** The surface's per-element UI memory (`SurfaceRuntime.memory`), provided by the surface. */
export const SurfaceMemoryContext = createContext<Map<string, unknown>>()

/**
 * UI state a component keeps itself (not in the spec's state), remembered per element by the surface, so it survives a
 * remount: a timeline row that scrolled off screen, a canvas tab switched away and back. `name` tells a component's
 * values apart; inside a repeat each row has its own. Undefined until the component sets it.
 */
export function useRemembered<T>(
  ctx: BaseComponentProps<Record<string, unknown>>,
  name: string,
): [Accessor<T | undefined>, (value: T) => void] {
  const memory = useContext(SurfaceMemoryContext)
  const scope = useRepeatScope()
  const element = elementKeyOf(ctx)
  const key = () => `${element ?? ""}\u0000${scope?.basePath ?? ""}\u0000${name}`
  const [value, setValue] = createSignal<T | undefined>(
    element !== undefined ? (memory?.get(key()) as T | undefined) : undefined,
  )
  return [
    value,
    (next: T) => {
      setValue(() => next)
      if (element !== undefined) memory?.set(key(), next)
    },
  ]
}

type Validation = ReturnType<typeof useValidation>
type FieldState = Validation["fieldStates"][string] | undefined

/**
 * How many fields' results one frame shows (see ErrorView): the browser restyles what changed at the next frame, about
 * 60 µs per element under the app's stylesheets, so a hundred fields cost it a few tens of milliseconds.
 */
const ERRORS_PER_FRAME = 100

// The next frame, or a later task where there are no frames.
const nextFrame = (run: () => void) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => run()) : setTimeout(run, 0)

/**
 * What each field of one form (one ValidationProvider) shows, from json-render's validation results, path by path.
 * json-render keeps every field's result in one signal, so every field's error re-read it on every validation: one
 * `validateForm` over 2,000 fields updated all of them in one task of a second, most of it restyling the 6,000
 * elements that changed. Here one effect per form follows that signal and hands each field only its own result,
 * through a signal of its own; when many results change at once, ERRORS_PER_FRAME of them show per frame (in field
 * order), so the window answers in between. A form's view lives while one of its fields does.
 */
interface ErrorView {
  readonly state: (path: string) => FieldState
  readonly release: () => void
}

const errorViews = new WeakMap<Validation, ErrorView & { users: number }>()

function errorView(validation: Validation): ErrorView {
  let view = errorViews.get(validation)
  if (!view) {
    const signals = new Map<string, [Accessor<FieldState>, Setter<FieldState>]>()
    // What each path shows now, and what waits to be shown.
    const shown = new Map<string, FieldState>()
    const waiting = new Map<string, FieldState>()
    let scheduled = false
    const show = () => {
      scheduled = false
      let count = 0
      for (const [path, state] of waiting) {
        waiting.delete(path)
        shown.set(path, state)
        signals.get(path)?.[1](() => state)
        if (++count >= ERRORS_PER_FRAME && waiting.size > 0) {
          scheduled = true
          nextFrame(show)
          return
        }
      }
    }
    let dispose: () => void = () => {}
    createRoot((done) => {
      dispose = done
      createEffect(() => {
        const states = validation.fieldStates
        untrack(() => {
          for (const path of new Set([...Object.keys(states), ...shown.keys(), ...waiting.keys()])) {
            const state = states[path]
            if ((waiting.has(path) ? waiting.get(path) : shown.get(path)) !== state) waiting.set(path, state)
          }
          if (!scheduled && waiting.size > 0) show()
        })
      })
    })
    const created: ErrorView & { users: number } = {
      users: 0,
      state: (path) => {
        let signal = signals.get(path)
        if (!signal) {
          signal = createSignal<FieldState>(shown.get(path), { equals: false })
          signals.set(path, signal)
        }
        return signal[0]()
      },
      release: () => {
        if (--created.users > 0) return
        errorViews.delete(validation)
        dispose()
      },
    }
    errorViews.set(validation, created)
    view = created
  }
  view.users++
  return view
}

/**
 * Validation for a bound form field: the `checks` prop, run on `validateOn` (blur by default). Returns the first error
 * message, and `validate` to call from the component's change/blur handlers.
 *
 * Reactive on purpose: in a streaming canvas a field can mount before its `checks` (or its binding) arrive, so the field
 * is (re)registered with the current config whenever it changes, and `validate` always uses the current config. Its
 * error follows its own result only (see ErrorView).
 */
export function useChecks(ctx: BaseComponentProps<Record<string, unknown>>, prop: string) {
  const validation = useValidation()
  const view = errorView(validation)
  onCleanup(view.release)
  const path = () => ctx.bindings?.[prop] ?? ""
  const checks = () => list<{ type: string; message: string; args?: Record<string, unknown> }>(ctx.props.checks)
  const validateOn = () => oneOf(ctx.props.validateOn, ["change", "blur", "submit"] as const, "blur")
  const enabled = () => !!path() && checks().length > 0
  const config = (): ValidationConfig => ({ checks: checks(), validateOn: validateOn() })

  // Registered fields are what the built-in `validateForm` action checks.
  createEffect(() => {
    if (enabled()) validation.registerField(path(), config())
  })

  return {
    error: (): string | undefined => {
      if (!enabled()) return undefined
      return view.state(path())?.result?.errors[0]
    },
    validate: (on: "change" | "blur") => {
      if (enabled() && validateOn() === on) validation.validate(path(), config())
    },
  }
}

/**
 * Marks a sideways-scrolling element with `data-overflow-start` / `data-overflow-end` while content is hidden past
 * that edge, so its CSS can fade the edge (the app hides scrollbars, so nothing else shows there is more). Follows
 * scrolling, resizes and content changes (rows or tabs streaming in). Use as a `ref`.
 */
export function trackOverflow(element: HTMLElement): void {
  let frame = 0
  const measure = () => {
    frame = 0
    const max = element.scrollWidth - element.clientWidth
    // scrollLeft runs from 0 to -max in right-to-left layouts.
    const position = Math.abs(element.scrollLeft)
    element.toggleAttribute("data-overflow-start", max > 1 && position > 1)
    element.toggleAttribute("data-overflow-end", max > 1 && position < max - 1)
  }
  const schedule = () => {
    if (frame) return
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(measure)
    else measure()
  }
  element.addEventListener("scroll", schedule, { passive: true })
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : undefined
  resize?.observe(element)
  const mutation = typeof MutationObserver === "function" ? new MutationObserver(schedule) : undefined
  mutation?.observe(element, { childList: true, subtree: true, characterData: true })
  schedule()
  onCleanup(() => {
    element.removeEventListener("scroll", schedule)
    resize?.disconnect()
    mutation?.disconnect()
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
  })
}

/**
 * Keeps the end gutter of a surface shown in place of the app's code block as wide as that block's toolbar (Copy, and
 * any other plugin's CodeBlockAction buttons, over the top end corner), so the toolbar never covers the UI. Sets
 * `--_toolbar` on the element; the CSS falls back to room for one button when the toolbar cannot be found. The
 * toolbar is the app's markup, not a contract: without it nothing changes. Use as a `ref`.
 */
export function reserveToolbar(element: HTMLElement): void {
  let toolbar: Element | undefined
  let widest = 0
  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          // The toolbar shows on hover; never shrink, so hovering does not move the UI. Its width comes from the
          // observer's entry: reading the layout here, after the previous surface's write, forced a layout per surface
          // (900 small blocks in one tool output: a second of frozen window).
          const entry = entries.at(-1)
          const width = Math.ceil(entry?.borderBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width ?? 0)
          if (width <= widest) return
          widest = width
          element.style.setProperty("--_toolbar", `${width + 8}px`)
        })
      : undefined
  const find = () => {
    if (toolbar) return true
    const block = element.closest('[data-component="markdown-code"]')
    toolbar = block?.querySelector(':scope > [data-slot="markdown-code-toolbar"]') ?? undefined
    if (toolbar) resize?.observe(toolbar)
    return !!toolbar
  }
  // The block's toolbar may be added after its content mounts.
  let frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => void find()) : 0
  if (find() && frame && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(frame)
    frame = 0
  }
  onCleanup(() => {
    resize?.disconnect()
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
  })
}

/** A stable id for labels and aria attributes within one surface. */
let counter = 0
export const uid = (prefix: string) => `gu-${prefix}-${(++counter).toString(36)}`
