import { children, createMemo, createSignal, For, Index, Show, type JSX } from "solid-js"
import type { ComponentName } from "../../catalog/components.ts"
import { useHost } from "../host.ts"
import { MarkdownText } from "./content.tsx"
import { bool, list, num, oneOf, str, uid, useBound, type GenuiComponent } from "./shared.tsx"

// Layout components: Stack, Grid, Card, Separator, Tabs, Accordion, Collapsible. Styles: src/gui/styles/layout.css.

const GAPS = ["none", "xs", "sm", "md", "lg", "xl"] as const
const TONES = ["neutral", "info", "success", "warning", "danger"] as const

const TONE_ICONS = {
  info: "info",
  success: "circle-check",
  warning: "warning",
  danger: "circle-exclamation",
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The rendered children of a slotted component as a list, child N at index N. An element hidden by `visible` keeps
 * its index as `null`, so "child N belongs to item N" holds while elements come and go. Read `ctx.children` only
 * through this: each read of the getter renders the children anew.
 */
function useChildList(read: () => JSX.Element) {
  const resolved = children(read)
  return createMemo(() => resolved.toArray())
}

// ---------------------------------------------------------------------------------------------------------------------
// Stack, Grid
// ---------------------------------------------------------------------------------------------------------------------

const Stack: GenuiComponent<"Stack"> = (ctx) => {
  const direction = () => oneOf(ctx.props.direction, ["vertical", "horizontal"] as const, "vertical")
  const horizontal = () => direction() === "horizontal"
  return (
    <div
      data-gu="stack"
      data-direction={direction()}
      data-gap={oneOf(ctx.props.gap, GAPS, "md")}
      data-align={oneOf(
        ctx.props.align,
        ["start", "center", "end", "stretch", "baseline"] as const,
        horizontal() ? "center" : "stretch",
      )}
      data-justify={oneOf(ctx.props.justify, ["start", "center", "end", "between", "around"] as const, "start")}
      // Rows wrap unless the spec says otherwise, so a row of buttons still fits a 300px canvas.
      data-wrap={horizontal() && bool(ctx.props.wrap, true) ? "" : undefined}
    >
      {ctx.children}
    </div>
  )
}

const Grid: GenuiComponent<"Grid"> = (ctx) => (
  <div
    data-gu="grid"
    data-columns={String(Math.min(6, Math.max(1, Math.round(num(ctx.props.columns, 2)))))}
    data-gap={oneOf(ctx.props.gap, GAPS, "md")}
  >
    {ctx.children}
  </div>
)

// ---------------------------------------------------------------------------------------------------------------------
// Card, Separator
// ---------------------------------------------------------------------------------------------------------------------

const Card: GenuiComponent<"Card"> = (ctx) => {
  const { ui } = useHost()
  const id = uid("card")
  const title = () => str(ctx.props.title)
  const description = () => str(ctx.props.description)
  const tone = () => oneOf(ctx.props.tone, TONES, "neutral")
  const icon = () => {
    const current = tone()
    return current === "neutral" ? undefined : TONE_ICONS[current]
  }

  return (
    <div
      data-gu="card"
      data-tone={tone()}
      data-padding={oneOf(ctx.props.padding, ["none", "sm", "md"] as const, "md")}
      role={title() ? "group" : undefined}
      aria-labelledby={title() ? id : undefined}
    >
      <Show when={title() || description()}>
        <div data-slot="header">
          <Show when={title()}>
            <div data-slot="title" id={id}>
              <Show when={icon()}>
                {(name) => (
                  <span data-slot="icon" aria-hidden="true">
                    <ui.Icon name={name()} size="small" />
                  </span>
                )}
              </Show>
              <span data-slot="text">{title()}</span>
            </div>
          </Show>
          <Show when={description()}>
            <p data-slot="description">{description()}</p>
          </Show>
        </div>
      </Show>
      <div data-slot="body">{ctx.children}</div>
    </div>
  )
}

const Separator: GenuiComponent<"Separator"> = (ctx) => {
  const orientation = () => oneOf(ctx.props.orientation, ["horizontal", "vertical"] as const, "horizontal")
  const label = () => (orientation() === "horizontal" ? str(ctx.props.label).trim() : "")
  return (
    <div
      data-gu="separator"
      role="separator"
      aria-orientation={orientation()}
      aria-label={label() || undefined}
      data-orientation={orientation()}
      data-labelled={label() ? "" : undefined}
    >
      <Show when={label()}>
        <span data-slot="label" aria-hidden="true">
          {label()}
        </span>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------------------------------

interface TabItem {
  readonly label: string
  readonly value: string
}

/** Tabs from the prop: `{ label, value }` objects, tolerating plain strings and a missing label or value. */
function tabItems(value: unknown): TabItem[] {
  return list(value).flatMap((item, index): TabItem[] => {
    if (typeof item === "string" || typeof item === "number") {
      const text = str(item)
      return text ? [{ label: text, value: text }] : []
    }
    if (!isRecord(item)) return []
    const label = str(item.label)
    const key = str(item.value) || label || String(index)
    return [{ label: label || key, value: key }]
  })
}

const Tabs: GenuiComponent<"Tabs"> = (ctx) => {
  const base = uid("tabs")
  const tabs = createMemo(() => tabItems(ctx.props.tabs))
  const [value, setValue] = useBound(ctx, "value", "", (next) => (typeof next === "string" ? next : undefined))
  const panels = useChildList(() => ctx.children)
  let listRef: HTMLDivElement | undefined

  const active = createMemo(() => {
    const items = tabs()
    const known = (candidate: string) => candidate !== "" && items.some((tab) => tab.value === candidate)
    const current = value()
    if (known(current)) return current
    const initial = str(ctx.props.defaultValue)
    if (known(initial)) return initial
    return items[0]?.value ?? ""
  })
  const activeIndex = createMemo(() =>
    Math.max(
      0,
      tabs().findIndex((tab) => tab.value === active()),
    ),
  )

  // Child N is the panel of tab N. With a different number of children (and not merely because the spec is still
  // streaming them in) the children are not panels: show them all, as the spec probably switches content itself.
  const mapped = createMemo(() => {
    const count = panels().length
    const total = tabs().length
    return total > 0 && (count === total || (!!ctx.loading && count < total))
  })

  const tabId = (index: number) => `${base}-tab-${index}`
  const panelId = (index?: number) => (index === undefined ? `${base}-panel` : `${base}-panel-${index}`)

  const select = (index: number) => {
    const tab = tabs()[index]
    if (!tab || tab.value === active()) return
    setValue(tab.value)
    ctx.emit("change")
  }

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const count = tabs().length
    if (count === 0) return
    const rtl = !!listRef && getComputedStyle(listRef).direction === "rtl"
    let next: number
    switch (event.key) {
      case "ArrowRight":
        next = rtl ? index - 1 : index + 1
        break
      case "ArrowLeft":
        next = rtl ? index + 1 : index - 1
        break
      case "Home":
        next = 0
        break
      case "End":
        next = count - 1
        break
      default:
        return
    }
    event.preventDefault()
    next = (next + count) % count
    select(next)
    listRef?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div data-gu="tabs">
      <div data-slot="list" role="tablist" aria-orientation="horizontal" ref={listRef}>
        <Index each={tabs()}>
          {(tab, index) => (
            <button
              type="button"
              role="tab"
              data-slot="tab"
              id={tabId(index)}
              aria-selected={index === activeIndex()}
              aria-controls={mapped() ? panelId(index) : panelId()}
              tabindex={index === activeIndex() ? 0 : -1}
              onClick={() => select(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span data-slot="label">{tab().label}</span>
            </button>
          )}
        </Index>
      </div>
      <div
        data-slot="panels"
        role={mapped() ? undefined : "tabpanel"}
        id={mapped() ? undefined : panelId()}
        aria-labelledby={mapped() || tabs().length === 0 ? undefined : tabId(activeIndex())}
      >
        <For each={panels()}>
          {(node, index) => (
            <div
              data-slot="panel"
              role={mapped() ? "tabpanel" : undefined}
              id={mapped() ? panelId(index()) : undefined}
              aria-labelledby={mapped() ? tabId(index()) : undefined}
              tabindex={mapped() ? 0 : undefined}
              hidden={mapped() && index() !== activeIndex()}
            >
              {node}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Accordion, Collapsible
// ---------------------------------------------------------------------------------------------------------------------

interface AccordionItem {
  readonly title: string
  readonly content: string
}

function accordionItems(value: unknown): AccordionItem[] {
  return list(value).flatMap((item): AccordionItem[] => {
    if (typeof item === "string") return [{ title: item, content: "" }]
    if (!isRecord(item)) return []
    return [{ title: str(item.title), content: str(item.content) }]
  })
}

/**
 * Sections on native `<details>`: the browser gives the disclosure semantics, Enter/Space on the header and the
 * hidden state of closed bodies, which stay mounted so their inputs keep what the user entered.
 */
const Accordion: GenuiComponent<"Accordion"> = (ctx) => {
  const { ui } = useHost()
  const items = createMemo(() => accordionItems(ctx.props.items))
  const bodies = useChildList(() => ctx.children)
  const extra = createMemo(() => bodies().slice(items().length))
  const multiple = () => ctx.props.type === "multiple"

  const initial = createMemo((): ReadonlySet<number> => {
    const indexes = list(ctx.props.defaultOpen)
      .map((index) => num(index, -1))
      .filter((index) => Number.isInteger(index) && index >= 0)
    return new Set(multiple() ? indexes : indexes.slice(0, 1))
  })
  // Follows defaultOpen until the user opens or closes a section.
  const [chosen, setChosen] = createSignal<ReadonlySet<number>>()
  const open = () => chosen() ?? initial()

  const toggle = (index: number, next: boolean) => {
    const current = open()
    if (current.has(index) === next) return
    const updated = new Set(multiple() ? current : [])
    if (next) updated.add(index)
    else updated.delete(index)
    setChosen(updated)
  }

  return (
    <div data-gu="accordion" data-type={multiple() ? "multiple" : "single"}>
      <Show when={items().length > 0}>
        <div data-slot="items">
          <Index each={items()}>
            {(item, index) => (
              <details
                data-slot="item"
                open={open().has(index)}
                onToggle={(event) => toggle(index, event.currentTarget.open)}
              >
                <summary data-slot="trigger">
                  <span data-slot="title">{item().title}</span>
                  <span data-slot="chevron" aria-hidden="true">
                    <ui.Icon name="chevron-down" size="small" />
                  </span>
                </summary>
                <div data-slot="content">
                  <Show when={item().content}>
                    <MarkdownText text={item().content} />
                  </Show>
                  {bodies()[index]}
                </div>
              </details>
            )}
          </Index>
        </div>
      </Show>
      <Show when={extra().length > 0}>
        <div data-slot="extra">{extra()}</div>
      </Show>
    </div>
  )
}

const Collapsible: GenuiComponent<"Collapsible"> = (ctx) => {
  const { ui } = useHost()
  // Follows defaultOpen until the user opens or closes it.
  const [chosen, setChosen] = createSignal<boolean>()
  const open = () => chosen() ?? bool(ctx.props.defaultOpen, false)

  return (
    <details
      data-gu="collapsible"
      open={open()}
      onToggle={(event) => {
        if (event.currentTarget.open !== open()) setChosen(event.currentTarget.open)
      }}
    >
      <summary data-slot="trigger">
        <span data-slot="title">{str(ctx.props.title)}</span>
        <span data-slot="arrow" aria-hidden="true">
          <ui.Icon name="fill-triangle-down" size="small" />
        </span>
      </summary>
      <div data-slot="content">{ctx.children}</div>
    </details>
  )
}

type LayoutName = Extract<ComponentName, "Stack" | "Grid" | "Card" | "Separator" | "Tabs" | "Accordion" | "Collapsible">

export const layoutComponents = {
  Stack,
  Grid,
  Card,
  Separator,
  Tabs,
  Accordion,
  Collapsible,
} satisfies { [K in LayoutName]: GenuiComponent<K> }
