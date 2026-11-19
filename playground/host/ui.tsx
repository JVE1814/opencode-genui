import {
  children,
  createContext,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  useContext,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import type { Ui, UiMenuEntry, UiMenuItem, UiSelectOption } from "@opencode/plugin/gui"
import { getIcon, isIconName, resolveIconName } from "@opencode/ui/icons/catalog"
import { MarkdownView, PlainCode } from "./markdown.tsx"

/**
 * The fake host's `ctx.ui`: each component renders the markup the app's own component renders (the same
 * `data-component` / `data-slot` / `data-variant` attributes, see node_modules/@opencode/ui/src), so @opencode/ui's real
 * stylesheets give it the app's look. Overlays (menus, selects, tooltips) are simple positioned elements instead of
 * Kobalte's, with the same content markup.
 */

const iconSize = { small: 14, normal: 16, large: 20 } as const

export function Icon(props: { name: string; size?: "small" | "normal" | "large"; class?: string }) {
  const name = () => resolveIconName(isIconName(props.name) ? props.name : "plus")
  const pixels = () => iconSize[props.size ?? "normal"]
  return (
    <svg
      data-slot="icon-svg"
      width={pixels()}
      height={pixels()}
      viewBox={getIcon(name()).viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      class={props.class}
      // The artwork comes from the app's icon catalog, never from plugin or model input.
      innerHTML={getIcon(name()).body}
    />
  )
}

export function Loader(props: { size?: "small" | "normal" | "large"; class?: string }) {
  const pixels = () => iconSize[props.size ?? "normal"]
  return (
    <svg
      width={pixels()}
      height={pixels()}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-component="loader-v2"
      aria-hidden="true"
      class={props.class}
    >
      <circle cx="8" cy="8" r="6" data-slot="loader-v2-background" stroke-width="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        data-slot="loader-v2-progress"
        pathLength="100"
        stroke-width="2"
        stroke-dasharray="33 67"
      />
    </svg>
  )
}

export function Keybind(props: { keys: readonly string[]; class?: string }) {
  return (
    <Show when={props.keys.length > 0}>
      <div data-component="keybind-v2" data-variant="neutral" class={props.class}>
        <For each={props.keys}>
          {(key) => (
            <div data-slot="keybind-v2-key">
              <span data-slot="keybind-v2-label">{key}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

/** Positions a floating element under (or over) its anchor, in viewport coordinates. */
function place(anchor: HTMLElement, placement: string, gutter = 4): JSX.CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const style: JSX.CSSProperties = { position: "fixed", "z-index": "1000" }
  if (placement.startsWith("top")) style.bottom = `${window.innerHeight - rect.top + gutter}px`
  else if (placement === "left") {
    style.top = `${rect.top}px`
    style.right = `${window.innerWidth - rect.left + gutter}px`
    return style
  } else if (placement === "right") {
    style.top = `${rect.top}px`
    style.left = `${rect.right + gutter}px`
    return style
  } else style.top = `${rect.bottom + gutter}px`
  if (placement.endsWith("end")) style.right = `${window.innerWidth - rect.right}px`
  else if (placement.endsWith("start")) style.left = `${rect.left}px`
  else style.left = `${rect.left + rect.width / 2}px`
  return style
}

/** Closes a popover on Escape or a press outside both the trigger and the popover. */
function dismissable(isOpen: () => boolean, close: () => void, parts: () => (HTMLElement | undefined)[]) {
  const onPointer = (event: PointerEvent) => {
    if (!isOpen()) return
    const target = event.target as Node
    if (parts().some((part) => part?.contains(target))) return
    close()
  }
  const onKey = (event: KeyboardEvent) => {
    if (isOpen() && event.key === "Escape") close()
  }
  document.addEventListener("pointerdown", onPointer, true)
  document.addEventListener("keydown", onKey)
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointer, true)
    document.removeEventListener("keydown", onKey)
  })
}

const MenuContext = createContext<{ close(): void }>()

function useMenu(component: string) {
  const menu = useContext(MenuContext)
  if (!menu) throw new Error(`ctx.ui.${component} renders only inside a menu`)
  return menu
}

function MenuRow(props: UiMenuItem) {
  const menu = useMenu("MenuItem")
  return (
    <div
      data-component="menu-v2-item"
      role="menuitem"
      tabIndex={-1}
      data-disabled={props.disabled ? "" : undefined}
      aria-disabled={props.disabled || undefined}
      onClick={() => {
        if (props.disabled) return
        menu.close()
        props.onSelect()
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        event.currentTarget.click()
      }}
    >
      <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
      <span data-slot="menu-v2-item-content">{props.label}</span>
      <Show when={props.keys?.length}>
        <span data-slot="menu-v2-item-shortcut">
          <Keybind keys={props.keys ?? []} />
        </span>
      </Show>
    </div>
  )
}

function MenuEntries(props: { items: readonly UiMenuEntry[] }) {
  return (
    <For each={props.items}>
      {(entry) => {
        if (entry.type === "separator") return <div data-slot="menu-v2-separator" role="separator" />
        if (entry.type === "group")
          return (
            <div role="group" aria-label={entry.label}>
              <div data-slot="menu-v2-group-label">{entry.label}</div>
              <For each={entry.items}>{(item) => <MenuRow {...item} />}</For>
            </div>
          )
        return <MenuRow {...entry} />
      }}
    </For>
  )
}

/** A menu button and its popover; also used by the host's own "+" menu. */
export function MenuButton(props: {
  label: string
  trigger?: "icon" | "button"
  icon?: string
  placement?: string
  disabled?: boolean
  children: JSX.Element
}) {
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  let content: HTMLDivElement | undefined
  dismissable(
    open,
    () => setOpen(false),
    () => [trigger, content],
  )
  return (
    <>
      <Show
        when={props.trigger === "button"}
        fallback={
          <button
            ref={trigger}
            type="button"
            data-component="icon-button-v2"
            data-size="normal"
            data-variant="ghost-muted"
            aria-label={props.label}
            aria-haspopup="menu"
            aria-expanded={open()}
            data-expanded={open() ? "" : undefined}
            disabled={props.disabled}
            onClick={() => setOpen(!open())}
          >
            <Icon name={props.icon ?? "outline-dots"} />
          </button>
        }
      >
        <button
          ref={trigger}
          type="button"
          data-component="button-v2"
          data-size="normal"
          data-variant="neutral"
          data-icon={props.icon}
          aria-haspopup="menu"
          aria-expanded={open()}
          disabled={props.disabled}
          onClick={() => setOpen(!open())}
        >
          <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
          {props.label}
        </button>
      </Show>
      <Show when={open() && trigger}>
        {(anchor) => (
          <Portal>
            <div
              ref={content}
              data-component="menu-v2-content"
              role="menu"
              aria-label={props.label}
              style={place(anchor(), props.placement ?? "bottom-end")}
            >
              <MenuContext.Provider value={{ close: () => setOpen(false) }}>{props.children}</MenuContext.Provider>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}

function Tooltip(props: { value: JSX.Element; keys?: readonly string[]; placement?: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLDivElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const show = (delay: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    clearTimeout(timer)
    setOpen(false)
  }
  onCleanup(() => clearTimeout(timer))
  return (
    <>
      <div
        ref={trigger}
        data-component="tooltip-v2-trigger"
        onPointerEnter={() => show(400)}
        onPointerLeave={hide}
        onFocusIn={() => show(0)}
        onFocusOut={hide}
      >
        {props.children}
      </div>
      <Show when={open() && trigger}>
        {(anchor) => (
          <Portal>
            <div
              data-component="tooltip-v2"
              data-appearance="compact"
              data-placement={props.placement ?? "top"}
              role="tooltip"
              style={place(anchor(), props.placement ?? "top", 6)}
            >
              <span>{props.value}</span>
              <Keybind keys={props.keys ?? []} />
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}

function Select(props: {
  options: readonly UiSelectOption[]
  value: string | undefined
  onChange: (value: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  placement?: string
  class?: string
}) {
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(0)
  let trigger: HTMLButtonElement | undefined
  let content: HTMLDivElement | undefined
  const id = createUniqueId()
  dismissable(
    open,
    () => setOpen(false),
    () => [trigger, content],
  )
  const current = () => props.options.find((option) => option.value === props.value)
  const pick = (option: UiSelectOption | undefined) => {
    setOpen(false)
    trigger?.focus()
    if (option && option.value !== props.value) props.onChange(option.value)
  }
  const openList = () => {
    if (props.disabled) return
    setActive(
      Math.max(
        0,
        props.options.findIndex((option) => option.value === props.value),
      ),
    )
    setOpen(true)
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? id : undefined}
        aria-invalid={props.invalid || undefined}
        data-component="select-v2"
        data-appearance="inline"
        data-expanded={open() ? "" : undefined}
        data-invalid={props.invalid ? "" : undefined}
        data-disabled={props.disabled ? "" : undefined}
        disabled={props.disabled}
        class={props.class}
        onClick={() => (open() ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            if (!open()) return openList()
            const step = event.key === "ArrowDown" ? 1 : -1
            setActive((index) => Math.min(props.options.length - 1, Math.max(0, index + step)))
          } else if ((event.key === "Enter" || event.key === " ") && open()) {
            event.preventDefault()
            pick(props.options[active()])
          }
        }}
      >
        <div data-slot="select-v2-value">
          <span data-slot="select-v2-value-text" data-placeholder-shown={current() ? undefined : ""}>
            {current()?.label ?? props.placeholder ?? ""}
          </span>
        </div>
        <span data-slot="select-v2-chevron" aria-hidden="true">
          {/* The app's own artwork (@opencode/ui select.tsx): drawn pointing up, select.css turns it while closed. */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M11 9.5L8 6.5L5 9.5"
              stroke="currentColor"
              stroke-width="1"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </button>
      <Show when={open() && trigger}>
        {(anchor) => (
          <Portal>
            <div
              ref={content}
              data-component="menu-v2-content"
              data-slot="select-v2-content"
              style={{
                ...place(anchor(), props.placement ?? "bottom-end", 6),
                "min-width": `${anchor().offsetWidth}px`,
              }}
            >
              <div id={id} role="listbox" aria-label={props.label} data-slot="select-v2-listbox">
                <For each={props.options}>
                  {(option, index) => (
                    <div
                      role="option"
                      data-component="menu-v2-item"
                      aria-selected={option.value === props.value}
                      data-selected={option.value === props.value ? "" : undefined}
                      data-highlighted={index() === active() ? "" : undefined}
                      onPointerEnter={() => setActive(index())}
                      onClick={() => pick(option)}
                    >
                      <span data-slot="menu-v2-item-content">{option.label}</span>
                      <span data-slot="menu-v2-item-indicator">
                        <Show when={option.value === props.value}>
                          <Icon name="check" size="small" />
                        </Show>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}

/** The dialog a `ctx.dialogs.open` render sits in; `Ui.Dialog`'s close button closes it. */
export const DialogFrameContext = createContext<{ close(): void }>()

function fence(content: string, language: string | undefined) {
  const longest = Array.from(content.matchAll(/`+/g)).reduce((most, run) => Math.max(most, run[0].length), 0)
  const ticks = "`".repeat(Math.max(3, longest + 1))
  return { ticks, info: (language ?? "").replace(/[^\w#+.-]/g, "") }
}

export function CopyButton(props: { text: () => string; label?: string }) {
  const [copied, setCopied] = createSignal(false)
  return (
    <button
      type="button"
      data-component="icon-button-v2"
      data-size="normal"
      data-variant="ghost-muted"
      aria-label={props.label ?? "Copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(props.text()).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      <Icon name={copied() ? "check" : "copy"} />
    </button>
  )
}

export const ui: Ui = {
  Icon: (props) => <Icon name={props.name} size={props.size} class={props.class} />,
  Button: (props) => (
    <button
      type={props.type ?? "button"}
      data-component="button-v2"
      data-size={props.size ?? "normal"}
      data-variant={props.variant ?? "neutral"}
      data-icon={props.busy ? undefined : props.icon}
      disabled={props.disabled || props.busy}
      data-disabled={props.disabled || props.busy ? "" : undefined}
      aria-busy={props.busy || undefined}
      autofocus={props.autofocus}
      class={props.class}
      onClick={(event) => props.onClick?.(event)}
    >
      <Show when={props.busy}>
        <Loader size="small" />
      </Show>
      <Show when={!props.busy && props.icon}>{(icon) => <Icon name={icon()} />}</Show>
      {props.children}
    </button>
  ),
  IconButton: (props) => (
    <button
      type="button"
      data-component="icon-button-v2"
      data-size={props.size ?? "normal"}
      data-variant={props.variant ?? "ghost-muted"}
      data-state={props.pressed ? "pressed" : undefined}
      aria-label={props.label}
      aria-pressed={props.pressed}
      aria-busy={props.busy || undefined}
      disabled={props.disabled || props.busy}
      data-disabled={props.disabled || props.busy ? "" : undefined}
      class={props.class}
      onClick={(event) => props.onClick?.(event)}
    >
      <Show when={props.busy} fallback={<Icon name={props.icon} />}>
        <Loader />
      </Show>
    </button>
  ),
  Tooltip: (props) => (
    <Tooltip value={props.value} keys={props.keys} placement={props.placement}>
      {props.children}
    </Tooltip>
  ),
  Menu: (props) => (
    <MenuButton
      label={props.label}
      trigger={props.trigger}
      icon={props.icon}
      placement={props.placement}
      disabled={props.disabled}
    >
      <MenuEntries items={props.items} />
    </MenuButton>
  ),
  MenuItem: (props) => <MenuRow {...props} />,
  MenuSeparator: () => {
    useMenu("MenuSeparator")
    return <div data-slot="menu-v2-separator" role="separator" />
  },
  MenuGroup: (props) => {
    useMenu("MenuGroup")
    return (
      <div role="group" aria-label={props.label}>
        <div data-slot="menu-v2-group-label">{props.label}</div>
        {props.children}
      </div>
    )
  },
  MenuSub: (props) => {
    useMenu("MenuSub")
    const [open, setOpen] = createSignal(false)
    return (
      <div
        role="group"
        aria-label={props.label}
        onPointerEnter={() => {
          setOpen(true)
          props.onOpenChange?.(true)
        }}
        onPointerLeave={() => {
          setOpen(false)
          props.onOpenChange?.(false)
        }}
      >
        <div data-component="menu-v2-item" role="menuitem" aria-haspopup="menu" aria-expanded={open()}>
          <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
          <span data-slot="menu-v2-item-content">{props.label}</span>
          <span data-slot="menu-v2-item-chevron">
            <Icon name="chevron-right" size="small" />
          </span>
        </div>
        <Show when={open()}>
          <div data-component="menu-v2-content" role="menu" aria-label={props.label} data-playground-submenu>
            {props.children}
          </div>
        </Show>
      </div>
    )
  },
  Loader: (props) => <Loader size={props.size} class={props.class} />,
  Dialog: (props) => {
    const frame = useContext(DialogFrameContext)
    const footer = children(() => props.footer)
    const titleId = createUniqueId()
    const size = () => props.size ?? "fit"
    return (
      <div
        data-component="dialog-v2"
        data-fit={size() === "fit" ? true : undefined}
        data-size={size() === "large" || size() === "x-large" ? size() : "normal"}
      >
        <div data-slot="dialog-container">
          <div data-slot="dialog-content" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <div data-slot="dialog-header" data-hide-close={props.closable === false ? "" : undefined}>
              <div data-slot="dialog-title-group">
                <h2 id={titleId} data-slot="dialog-title">
                  {props.title}
                </h2>
                <Show when={props.description}>
                  <p data-slot="dialog-description">{props.description}</p>
                </Show>
              </div>
              <Show when={props.closable !== false}>
                <button
                  type="button"
                  data-slot="dialog-close-button"
                  data-component="icon-button-v2"
                  data-size="normal"
                  data-variant="ghost-muted"
                  aria-label="Close"
                  onClick={() => frame?.close()}
                >
                  <Icon name="close" />
                </button>
              </Show>
            </div>
            <div data-slot="dialog-body">
              <div data-scrollable class="playground-dialog-scroll" classList={{ "playground-dialog-pad": !footer() }}>
                {props.children}
              </div>
            </div>
            <Show when={footer()}>
              <div data-slot="dialog-footer">{footer()}</div>
            </Show>
          </div>
        </div>
      </div>
    )
  },
  Switch: (props) => {
    const id = createUniqueId()
    const toggle = () => {
      if (!props.disabled) props.onChange(!props.checked)
    }
    return (
      <div
        data-component="switch"
        data-appearance="compact"
        data-checked={props.checked ? "" : undefined}
        data-disabled={props.disabled ? "" : undefined}
      >
        <input
          id={id}
          type="checkbox"
          role="switch"
          data-slot="switch-input"
          checked={props.checked}
          disabled={props.disabled}
          aria-checked={props.checked}
          onChange={(event) => {
            // The parent decides the state; snap the input back until it does.
            event.currentTarget.checked = props.checked
            toggle()
          }}
        />
        <label for={id} data-slot="switch-label" classList={{ "sr-only": !!props.hideLabel }}>
          {props.label}
        </label>
        <Show when={props.description}>
          <div data-slot="switch-description">{props.description}</div>
        </Show>
        <div data-slot="switch-control" onClick={toggle}>
          <div data-slot="switch-thumb" />
        </div>
      </div>
    )
  },
  TextInput: (props) => (
    <div
      data-component="text-input-v2"
      data-disabled={props.disabled ? "" : undefined}
      data-invalid={props.invalid ? "" : undefined}
      data-appearance={props.size === "large" ? "large" : "base"}
      data-surface="base"
      class={props.class}
    >
      <div data-slot="text-input-v2-value">
        <input
          type={props.type ?? "text"}
          data-slot="text-input-v2-input"
          value={props.value}
          placeholder={props.placeholder}
          aria-label={props.label}
          aria-invalid={props.invalid ? true : undefined}
          disabled={props.disabled}
          autofocus={props.autofocus}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.isComposing || !props.onSubmit) return
            event.preventDefault()
            props.onSubmit(event.currentTarget.value)
          }}
        />
      </div>
    </div>
  ),
  Select: (props) => (
    <Select
      options={props.options}
      value={props.value}
      onChange={(value) => props.onChange(value as never)}
      label={props.label}
      placeholder={props.placeholder}
      disabled={props.disabled}
      invalid={props.invalid}
      placement={props.placement}
      class={props.class}
    />
  ),
  Keybind: (props) => <Keybind keys={props.keys} class={props.class} />,
  // Code blocks inside Ui.Markdown show as code: in the app they show CodeBlock content only on the session screen,
  // and never inside a CodeBlock render.
  Markdown: (props) => <MarkdownView text={props.text} class={props.class} />,
  Code: (props) => {
    const parts = () => fence(props.content, props.language)
    return (
      <div data-component="markdown" class={props.class} data-fence={parts().ticks.length}>
        <PlainCode
          block={{ language: parts().info, body: props.content, closed: true, ordinal: 0 }}
          toolbar={<CopyButton text={() => props.content} />}
        />
      </div>
    )
  },
  SettingsLayout: (props) => (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="settings-tab-header-copy">
            <h2 class="settings-tab-title">{props.title}</h2>
            <Show when={props.description}>
              <span class="settings-tab-description">{props.description}</span>
            </Show>
          </div>
          <div class="settings-tab-header-actions">{props.actions}</div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">{props.children}</div>
    </>
  ),
  SettingsSection: (props) => (
    <section class="settings-section" aria-label={props.title}>
      <Show when={props.title}>
        <h3 class="settings-section-title">{props.title}</h3>
      </Show>
      <div data-component="settings-list">{props.children}</div>
      {props.footer}
    </section>
  ),
  SettingsRow: (props) => {
    const description = children(() => props.description)
    return (
      <div data-component="settings-row" data-action={props.id}>
        <div data-slot="settings-row-copy">
          <div data-slot="settings-row-title">{props.title}</div>
          <Show when={description()}>
            <div data-slot="settings-row-description">{description()}</div>
          </Show>
        </div>
        <div data-slot="settings-row-control">{props.children}</div>
      </div>
    )
  },
}
