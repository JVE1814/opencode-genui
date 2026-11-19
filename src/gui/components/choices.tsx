import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { isIconName, type GenuiIconName } from "../../catalog/icons.ts"
import { safeUrl } from "../../protocol/url.ts"
import { useHost, useSurface } from "../host.ts"
import { openLink } from "../outward.ts"
import { fire, stableList } from "./inputs.tsx"
import { bool, list, num, oneOf, str, useBound, type GenuiComponent } from "./shared.tsx"

// Buttons and choice controls: Button, Link, Toggle, ToggleGroup, ButtonGroup, DropdownMenu, Pagination. Styles:
// src/gui/styles/inputs.css.

/** A press shorter than this shows no busy state, so quick state actions do not flash a spinner. */
const BUSY_DELAY_MS = 150

/** The most pages Pagination accepts; the range it renders stays at 7 entries either way. */
const MAX_PAGES = 1_000_000

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** A choice's value; models sometimes write numbers where the catalog asks for strings. */
const asKey = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined
const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)
const asPage = (value: unknown): number | undefined => {
  const parsed = num(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : undefined
}

interface Item {
  readonly label: string
  readonly value: string
  readonly icon?: GenuiIconName
}

const sameItem = (a: Item, b: Item) => a.label === b.label && a.value === b.value && a.icon === b.icon

/** `{ label, value, icon? }` entries of a model-written list; malformed entries and repeated values are dropped. */
function parseItems(raw: unknown): Item[] {
  const seen = new Set<string>()
  return list<unknown>(raw).flatMap((entry): Item[] => {
    if (!entry || typeof entry !== "object") return []
    const record = entry as Record<string, unknown>
    const value = str(record.value)
    if (!value && typeof record.value !== "string") return []
    if (seen.has(value)) return []
    seen.add(value)
    const icon = isIconName(record.icon) ? record.icon : undefined
    return [{ label: str(record.label, value), value, ...(icon ? { icon } : {}) }]
  })
}

/**
 * Arrow keys, Home and End move focus between the buttons of a segmented group, as the app's segmented control does;
 * Tab still visits each button.
 */
function moveFocus(event: KeyboardEvent & { currentTarget: HTMLElement }) {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"]
  if (!keys.includes(event.key)) return
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-slot="item"]:not(:disabled)'),
  )
  const current = buttons.indexOf(event.target as HTMLButtonElement)
  if (current === -1 || buttons.length === 0) return
  event.preventDefault()
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
  const forward = (event.key === "ArrowRight") !== rtl
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (forward ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}

// ---------------------------------------------------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------------------------------------------------

const BUTTON_VARIANTS = { primary: "contrast", secondary: "neutral", ghost: "ghost", danger: "danger" } as const

