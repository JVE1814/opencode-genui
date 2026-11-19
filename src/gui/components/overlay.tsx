import {
  children as resolveChildren,
  createEffect,
  createMemo,
  createSignal,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js"
import { useStateBinding } from "@json-render/solid"
import { useHost, useSurface } from "../host.ts"
import { hasIntent } from "../outward.ts"
import { MarkdownText } from "./content.tsx"
import { GuardedImage, statePath } from "./data.tsx"
import { list, str, uid, type GenuiComponent } from "./shared.tsx"

// Overlay components: Dialog, Drawer, Tooltip, Popover, Carousel. Styles: src/gui/styles/overlay.css.
// Dialog and Drawer are native <dialog> elements shown with showModal(), Popover is a native popover="auto" panel
// placed with CSS anchor positioning: both render in the top layer, so no ancestor (a timeline row, the sidebar)
// clips them, and the platform supplies focus trapping, Escape and light dismiss.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether resolved children hold anything that renders. */
const hasContent = (nodes: readonly unknown[]) =>
  nodes.some((node) => node !== null && node !== undefined && node !== "")

const prefersReducedMotion = () => {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce") return true
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

// ---------------------------------------------------------------------------------------------------------------------
// Dialog, Drawer
// ---------------------------------------------------------------------------------------------------------------------

interface ModalContext {
  readonly props: { readonly title?: unknown; readonly description?: unknown; readonly openPath?: unknown }
  readonly children?: JSX.Element
}

/**
 * A modal shown while the boolean at state path `openPath` is true. Escape, a click on the backdrop and the close
 * button write false there; writing false from elsewhere (a setState action) closes it. The path is reactive: when the
 * spec changes it, the modal follows the new path's value.
 *
 * On an untrusted surface (a block in tool output or a previewed file) a modal opens only while the surface dispatches
 * an activation of one of its controls (a press, a pick, Enter in a field, a choice; see `withIntent` in
 * src/gui/outward.ts): never from the spec's initial state, a watch, focus or blur (tabbing through a field), since a
 * model-written modal over the whole window is a phishing tool. An open it refuses writes false back, so the user's own
 * press can open it later. The modal then says where it comes from.
 */
function modal(ctx: ModalContext, kind: "dialog" | "drawer") {
  const host = useHost()
  const surface = useSurface()
  const untrusted = surface?.trusted === false
  const id = uid(kind)
  const title = () => str(ctx.props.title)
  const description = () => str(ctx.props.description).trim()

  const path = createMemo(() => statePath(ctx.props.openPath))
  // useStateBinding takes a fixed path; re-creating it inside a memo rebinds when the path changes (the previous
  // binding is disposed with the memo's last run). Without a usable path the modal stays closed.
  const binding = createMemo(() => {
    const target = path()
    return target ? useStateBinding<unknown>(target) : undefined
  })
  const open = () => binding()?.[0]() === true
  const setOpen = (value: boolean) => {
    const current = binding()
    if (current && (current[0]() === true) !== value) current[1](value)
  }

  let dialog: HTMLDialogElement | undefined
  let disposed = false
  let downOnBackdrop = false
  onCleanup(() => {
    disposed = true
  })

  // showModal() needs the element in the document; an inline surface may render before the host attaches it.
  const show = (element: HTMLDialogElement, attempt = 0) => {
    if (disposed || element.open || !open()) return
    if (!element.isConnected) {
      if (attempt < 20 && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => show(element, attempt + 1))
      }
      return
    }
    if (untrusted && !hasIntent(surface)) {
      setOpen(false)
      return
    }
    try {
      element.showModal()
    } catch {
      // Already open without being modal, or the document refuses another modal; it stays as it is.
    }
  }

  createEffect(() => {
    const want = open()
    const element = dialog
    if (!element) return
    if (want) show(element)
    else if (element.open) element.close()
  })

  const close = () => {
    setOpen(false)
    if (dialog?.open) dialog.close()
  }

  // Clicks on the ::backdrop target the dialog itself, outside its box. A press that starts inside (selecting text
  // in a field) and ends outside must not close it, so the press has to start on the backdrop too.
  const onBackdrop = (event: MouseEvent) => {
    if (!dialog || event.target !== dialog) return false
    const rect = dialog.getBoundingClientRect()
    return (
      event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
    )
  }

  return (
    <dialog
      data-gu={kind}
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={
        [description() ? `${id}-description` : "", untrusted ? `${id}-untrusted` : ""].filter(Boolean).join(" ") ||
        undefined
      }
      onClose={() => {
        if (!disposed && open()) setOpen(false)
      }}
      onPointerDown={(event) => {
        downOnBackdrop = onBackdrop(event)
      }}
      onClick={(event) => {
        if (downOnBackdrop && onBackdrop(event)) close()
        downOnBackdrop = false
      }}
    >
      <div data-slot="surface">
        <header data-slot="header">
          <div data-slot="titles">
            <h2 data-slot="title" id={`${id}-title`}>
              {title()}
            </h2>
            <Show when={description()}>
              <p data-slot="description" id={`${id}-description`}>
                {description()}
              </p>
            </Show>
            <Show when={untrusted}>
              <p data-slot="untrusted" id={`${id}-untrusted`}>
                <span data-slot="icon" aria-hidden="true">
                  <host.ui.Icon name="shield" size="small" />
                </span>
                <span>{host.t("c.dialog.untrusted")}</span>
              </p>
            </Show>
          </div>
          <span data-slot="close">
            <host.ui.IconButton icon="close" label={host.t("c.dialog.close")} size="small" onClick={close} />
          </span>
        </header>
        <div data-slot="body">{ctx.children}</div>
      </div>
    </dialog>
  )
}

const Dialog: GenuiComponent<"Dialog"> = (ctx) => modal(ctx, "dialog")

const Drawer: GenuiComponent<"Drawer"> = (ctx) => modal(ctx, "drawer")

// ---------------------------------------------------------------------------------------------------------------------
// Tooltip, Popover
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The app's tooltip (`ui.Tooltip`) on the element's children, or on its text, which gets a dotted underline and takes
 * keyboard focus so the tooltip also shows on focus.
 */
const Tooltip: GenuiComponent<"Tooltip"> = (ctx) => {
  const host = useHost()
  const kids = resolveChildren(() => ctx.children)
  const nested = () => hasContent(kids.toArray())
  const content = () => str(ctx.props.content).trim()
  const text = () => str(ctx.props.text)

  const target = () => (
    <Show
      when={nested()}
      fallback={
        <span data-slot="text" tabIndex={content() ? 0 : undefined}>
          {text()}
        </span>
      }
    >
      <span data-slot="target">{kids()}</span>
    </Show>
  )

  return (
    <span data-gu="tooltip" data-mode={nested() ? "children" : "text"}>
      <Show when={content()} fallback={target()}>
        <host.ui.Tooltip value={content()}>{target()}</host.ui.Tooltip>
      </Show>
    </span>
  )
}

/**
 * A small neutral button (`ui.Button`) that opens a native popover="auto" panel: Markdown content, then children.
 * The button becomes the panel's invoker (popoverTargetElement), so the platform toggles it, reports aria-expanded,
 * closes it on Escape or an outside click and returns focus. Anchor positioning places it under the button and flips
 * it where there is no room; each instance has its own anchor name.
 */
const Popover: GenuiComponent<"Popover"> = (ctx) => {
  const host = useHost()
  const id = uid("popover")
  const kids = resolveChildren(() => ctx.children)
  const nested = () => hasContent(kids.toArray())
  const trigger = () => str(ctx.props.trigger).trim() || "…"
  const content = () => str(ctx.props.content).trim()

  let triggerBox: HTMLSpanElement | undefined
  let panel: HTMLDivElement | undefined
  let linked = false

  // ui.Button takes no popovertarget prop, so the invoker link is made on its rendered <button>.
  const link = () => {
    if (linked || !triggerBox || !panel) return linked
    const button = triggerBox.querySelector("button")
    if (button && "popoverTargetElement" in button) {
      try {
        button.popoverTargetElement = panel
        linked = true
      } catch {
        linked = false
      }
    }
    return linked
  }
  onMount(link)

  const isOpen = (element: HTMLElement) => {
    try {
      return element.matches(":popover-open")
    } catch {
      return false
    }
  }

  // The invoker toggles the panel after this click handler. If it did not (no link could be made, or the host's
  // button cancelled the click), toggle by hand; unlinked, an outside click then closes and reopens it, a known limit.
  const toggle = () => {
    if (!panel) return
    link()
    const before = isOpen(panel)
    setTimeout(() => {
      if (!panel || !panel.isConnected || isOpen(panel) !== before) return
      try {
        panel.togglePopover()
      } catch {
        // Not supported or not in the document.
      }
    })
  }

  return (
    <span data-gu="popover" style={{ "--_anchor": `--${id}` }}>
      <span data-slot="trigger" ref={triggerBox}>
        <host.ui.Button variant="neutral" size="small" onClick={toggle}>
          {trigger()}
        </host.ui.Button>
      </span>
      <div data-slot="panel" ref={panel} id={`${id}-panel`} popover="auto" role="dialog" aria-label={trigger()}>
        <Show when={content()}>
          <div data-slot="content">
            <MarkdownText text={content()} />
          </div>
        </Show>
        <Show when={nested()}>
          <div data-slot="body">{kids()}</div>
        </Show>
      </div>
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Carousel
// ---------------------------------------------------------------------------------------------------------------------

interface CarouselItem {
  readonly title: string
  readonly description: string
  readonly image: unknown
}

/**
 * A horizontal scroll-snap row of cards with previous/next buttons. The row takes focus: arrow keys move a card at a
 * time, Home and End jump to the ends. Images follow the Image rules (click to load remote ones unless allowed).
 */
const Carousel: GenuiComponent<"Carousel"> = (ctx) => {
  const host = useHost()
  const items = createMemo<CarouselItem[]>(() =>
    list(ctx.props.items)
      .filter(isRecord)
      .map((item) => ({ title: str(item.title), description: str(item.description), image: item.image })),
  )

  let viewport: HTMLDivElement | undefined
  const [atStart, setAtStart] = createSignal(true)
  const [atEnd, setAtEnd] = createSignal(true)

  const measure = () => {
    if (!viewport) return
    const max = viewport.scrollWidth - viewport.clientWidth
    // scrollLeft runs from 0 to -max in right-to-left layouts.
    const position = Math.abs(viewport.scrollLeft)
    setAtStart(position <= 1)
    setAtEnd(position >= max - 1)
  }

  let frame = 0
  const schedule = () => {
    if (frame || typeof requestAnimationFrame !== "function") return
    frame = requestAnimationFrame(() => {
      frame = 0
      measure()
    })
  }

  // The row renders only once there are items (they may stream in), so it is observed from its ref.
  const attach = (element: HTMLDivElement) => {
    viewport = element
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(schedule)
      observer.observe(element)
      onCleanup(() => observer.disconnect())
    }
    schedule()
  }
  onCleanup(() => {
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
  })
  createEffect(on(() => items().length, schedule, { defer: true }))

  /** One page: as many whole cards as fit, at least one. */
  const step = () => {
    const first = viewport?.querySelector<HTMLElement>(":scope > [data-slot='item']")
    if (!viewport || !first) return 0
    const gap = Number.parseFloat(getComputedStyle(viewport).columnGap) || 0
    const size = first.offsetWidth + gap
    return size > 0 ? Math.max(1, Math.floor((viewport.clientWidth + gap) / size)) * size : 0
  }

  /** Scrolls by pages; positive is rightwards on screen whatever the direction. */
  const scrollBy = (pages: number) =>
    viewport?.scrollBy({ left: pages * step(), behavior: prefersReducedMotion() ? "auto" : "smooth" })

  const rtl = () => !!viewport && getComputedStyle(viewport).direction === "rtl"

  const go = (where: "previous" | "next" | "start" | "end") => {
    if (!viewport) return
    const behavior = prefersReducedMotion() ? "auto" : "smooth"
    const sign = rtl() ? -1 : 1
    if (where === "start") viewport.scrollTo({ left: 0, behavior })
    else if (where === "end") viewport.scrollTo({ left: sign * viewport.scrollWidth, behavior })
    else scrollBy(where === "next" ? sign : -sign)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // Keys on a card's own controls (a "Load image" button) are theirs.
    if (event.target !== viewport) return
    const actions: Record<string, () => void> = {
      ArrowRight: () => scrollBy(1),
      ArrowLeft: () => scrollBy(-1),
      Home: () => go("start"),
      End: () => go("end"),
    }
    const action = actions[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  return (
    <div data-gu="carousel" role="group" aria-roledescription={host.t("c.carousel.roledescription")}>
      <Show
        when={items().length > 0}
        fallback={<p data-slot="empty">{ctx.loading ? "" : host.t("c.carousel.empty")}</p>}
      >
        <div
          data-slot="viewport"
          ref={attach}
          tabIndex={0}
          aria-label={host.t("c.carousel.label")}
          onScroll={schedule}
          onKeyDown={onKeyDown}
        >
          <Index each={items()}>
            {(item, index) => (
              <article
                data-slot="item"
                role="group"
                aria-roledescription={host.t("c.carousel.slide")}
                aria-label={host.t("c.carousel.position", { index: index + 1, count: items().length })}
              >
                <Show when={item().image !== undefined && item().image !== null && item().image !== ""}>
                  <div data-slot="media">
                    <GuardedImage src={item().image} alt={item().title} fit="cover" />
                  </div>
                </Show>
                <div data-slot="text">
                  <p data-slot="title">{item().title}</p>
                  <Show when={item().description}>
                    <p data-slot="description">{item().description}</p>
                  </Show>
                </div>
              </article>
            )}
          </Index>
        </div>
        <Show when={!(atStart() && atEnd())}>
          <div data-slot="controls">
            <host.ui.IconButton
              icon="chevron-left"
              label={host.t("c.carousel.previous")}
              variant="neutral"
              size="small"
              disabled={atStart()}
              onClick={() => go("previous")}
            />
            <host.ui.IconButton
              icon="chevron-right"
              label={host.t("c.carousel.next")}
              variant="neutral"
              size="small"
              disabled={atEnd()}
              onClick={() => go("next")}
            />
          </div>
        </Show>
      </Show>
    </div>
  )
}

export const overlayComponents = { Dialog, Drawer, Tooltip, Popover, Carousel } satisfies {
  [K in "Dialog" | "Drawer" | "Tooltip" | "Popover" | "Carousel"]: GenuiComponent<K>
}
