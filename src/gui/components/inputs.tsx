import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { normalizeOptions, type Option } from "../../catalog/components.ts"
import { useHost } from "../host.ts"
import { bool, list, num, oneOf, str, uid, useBound, useChecks, type GenuiComponent } from "./shared.tsx"

// Form fields: Input, Textarea, Select, Checkbox, Radio, Switch, Slider. Buttons and choice controls are in
// choices.tsx. Styles: src/gui/styles/inputs.css.

const INPUT_TYPES = ["text", "email", "password", "number", "search", "url"] as const

// ---------------------------------------------------------------------------------------------------------------------
// Helpers shared with choices.tsx
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Fires a component event and resolves once its actions have run. The renderer's `emit` is async although it is typed
 * void; a failing action is logged here so it never becomes an unhandled rejection.
 */
export function fire(ctx: { emit: (event: string) => void }, event: string): Promise<void> {
  try {
    const result: unknown = ctx.emit(event)
    return Promise.resolve(result).then(
      () => undefined,
      (error: unknown) => console.error(`genui: "${event}" actions failed`, error),
    )
  } catch (error) {
    console.error(`genui: "${event}" actions failed`, error)
    return Promise.resolve()
  }
}

/**
 * A derived list that keeps its identity, and the identity of unchanged entries, while the content is the same. The
 * renderer resolves props into fresh arrays on every state change, so without this `<For>` would rebuild every row
 * (and drop focus) on each keystroke anywhere in the surface.
 */
export function stableList<T>(compute: () => T[], same: (a: T, b: T) => boolean): Accessor<T[]> {
  let previous: T[] = []
  return createMemo(() => {
    const next = compute().map((item, index) => {
      const old = previous[index]
      return old !== undefined && same(old, item) ? old : item
    })
    if (next.length === previous.length && next.every((item, index) => item === previous[index])) return previous
    previous = next
    return next
  })
}

const sameOption = (a: { label: string; value: string }, b: { label: string; value: string }) =>
  a.label === b.label && a.value === b.value

/** Options from a model-written `options` prop: normalized, without duplicate values. */
function useOptions(read: () => unknown): Accessor<{ label: string; value: string }[]> {
  return stableList(() => {
    const seen = new Set<string>()
    const raw = list<unknown>(read()).map((item): unknown => {
      if (typeof item === "number") return asOptionValue(item)
      if (!item || typeof item !== "object") return item
      const record = item as { value?: unknown }
      return typeof record.value === "number" ? { ...record, value: asOptionValue(record.value) } : item
    })
    return normalizeOptions(raw as Option[]).filter((option) => !seen.has(option.value) && !!seen.add(option.value))
  }, sameOption)
}