const Button: GenuiComponent<"Button"> = (ctx) => {
  const host = useHost()
  const ui = host.ui
  const [busy, setBusy] = createSignal(false)
  const variant = () => oneOf(ctx.props.variant, ["primary", "secondary", "ghost", "danger"] as const, "secondary")
  const icon = () => (isIconName(ctx.props.icon) ? ctx.props.icon : undefined)
  let running = false

  const press = async () => {
    if (running) return
    running = true
    const timer = setTimeout(() => setBusy(true), BUSY_DELAY_MS)
    try {
      await fire(ctx, "press")
    } finally {
      clearTimeout(timer)
      running = false
      setBusy(false)
    }
  }

  return (
    <span data-gu="button" data-variant={variant()}>
      <ui.Button
        variant={BUTTON_VARIANTS[variant()]}
        size={oneOf(ctx.props.size, ["small", "normal", "large"] as const, "normal")}
        icon={icon()}
        disabled={bool(ctx.props.disabled)}
        busy={busy()}
        onClick={() => void press()}
      >
        <span data-slot="label">{str(ctx.props.label)}</span>
      </ui.Button>
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------------------------------------------------

// Only http(s) and mailto hrefs become links (src/protocol/url.ts), and they open through the outward gate, never in
// the app's window. Without a usable href it is a button that looks like a link and fires on.press.
const Link: GenuiComponent<"Link"> = (ctx) => {
  const host = useHost()
  const surface = useSurface()
  const url = createMemo(() => safeUrl(ctx.props.href, "link"))
  const blocked = () => !url() && str(ctx.props.href).trim() !== ""
  const label = () => str(ctx.props.label) || url() || ""

  const open = (event: MouseEvent, href: string) => {
    event.preventDefault()
    void openLink(host, surface, href)
    void fire(ctx, "press")
  }

  return (
    <Show
      when={url()}
      fallback={
        <button
          type="button"
          data-gu="link"
          data-blocked={blocked() ? "" : undefined}
          title={blocked() ? host.t("c.link.blocked") : undefined}
          onClick={() => void fire(ctx, "press")}
        >
          {label()}
        </button>
      }
    >
      {(href) => (
        <a
          data-gu="link"
          href={href()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => open(event, href())}
          onAuxClick={(event) => event.preventDefault()}
        >
          {label()}
        </a>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------------------------------------------------

// A native aria-pressed button: ui.Button cannot report a pressed state, and ui.IconButton has no text.
const Toggle: GenuiComponent<"Toggle"> = (ctx) => {
  const host = useHost()
  const ui = host.ui
  const [pressed, setPressed] = useBound<boolean>(ctx, "pressed", false, asBoolean)
  const icon = () => (isIconName(ctx.props.icon) ? ctx.props.icon : undefined)

  return (
    <button
      type="button"
      data-gu="toggle"
      data-pressed={pressed() ? "" : undefined}
      aria-pressed={pressed()}
      disabled={bool(ctx.props.disabled)}
      onClick={() => {
        setPressed(!pressed())
        void fire(ctx, "change")
      }}
    >
      <Show when={icon()}>{(name) => <ui.Icon name={name()} />}</Show>
      <span data-slot="label">{str(ctx.props.label)}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// ToggleGroup
// ---------------------------------------------------------------------------------------------------------------------

const ToggleGroup: GenuiComponent<"ToggleGroup"> = (ctx) => {
  const host = useHost()
  const ui = host.ui
  const items = stableList(() => parseItems(ctx.props.items), sameItem)
  const [value, setValue] = useBound<unknown>(ctx, "value", undefined)
  const multiple = () => ctx.props.type === "multiple"
  const disabled = () => bool(ctx.props.disabled)
  // Either shape is read in either mode, so a model that binds the wrong one still shows its selection.
  const selected = createMemo(() => {
    const current = value()
    const values = Array.isArray(current) ? current : [current]
    return values.map(asKey).filter((entry): entry is string => !!entry)
  })

  const press = (item: Item) => {
    const current = selected()
    if (multiple()) {
      setValue(
        current.includes(item.value) ? current.filter((entry) => entry !== item.value) : [...current, item.value],
      )
    } else {
      // Single mode keeps one choice, as a segmented control does: pressing the chosen item again changes nothing.
      if (current.length === 1 && current[0] === item.value) return
      setValue(item.value)
    }
    void fire(ctx, "change")
  }

  return (
    <div
      data-gu="toggle-group"
      data-type={multiple() ? "multiple" : "single"}
      data-empty={items().length === 0 ? "" : undefined}
      role="group"
      onKeyDown={moveFocus}
    >
      <For each={items()}>
        {(item) => {
          const pressed = () => selected().includes(item.value)
          return (
            <button
              type="button"
              data-slot="item"
              data-pressed={pressed() ? "" : undefined}
              aria-pressed={pressed()}
              disabled={disabled()}
              onClick={() => press(item)}
            >
              <Show when={item.icon}>{(name) => <ui.Icon name={name()} />}</Show>
              <span data-slot="label">{item.label}</span>
            </button>
          )
        }}
      </For>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// ButtonGroup
// ---------------------------------------------------------------------------------------------------------------------

// The app's segmented control (navigation/segmented-control), with its static pressed look: the sliding indicator is
// an animation from a library the plugin cannot load.
const ButtonGroup: GenuiComponent<"ButtonGroup"> = (ctx) => {
  const buttons = stableList(() => parseItems(ctx.props.buttons), sameItem)
  const [selected, setSelected] = useBound<string>(ctx, "selected", "", asKey)

  return (
    <div data-gu="button-group" data-empty={buttons().length === 0 ? "" : undefined} role="group" onKeyDown={moveFocus}>
      <For each={buttons()}>
        {(button) => {
          const pressed = () => selected() === button.value
          return (
            <button
              type="button"
              data-slot="item"
              data-pressed={pressed() ? "" : undefined}
              aria-pressed={pressed()}
              onClick={() => {
                if (pressed()) return
                setSelected(button.value)
                void fire(ctx, "change")
              }}
            >
              <span data-slot="label">{button.label}</span>
            </button>
          )
        }}
      </For>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// DropdownMenu
// ---------------------------------------------------------------------------------------------------------------------

const DropdownMenu: GenuiComponent<"DropdownMenu"> = (ctx) => {
  const host = useHost()
  const ui = host.ui
  const items = stableList(() => parseItems(ctx.props.items), sameItem)
  const [, setValue] = useBound<string>(ctx, "value", "", asKey)
  const entries = createMemo(() =>
    items().map((item) => ({
      label: item.label,
      ...(item.icon ? { icon: item.icon } : {}),
      onSelect: () => {
        setValue(item.value)
        void fire(ctx, "select")
      },
    })),
  )

  return (
    <div data-gu="dropdown-menu">
      <ui.Menu
        label={str(ctx.props.label) || host.t("c.dropdownMenu.label")}
        items={entries()}
        trigger="button"
        placement="bottom-start"
        disabled={entries().length === 0}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------------------------------

/** 1-based pages to show: all of them up to 7, else first, last and the current page's neighbours, with ellipses. */
function pageRange(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  // Near either end, show five pages on that side so the list keeps seven entries.
  const start = current <= 4 ? 2 : current >= total - 3 ? total - 4 : current - 1
  const end = current <= 4 ? 5 : current >= total - 3 ? total - 1 : current + 1
  const pages: (number | "ellipsis")[] = [1]
  if (start > 2) pages.push("ellipsis")
  for (let page = start; page <= end; page++) pages.push(page)
  if (end < total - 1) pages.push("ellipsis")
  pages.push(total)
  return pages
}

const Pagination: GenuiComponent<"Pagination"> = (ctx) => {
  const host = useHost()
  const ui = host.ui
  const total = () => clamp(Math.floor(num(ctx.props.totalPages, 1)), 1, MAX_PAGES)
  const [stored, setPage] = useBound<number>(ctx, "page", 1, asPage)
  const page = () => clamp(Math.round(stored()), 1, total())
  const pages = createMemo(() => pageRange(page(), total()))

  const go = (target: number) => {
    const next = clamp(target, 1, total())
    if (next === page()) return
    setPage(next)
    void fire(ctx, "change")
  }

  return (
    <nav data-gu="pagination" aria-label={host.t("c.pagination.label")}>
      <ui.IconButton
        icon="chevron-left"
        label={host.t("c.pagination.previous")}
        disabled={page() <= 1}
        onClick={() => go(page() - 1)}
      />
      <ul data-slot="pages">
        <For each={pages()}>
          {(entry): JSX.Element => (
            <li data-slot="entry">
              {typeof entry === "number" ? (
                <button
                  type="button"
                  data-slot="page"
                  aria-current={entry === page() ? "page" : undefined}
                  aria-label={host.t("c.pagination.page", { page: entry })}
                  onClick={() => go(entry)}
                >
                  {entry}
                </button>
              ) : (
                <span data-slot="ellipsis" aria-hidden="true">
                  …
                </span>
              )}
            </li>
          )}
        </For>
      </ul>
      <ui.IconButton
        icon="chevron-right"
        label={host.t("c.pagination.next")}
        disabled={page() >= total()}
        onClick={() => go(page() + 1)}
      />
      <span data-gu-sr aria-live="polite">
        {host.t("c.pagination.status", { page: page(), total: total() })}
      </span>
    </nav>
  )
}

export const choiceComponents = {
  Button,
  Link,
  Toggle,
  ToggleGroup,
  ButtonGroup,
  DropdownMenu,
  Pagination,
} satisfies {
  [K in "Button" | "Link" | "Toggle" | "ToggleGroup" | "ButtonGroup" | "DropdownMenu" | "Pagination"]: GenuiComponent<K>
}
