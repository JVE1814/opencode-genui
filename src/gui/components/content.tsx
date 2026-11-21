import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { BaseComponentProps } from "@json-render/solid"
import type { ComponentName } from "../../catalog/components.ts"
import { isIconName } from "../../catalog/icons.ts"
import { safeUrl } from "../../protocol/url.ts"
import { useHost, useSurface, type Host } from "../host.ts"
import { openLink } from "../outward.ts"
import { ITEM_LISTS, splitKeys } from "../costs.ts"
import { markdownCut } from "../issues.ts"
import {
  JOINER,
  linkTarget,
  prepareMarkdown,
  setImageLabel,
  shownLength,
  stripJoiners,
  type MarkdownPart,
} from "./markdown.ts"
import { amount, CutNote, firstItems, oneOf, str, useCut, useListCut, type GenuiComponent } from "./shared.tsx"

// Content components: Heading, Text, Markdown, Code, Badge, Alert, Keybind, Icon. Styles: src/gui/styles/content.css.

const TONES = ["neutral", "info", "success", "warning", "danger"] as const

// ---------------------------------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Model-written Markdown through the app's renderer (`ui.Markdown`), shared by Markdown, Accordion and Popover.
 *
 * - The renderer never gets a link, image or tag whose address the model wrote (src/gui/components/markdown.ts):
 *   links, images, autolinks and bare URLs become links to `#genui-link:` fragments, which the app renders without
 *   loading anything (it adds a remote favicon to every web link), and nothing else can become a link, an image or
 *   HTML. So nothing loads remote content without a click, whatever the text is built from. Fenced code blocks render
 *   with `ui.Code`.
 * - A click on one of those links opens its address through the surface's link policy (http, https and mailto only, the
 *   outward gate, a confirm on untrusted surfaces): a capturing listener on the wrapper sees the click before the
 *   renderer does.
 * - Copying a selection drops the invisible joiners the neutralizing added.
 */
export function MarkdownText(props: {
  readonly text: string
  /** The element the text belongs to, which reports a cut text (see useCut). */
  readonly owner: BaseComponentProps<Record<string, unknown>>
}) {
  const host = useHost()
  const surface = useSurface()
  // Texts are measured with the label the app's locale gives images without alt text (see setImageLabel).
  const imageLabel = () => host.t("c.markdown.image")
  // What shows of a long text (see shownLength): the rest is said under it and reported.
  const cut = createMemo(
    () => {
      setImageLabel(imageLabel())
      return shownLength(props.text)
    },
    undefined,
    {
      equals: (a, b) => a.shown === b.shown && a.reason === b.reason,
    },
  )
  const total = () => props.text.length
  useCut(props.owner, () => {
    const { shown, reason } = cut()
    return reason ? markdownCut(shown, total(), reason) : undefined
  })
  const note = () =>
    cut().reason ? host.t("c.markdown.cut", { shown: amount(cut().shown), total: amount(total()) }) : ""
  // Prose neutralized, all parts sharing the text's budget for the renderer's work (see MarkdownBudget).
  const parts = createMemo(() => prepareMarkdown(props.text, imageLabel(), cut()))

  const intercept = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    if (event.type === "auxclick" && event.button !== 1) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest("a[href]")
    if (!anchor) return
    const href = anchor.getAttribute("href") ?? ""
    const own = linkTarget(href)
    // Other in-document anchors stay with the renderer.
    if (own === undefined && href.startsWith("#")) return
    event.preventDefault()
    event.stopPropagation()
    // genui's own links carry the address; the renderer's (e-mail addresses it links itself) are checked here.
    const url = safeUrl(own ?? stripJoiners(href), "link")
    if (url) void openLink(host, surface, url)
    else host.toast({ title: host.t("action.linkBlocked"), variant: "error" })
  }

  const copy = (event: ClipboardEvent) => {
    const selected = globalThis.getSelection?.()?.toString() ?? ""
    if (!selected.includes(JOINER) || !event.clipboardData) return
    event.clipboardData.setData("text/plain", stripJoiners(selected))
    event.preventDefault()
  }

  return (
    <div
      data-gu="markdown"
      ref={(element) => {
        element.addEventListener("click", intercept, true)
        element.addEventListener("auxclick", intercept, true)
        element.addEventListener("copy", copy)
      }}
    >
      <Index each={parts()}>
        {(part) => (
          <Show
            when={part().kind === "code" ? (part() as Extract<MarkdownPart, { kind: "code" }>) : undefined}
            fallback={<host.ui.Markdown text={(part() as Extract<MarkdownPart, { kind: "markdown" }>).text ?? ""} />}
          >
            {(code) => <host.ui.Code content={code().code} language={code().language} />}
          </Show>
        )}
      </Index>
      <CutNote text={note()} />
    </div>
  )
}

const Markdown: GenuiComponent<"Markdown"> = (ctx) => <MarkdownText text={str(ctx.props.content)} owner={ctx} />