const asText = (value: unknown): string | number | undefined =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
/** An option value: models sometimes write numbers where the catalog asks for strings. */
const asOptionValue = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : asString(value)
const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)
const asNumber = (value: unknown): number | undefined => {
  const parsed = num(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : undefined
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Space-separated ids for aria-describedby, or undefined when there are none. */
const ids = (...values: (string | false | undefined)[]) => values.filter(Boolean).join(" ") || undefined

/** Whether the field's checks include `required`, for aria-required. */
const isRequired = (checks: unknown) =>
  list<unknown>(checks).some(
    (check) => !!check && typeof check === "object" && (check as { type?: unknown }).type === "required",
  )

/**
 * The field's description and its error. The error element always exists, so its live region announces a new error;
 * while empty, CSS takes it out of the field's flex flow so it adds no gap.
 */
function FieldMessages(props: { id: string; description?: string; error?: string }): JSX.Element {
  return (
    <>
      <Show when={props.description}>
        <div data-gu-description id={`${props.id}-description`}>
          {props.description}
        </div>
      </Show>
      <div data-gu-error id={`${props.id}-error`} aria-live="polite">
        {props.error}
      </div>
    </>
  )
}

/** aria-describedby for a field rendered with FieldMessages. */
const describedBy = (id: string, description: string, error: string | undefined) =>
  ids(!!description && `${id}-description`, !!error && `${id}-error`)

/**
 * Validation after an edit: for `validateOn: "change"`, and for any field that already shows an error, so the error
 * goes away as soon as the value is fixed instead of on the next blur.
 */
function validateEdit(checks: ReturnType<typeof useChecks>) {
  checks.validate("change")
  if (checks.error()) checks.validate("blur")
}

// ---------------------------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------------------------

// A native input styled as the app's text input (forms/text-input): ui.TextInput has no focus or blur events and no
// email or number types, which the catalog's Input needs.
const Input: GenuiComponent<"Input"> = (ctx) => {
  const id = uid("input")
  const [value, setValue] = useBound<string | number>(ctx, "value", "", asText)
  const checks = useChecks(ctx, "value")
  const type = () => oneOf(ctx.props.type, INPUT_TYPES, "text")
  const label = () => str(ctx.props.label)
  const description = () => str(ctx.props.description)
  const disabled = () => bool(ctx.props.disabled)
  let input: HTMLInputElement | undefined

  // Written to the element directly instead of through a `value` attribute: a number field keeps what the user types
  // while it means the stored number ("1.", "1.50"), so the caret does not jump.
  createEffect(() => {
    const next = str(value())
    if (!input || input.value === next) return
    const typing = type() === "number" && input.value.trim() !== "" && Number(input.value) === Number(next)
    if (typing && document.activeElement === input) return
    input.value = next
  })

  const onInput = (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const element = event.currentTarget
    if (type() === "number") {
      // Mid-edit text such as "-" reads as "" with badInput: keep the stored value until it parses.
      if (element.validity.badInput) return
      const raw = element.value
      setValue(raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw)
    } else setValue(element.value)
    validateEdit(checks)
  }

  return (
    <div data-gu="input" data-gu-field>
      <Show when={label()}>
        <label data-gu-label for={id}>
          {label()}
        </label>
      </Show>
      <div
        data-slot="control"
        data-invalid={checks.error() ? "" : undefined}
        data-disabled={disabled() ? "" : undefined}
      >
        <input
          ref={input}
          id={id}
          data-slot="input"
          type={type()}
          name={str(ctx.props.name) || undefined}
          placeholder={str(ctx.props.placeholder) || undefined}
          inputmode={type() === "number" ? "decimal" : undefined}
          disabled={disabled()}
          aria-invalid={checks.error() ? true : undefined}
          aria-required={isRequired(ctx.props.checks) || undefined}
          aria-describedby={describedBy(id, description(), checks.error())}
          onInput={onInput}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.isComposing) return
            event.preventDefault()
            void fire(ctx, "submit")
          }}
          onFocus={() => void fire(ctx, "focus")}
          onBlur={() => {
            checks.validate("blur")
            void fire(ctx, "blur")
          }}
        />
      </div>
      <FieldMessages id={id} description={description()} error={checks.error()} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------------------------------------------------

// Native, styled as the app's textarea (forms/textarea); the host has no textarea component.
const Textarea: GenuiComponent<"Textarea"> = (ctx) => {
  const id = uid("textarea")
  const [value, setValue] = useBound<string>(ctx, "value", "", (raw) =>
    typeof raw === "number" ? String(raw) : asString(raw),
  )
  const checks = useChecks(ctx, "value")
  const label = () => str(ctx.props.label)
  const description = () => str(ctx.props.description)
  const disabled = () => bool(ctx.props.disabled)
  // 4 rows is about the app's 80px minimum height at its 13px / 1.35 text.
  const rows = () => clamp(Math.round(num(ctx.props.rows, 4)), 2, 20)

  return (
    <div data-gu="textarea" data-gu-field>
      <Show when={label()}>
        <label data-gu-label for={id}>
          {label()}
        </label>
      </Show>
      <div
        data-slot="control"
        data-invalid={checks.error() ? "" : undefined}
        data-disabled={disabled() ? "" : undefined}
      >
        <textarea
          id={id}
          data-slot="input"
          rows={rows()}
          name={str(ctx.props.name) || undefined}
          placeholder={str(ctx.props.placeholder) || undefined}
          disabled={disabled()}
          value={value()}
          aria-invalid={checks.error() ? true : undefined}
          aria-required={isRequired(ctx.props.checks) || undefined}
          aria-describedby={describedBy(id, description(), checks.error())}
          onInput={(event) => {
            setValue(event.currentTarget.value)
            validateEdit(checks)
          }}
          onBlur={() => checks.validate("blur")}
        />
      </div>
      <FieldMessages id={id} description={description()} error={checks.error()} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Passed to ui.Select's `class` (the SDK's prop "for layout"). ui.Select draws the compact trigger of the app's
 * settings rows; inputs.css gives this class the framed, full-width look the app's own form dialogs use for selects
 * (select-v2 "base"), so the field lines up with Input and Textarea.
 */
const SELECT_TRIGGER_CLASS = "genui-select-trigger"

const Select: GenuiComponent<"Select"> = (ctx) => {
  const host = useHost()
  const ui = host.ui
  const id = uid("select")
  const options = useOptions(() => ctx.props.options)
  const [value, setValue] = useBound<string>(ctx, "value", "", asOptionValue)
  const checks = useChecks(ctx, "value")
  const label = () => str(ctx.props.label)

  return (
    <div data-gu="select" data-gu-field>
      {/* ui.Select's label is only its accessible name, so the visible label is ours. */}
      <Show when={label()}>
        <span data-gu-label id={`${id}-label`}>
          {label()}
        </span>
      </Show>
      <div data-slot="control">
        <ui.Select
          options={options()}
          value={value() || undefined}
          label={label() || host.t("c.select.label")}
          placeholder={str(ctx.props.placeholder) || host.t("c.select.placeholder")}
          disabled={bool(ctx.props.disabled) || options().length === 0}
          invalid={!!checks.error()}
          placement="bottom-start"
          class={SELECT_TRIGGER_CLASS}
          onChange={(next) => {
            setValue(next)
            // The select has no blur of its own (its list takes focus), so "blur" validation runs on change too.
            checks.validate("change")
            checks.validate("blur")
            void fire(ctx, "change")
          }}
        />
      </div>
      <FieldMessages id={id} error={checks.error()} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------------------------------------------------

// The app's checkmark (forms/checkbox, compact appearance).
const CheckIcon = () => (
  <svg data-slot="check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25" stroke="currentColor" stroke-width="1" />
  </svg>
)

// A native checkbox, visually hidden, behind the app's compact checkbox control. The host has no checkbox component.
const Checkbox: GenuiComponent<"Checkbox"> = (ctx) => {
  const id = uid("checkbox")
  const [checked, setChecked] = useBound<boolean>(ctx, "checked", false, asBoolean)
  const checks = useChecks(ctx, "checked")
  const label = () => str(ctx.props.label)
  const description = () => str(ctx.props.description)
  const disabled = () => bool(ctx.props.disabled)

  return (
    <div
      data-gu="checkbox"
      data-checked={checked() ? "" : undefined}
      data-disabled={disabled() ? "" : undefined}
      data-invalid={checks.error() ? "" : undefined}
    >
      <div data-slot="row">
        <input
          id={id}
          data-slot="input"
          type="checkbox"
          name={str(ctx.props.name) || undefined}
          checked={checked()}
          disabled={disabled()}
          aria-invalid={checks.error() ? true : undefined}
          aria-required={isRequired(ctx.props.checks) || undefined}
          aria-describedby={describedBy(id, description(), checks.error())}
          onChange={(event) => {
            setChecked(event.currentTarget.checked)
            validateEdit(checks)
            void fire(ctx, "change")
          }}
          onBlur={() => checks.validate("blur")}
        />
        <label data-slot="box" for={id}>
          <span data-slot="control">
            <CheckIcon />
          </span>
        </label>
        <div data-slot="text">
          <label data-slot="label" for={id}>
            {label()}
          </label>
          <Show when={description()}>
            <span data-slot="description" id={`${id}-description`}>
              {description()}
            </span>
          </Show>
        </div>
      </div>
      <FieldMessages id={id} error={checks.error()} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Radio
// ---------------------------------------------------------------------------------------------------------------------

// Native radios (arrow keys move the selection) behind the app's radio control (forms/radio). The group name is our
// own id: two surfaces may use the same `name`, and radios with one name in a document form a single group.
const Radio: GenuiComponent<"Radio"> = (ctx) => {
  const id = uid("radio")
  const options = useOptions(() => ctx.props.options)
  const [value, setValue] = useBound<string>(ctx, "value", "", asOptionValue)
  const checks = useChecks(ctx, "value")
  const label = () => str(ctx.props.label)
  const disabled = () => bool(ctx.props.disabled)

  return (
    <div
      data-gu="radio"
      data-gu-field
      data-orientation={oneOf(ctx.props.orientation, ["vertical", "horizontal"] as const, "vertical")}
      data-disabled={disabled() ? "" : undefined}
      data-invalid={checks.error() ? "" : undefined}
    >
      <Show when={label()}>
        <span data-gu-label id={`${id}-label`}>
          {label()}
        </span>
      </Show>
      <div
        data-slot="items"
        role="radiogroup"
        aria-labelledby={label() ? `${id}-label` : undefined}
        aria-describedby={describedBy(id, "", checks.error())}
        aria-invalid={checks.error() ? true : undefined}
        aria-required={isRequired(ctx.props.checks) || undefined}
        aria-disabled={disabled() || undefined}
        onFocusOut={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) checks.validate("blur")
        }}
      >
        <For each={options()}>
          {(option, index) => {
            const optionId = () => `${id}-${index()}`
            const selected = () => value() === option.value
            return (
              <div data-slot="item" data-checked={selected() ? "" : undefined}>
                <input
                  id={optionId()}
                  data-slot="input"
                  type="radio"
                  name={id}
                  value={option.value}
                  checked={selected()}
                  disabled={disabled()}
                  onChange={(event) => {
                    if (!event.currentTarget.checked) return
                    setValue(option.value)
                    validateEdit(checks)
                    void fire(ctx, "change")
                  }}
                />
                <label data-slot="box" for={optionId()}>
                  <span data-slot="control">
                    <span data-slot="indicator" />
                  </span>
                </label>
                <label data-slot="label" for={optionId()}>
                  {option.label}
                </label>
              </div>
            )
          }}
        </For>
      </div>
      <FieldMessages id={id} error={checks.error()} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------------------------------------------------

// The app's switch with its label hidden, beside our own label and description: the layout of the app's settings rows.
// ui.Switch's visible label is the compact 11px faint caption, which reads as a hint next to form labels, and its
// description is unstyled in that appearance.
const Switch: GenuiComponent<"Switch"> = (ctx) => {
  const host = useHost()
  const ui = host.ui
  const [checked, setChecked] = useBound<boolean>(ctx, "checked", false, asBoolean)
  const label = () => str(ctx.props.label)
  const description = () => str(ctx.props.description)
  const disabled = () => bool(ctx.props.disabled)

  const change = (next: boolean) => {
    if (disabled() || next === checked()) return
    setChecked(next)
    void fire(ctx, "change")
  }

  return (
    <div data-gu="switch" data-checked={checked() ? "" : undefined} data-disabled={disabled() ? "" : undefined}>
      {/* A pointer shortcut like a <label>'s; the switch itself has the label for assistive tech and the keyboard. */}
      <div data-slot="text" onClick={() => change(!checked())}>
        <span data-slot="label">{label()}</span>
        <Show when={description()}>
          <span data-slot="description">{description()}</span>
        </Show>
      </div>
      <div data-slot="control">
        <ui.Switch checked={checked()} onChange={change} label={label()} hideLabel disabled={disabled()} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------------------------------------------------

// The thumb's width in inputs.css; the filled track ends under the thumb's center.
const THUMB_PX = 14

/** Decimal places of a step (0.25 → 2), so values display as precisely as they can be set. */
function stepDecimals(step: number): number {
  const [mantissa = "", exponent] = String(step).split("e-")
  const fraction = mantissa.split(".")[1]?.length ?? 0
  return Math.min(6, fraction + (exponent ? Number(exponent) : 0))
}

/** "50" + "%" → "50%", "200" + "ms" → "200 ms". */
function withUnit(text: string, unit: string): string {
  if (!unit) return text
  return /^[%‰°′″]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`
}

// A native range, so keyboard, pointer and assistive tech work as everywhere; the visible track is drawn behind it.
const Slider: GenuiComponent<"Slider"> = (ctx) => {
  const id = uid("slider")
  const [stored, setValue] = useBound<number | undefined>(ctx, "value", undefined, asNumber)
  const min = () => num(ctx.props.min, 0)
  const max = () => {
    const high = num(ctx.props.max, 100)
    return high > min() ? high : min() + 1
  }
  const step = () => {
    const size = num(ctx.props.step, 1)
    return size > 0 ? size : 1
  }
  const value = () => clamp(stored() ?? min(), min(), max())
  const ratio = () => (value() - min()) / (max() - min())
  const label = () => str(ctx.props.label)
  const disabled = () => bool(ctx.props.disabled)
  const format = createMemo(() => {
    const digits = stepDecimals(step())
    return new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  })
  const text = () => withUnit(format().format(value()), str(ctx.props.unit).trim())

  return (
    <div data-gu="slider" data-disabled={disabled() ? "" : undefined}>
      <div data-slot="header">
        <Show when={label()}>
          <label data-gu-label for={id}>
            {label()}
          </label>
        </Show>
        {/* aria-valuetext announces the value; this copy would only repeat it. */}
        <span data-slot="value" aria-hidden="true">
          {text()}
        </span>
      </div>
      <div data-slot="track-area">
        <div data-slot="track" aria-hidden="true">
          <div
            data-slot="fill"
            style={{ width: `calc(${THUMB_PX / 2}px + ${ratio().toFixed(4)} * (100% - ${THUMB_PX}px))` }}
          />
        </div>
        {/* min, max and step come before value: the element clamps value to the bounds it has when value is set. */}
        <input
          id={id}
          data-slot="input"
          type="range"
          min={min()}
          max={max()}
          step={step()}
          value={value()}
          disabled={disabled()}
          aria-valuetext={text()}
          onInput={(event) => setValue(Number(event.currentTarget.value))}
          onChange={() => void fire(ctx, "change")}
        />
      </div>
    </div>
  )
}

export const inputComponents = {
  Input,
  Textarea,
  Select,
  Checkbox,
  Radio,
  Switch,
  Slider,
} satisfies { [K in "Input" | "Textarea" | "Select" | "Checkbox" | "Radio" | "Switch" | "Slider"]: GenuiComponent<K> }