// ---------------------------------------------------------------------------------------------------------------------
// Heading, Text
// ---------------------------------------------------------------------------------------------------------------------

const Heading: GenuiComponent<"Heading"> = (ctx) => {
  const level = () => oneOf(ctx.props.level, ["h1", "h2", "h3", "h4"] as const, "h2")
  return (
    <Dynamic component={level()} data-gu="heading" data-level={level()}>
      {str(ctx.props.text)}
    </Dynamic>
  )
}

const Text: GenuiComponent<"Text"> = (ctx) => {
  const variant = () => oneOf(ctx.props.variant, ["body", "lead", "muted", "caption", "code"] as const, "body")
  const text = () => str(ctx.props.text)
  return (
    <p
      data-gu="text"
      data-variant={variant()}
      data-weight={oneOf(ctx.props.weight, ["regular", "medium"] as const, "regular")}
      data-align={oneOf(ctx.props.align, ["start", "center", "end"] as const, "start")}
    >
      <Show when={variant() === "code"} fallback={text()}>
        <code data-slot="code">{text()}</code>
      </Show>
    </p>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------------------------------------------------

const COPIED_MS = 1500

/**
 * The timeline's code block (`ui.Code`). With a title or language it gets a header that names it and holds the copy
 * button; without one it is exactly the timeline's block, whose own copy button shows on hover.
 */
const Code: GenuiComponent<"Code"> = (ctx) => {
  const host = useHost()
  const code = () => str(ctx.props.code)
  const title = () => str(ctx.props.title).trim()
  const language = () => str(ctx.props.language).trim()
  const header = () => !!(title() || language())

  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  const copy = () => {
    host.copy(code()).then(
      () => {
        setCopied(true)
        clearTimeout(timer)
        timer = setTimeout(() => setCopied(false), COPIED_MS)
        host.toast({ title: host.t("c.code.copied"), variant: "success" })
      },
      () => host.toast({ title: host.t("c.code.copyFailed"), variant: "error" }),
    )
  }

  return (
    <figure data-gu="code" data-header={header() ? "" : undefined}>
      <Show when={header()}>
        <figcaption data-slot="header">
          <Show when={title()}>
            <span data-slot="title">{title()}</span>
          </Show>
          <Show when={language()}>
            <span data-slot="language">{language()}</span>
          </Show>
          <span data-slot="actions">
            <host.ui.Tooltip value={host.t("c.code.copy")}>
              <host.ui.IconButton
                icon={copied() ? "check" : "copy"}
                label={host.t("c.code.copy")}
                size="small"
                onClick={copy}
              />
            </host.ui.Tooltip>
          </span>
        </figcaption>
      </Show>
      <div data-slot="body">
        <host.ui.Code content={code()} language={language() || undefined} />
      </div>
    </figure>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Badge, Alert
// ---------------------------------------------------------------------------------------------------------------------

/** A tag. Nothing renders while its text is empty (a `$state` text not streamed in yet), not an empty pill. */
// Whether text draws anything: not only whitespace and invisible format characters (zero-width spaces and joiners).
const visibleText = (text: string) => text.replace(/[\s\p{Cf}]/gu, "") !== ""

const Badge: GenuiComponent<"Badge"> = (ctx) => {
  const text = () => str(ctx.props.text)
  return (
    <Show when={visibleText(text())}>
      <span
        data-gu="badge"
        data-variant={oneOf(
          ctx.props.variant,
          ["default", "secondary", "outline", "success", "warning", "danger", "info"] as const,
          "default",
        )}
      >
        <span data-slot="text">{text()}</span>
      </span>
    </Show>
  )
}

const ALERT_ICONS = {
  info: "info",
  success: "circle-check",
  warning: "warning",
  error: "circle-exclamation",
} as const

const Alert: GenuiComponent<"Alert"> = (ctx) => {
  const host = useHost()
  const type = () => oneOf(ctx.props.type, ["info", "success", "warning", "error"] as const, "info")
  const title = () => str(ctx.props.title)
  const message = () => str(ctx.props.message)
  return (
    // A polite live region: when a bound title or message changes, it is announced; an alert scrolled back into view
    // (timeline rows remount) is not announced again, as role="alert" would.
    <div data-gu="alert" data-type={type()} role="status">
      <span data-slot="icon" aria-hidden="true">
        <host.ui.Icon name={ALERT_ICONS[type()]} size="normal" />
      </span>
      <div data-slot="content">
        <Show when={title()}>
          <p data-slot="title">
            <span data-gu-sr="">{`${host.t(`c.alert.${type()}`)}: `}</span>
            {title()}
          </p>
        </Show>
        <Show when={message()}>
          <p data-slot="message">{message()}</p>
        </Show>
        <div data-slot="actions">{ctx.children}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Keybind, Icon
// ---------------------------------------------------------------------------------------------------------------------

const IS_MAC = (() => {
  try {
    const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined
    return /mac|iphone|ipad/i.test(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "")
  } catch {
    return false
  }
})()

interface KeyPart {
  /** What the chip shows. */
  readonly shown: string
  /** What screen readers hear (⌘ reads as "place of interest"). */
  readonly spoken: string
}

const ARROWS: Readonly<Record<string, string>> = {
  arrowup: "↑",
  up: "↑",
  arrowdown: "↓",
  down: "↓",
  arrowleft: "←",
  left: "←",
  arrowright: "→",
  right: "→",
}

const NAMED: Readonly<Record<string, string>> = {
  enter: "c.keybind.enter",
  return: "c.keybind.enter",
  esc: "c.keybind.esc",
  escape: "c.keybind.esc",
  tab: "c.keybind.tab",
  space: "c.keybind.space",
  backspace: "c.keybind.backspace",
  delete: "c.keybind.delete",
  del: "c.keybind.delete",
}

/**
 * Display parts of one key, as the app shows shortcuts: symbols for modifiers on macOS, words elsewhere, and "Mod" as
 * ⌘ or Ctrl. (The SDK's `keybinds.keys` would do this, but the Host does not expose it; see src/gui/host.ts.)
 */
function keyPart(raw: string, t: Host["t"]): KeyPart {
  const key = raw.trim()
  const lower = key.toLowerCase()
  const word = (name: string): KeyPart => {
    const text = t(name)
    return { shown: text, spoken: text }
  }
  const mac = (symbol: string, name: string, other: string): KeyPart =>
    IS_MAC ? { shown: symbol, spoken: t(name) } : word(other)

  switch (lower) {
    case "mod":
      return mac("⌘", "c.keybind.command", "c.keybind.ctrl")
    case "cmd":
    case "command":
    case "meta":
    case "super":
    case "win":
      return mac("⌘", "c.keybind.command", "c.keybind.meta")
    case "ctrl":
    case "control":
      return mac("⌃", "c.keybind.control", "c.keybind.ctrl")
    case "alt":
    case "opt":
    case "option":
      return mac("⌥", "c.keybind.option", "c.keybind.alt")
    case "shift":
      return mac("⇧", "c.keybind.shift", "c.keybind.shift")
  }
  const arrow = ARROWS[lower]
  if (arrow) return { shown: arrow, spoken: arrow }
  const named = NAMED[lower]
  if (named) return word(named)
  const shown = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
  return { shown, spoken: shown }
}

/** The non-blank keys of a Keybind's `keys`, at most `max` of them, and how many it has in all. */
function keybindKeys(raw: unknown, max: number): { readonly keys: string[]; readonly total: number } {
  // A sloppy "Mod+K" string instead of ["Mod", "K"].
  if (typeof raw === "string") return splitKeys(raw, max)
  const { items, total } = firstItems(raw, max, (key) => {
    const text = str(key)
    return text.trim() === "" ? undefined : text
  })
  return { keys: items, total }
}

const Keybind: GenuiComponent<"Keybind"> = (ctx) => {
  const host = useHost()
  // At most ITEM_LISTS.Keybind.max keys (src/gui/costs.ts, which the render budget charges); the rest is said.
  const keys = createMemo(() => keybindKeys(ctx.props.keys, ITEM_LISTS.Keybind.max))
  const parts = createMemo(() => keys().keys.map((key) => keyPart(key, host.t)))
  const shown = createMemo(() => parts().map((part) => part.shown))
  const cut = useListCut(ctx, "Keybind", () => ({ shown: keys().keys.length, total: keys().total }))

  return (
    <Show when={parts().length > 0}>
      <kbd data-gu="keybind">
        <span data-gu-sr="">
          {host.t("c.keybind.label", {
            keys: parts()
              .map((part) => part.spoken)
              .join("+"),
          })}
        </span>
        <span data-slot="keys" aria-hidden="true">
          <host.ui.Keybind keys={shown()} />
        </span>
      </kbd>
      <CutNote text={cut()} inline />
    </Show>
  )
}

const Icon: GenuiComponent<"Icon"> = (ctx) => {
  const { ui } = useHost()
  const name = () => {
    const value: unknown = ctx.props.name
    return isIconName(value) ? value : undefined
  }
  const tone = () => {
    const value: unknown = ctx.props.tone
    return value === undefined ? undefined : oneOf(value, TONES, "neutral")
  }
  const size = () => oneOf(ctx.props.size, ["small", "normal", "large"] as const, "normal")
  return (
    <Show when={name()}>
      {(icon) => (
        <span data-gu="icon" data-tone={tone()} data-size={size()} aria-hidden="true">
          <ui.Icon name={icon()} size={size()} />
        </span>
      )}
    </Show>
  )
}

type ContentName = Extract<
  ComponentName,
  "Heading" | "Text" | "Markdown" | "Code" | "Badge" | "Alert" | "Keybind" | "Icon"
>

export const contentComponents = {
  Heading,
  Text,
  Markdown,
  Code,
  Badge,
  Alert,
  Keybind,
  Icon,
} satisfies { [K in ContentName]: GenuiComponent<K> }
