import { createMemo, createSignal, Index, Match, Show, Switch } from "solid-js"
import { getByPath } from "@json-render/core"
import { useStateStore } from "@json-render/solid"
import { isIconName } from "../../catalog/icons.ts"
import { isRemoteImage, safeUrl, urlHost } from "../../protocol/url.ts"
import { MAX_TABLE_COLUMNS, tableRows, tableWidth } from "../costs.ts"
import { useHost, useSurface, type Host } from "../host.ts"
import { tableCut } from "../issues.ts"
import { askOutward } from "../outward.ts"
import { useActivation } from "./inputs.tsx"
import {
  amount,
  bool,
  display,
  list,
  num,
  oneOf,
  str,
  trackOverflow,
  uid,
  useCut,
  type GenuiComponent,
} from "./shared.tsx"

// Data components: Table, Progress, Skeleton, Spinner, Stat, Image, Avatar. Styles: src/gui/styles/data.css.
// GuardedImage and statePath are shared with overlay.tsx (Carousel, Dialog, Drawer).

const TONES = ["neutral", "info", "success", "warning", "danger"] as const
const SIZES = ["small", "normal", "large"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])

/**
 * A model-written state path prop (`selectionPath`, `openPath`) as a JSON pointer, or undefined when it cannot be one.
 * A missing leading slash is added ("dialogOpen" means "/dialogOpen"); prototype keys are refused, as the patch
 * applier refuses them.
 */
export function statePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed === "/") return undefined
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const segments = path.slice(1).split("/")
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.replace(/~1/g, "/").replace(/~0/g, "~")))) {
    return undefined
  }
  return path
}

const formatters = new Map<string, Intl.NumberFormat>()

/** A cached Intl.NumberFormat in the runtime's locale. */
export function numberFormat(options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = JSON.stringify(options)
  let format = formatters.get(key)
  if (!format) {
    try {
      format = new Intl.NumberFormat(undefined, options)
    } catch {
      format = new Intl.NumberFormat()
    }
    formatters.set(key, format)
  }
  return format
}

// ---------------------------------------------------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------------------------------------------------

type Align = "start" | "center" | "end"

interface TableColumn {
  readonly key: string
  readonly label: string
  readonly align?: Align
  /** Position in the spec's columns, which is where array rows keep this column's cell. */
  readonly index: number
}

const ALIGNS = ["start", "center", "end"] as const
// Cells that mean "no value" and so do not decide whether a column is numeric.
const EMPTY_CELLS = new Set(["", "-", "–", "—", "n/a", "N/A"])
// "1,234", "-3.5", "12%", "$4.20", "1.2K", "250 ms": right-aligned like numbers. Dates and versions with dashes are not.
const NUMERIC = /^[-+−]?[$€£¥₹]?\s?\d[\d,.\s]*(?:%|‰|[kKMBGT]|ms|s|x|×)?$/

/** Lowercase letters and digits only, so "Service name" finds a row's `service_name`. */
const loose = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

/** The columns a Table shows: at most MAX_TABLE_COLUMNS (src/gui/costs.ts counts them the same way). */
function tableColumns(raw: unknown, rows: readonly unknown[]): TableColumn[] {
  const columns: TableColumn[] = []
  for (const [index, column] of list(raw).entries()) {
    if (columns.length >= MAX_TABLE_COLUMNS) break
    if (typeof column === "string" || typeof column === "number") {
      const label = str(column)
      columns.push({ key: label, label, index })
    } else if (isRecord(column)) {
      const key = str(column.key) || str(column.label)
      if (!key) continue
      const align = ALIGNS.includes(column.align as Align) ? (column.align as Align) : undefined
      columns.push({ key, label: str(column.label) || key, align, index })
    }
  }
  if (columns.length > 0) return columns

  // No columns: take them from the rows, keys of object rows in first-seen order, or positions of array rows.
  const keys = new Set<string>()
  let width = 0
  for (const row of rows.slice(0, 50)) {
    if (Array.isArray(row)) width = Math.max(width, row.length)
    else if (isRecord(row)) for (const key of Object.keys(row)) keys.add(key)
  }
  if (keys.size > 0) return [...keys].slice(0, MAX_TABLE_COLUMNS).map((key, index) => ({ key, label: key, index }))
  return Array.from({ length: Math.min(width, MAX_TABLE_COLUMNS) }, (_, index) => ({
    key: String(index),
    label: "",
    index,
  }))
}

/** How many columns the spec's table has in all, to say how many it does not show. */
function allColumns(raw: unknown, rows: readonly unknown[]): number {
  const named = list(raw).filter(
    (column) =>
      typeof column === "string" ||
      typeof column === "number" ||
      (isRecord(column) && !!(str(column.key) || str(column.label))),
  ).length
  if (named > 0) return named
  const keys = new Set<string>()
  let width = 0
  for (const row of rows.slice(0, 50)) {
    if (Array.isArray(row)) width = Math.max(width, row.length)
    else if (isRecord(row)) for (const key of Object.keys(row)) keys.add(key)
  }
  return keys.size > 0 ? keys.size : width
}

function cellValue(row: unknown, column: TableColumn): unknown {
  if (Array.isArray(row)) return row[column.index]
  if (!isRecord(row)) return column.index === 0 ? row : undefined
  if (Object.hasOwn(row, column.key)) return row[column.key]
  if (Object.hasOwn(row, column.label)) return row[column.label]
  const key = loose(column.key)
  const label = loose(column.label)
  for (const name of Object.keys(row)) {
    const candidate = loose(name)
    if (candidate && (candidate === key || candidate === label)) return row[name]
  }
  return undefined
}

const isEmptyCell = (value: unknown) =>
  value === null || value === undefined || (typeof value === "string" && EMPTY_CELLS.has(value.trim()))

/**
 * A short value without spaces, such as an identifier ("api-gateway", "us-east-1") or a version: kept on one line, as
 * the browser would otherwise break it at every hyphen in a narrow column. Longer values still wrap.
 */
const unbreakable = (text: string) => text.length > 0 && text.length <= 32 && !/\s/.test(text)

const isNumericCell = (value: unknown) =>
  typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && NUMERIC.test(value.trim())

function isNumericColumn(cells: readonly (readonly unknown[])[], column: number): boolean {
  let seen = false
  for (const row of cells) {
    const value = row[column]
    if (isEmptyCell(value)) continue
    if (!isNumericCell(value)) return false
    seen = true
  }
  return seen
}

/**
 * The app's data table (the timeline's Markdown table): a muted frame holding the header, around a raised body. With
 * `selectionPath` it is a single-select grid: rows take focus (arrow keys move between them), and a click, Enter or
 * Space writes the row's index to the path and fires `select`.
 */
const Table: GenuiComponent<"Table"> = (ctx) => {
  const host = useHost()
  const store = useStateStore()
  const activate = useActivation(ctx)

  // At most MAX_TABLE_ROWS rows and MAX_TABLE_CELLS cells (src/gui/costs.ts, which the render budget charges).
  const allRows = createMemo(() => list(ctx.props.rows))
  const rows = createMemo(() => {
    const all = allRows()
    return all.slice(0, tableRows(all.length, Math.max(1, tableWidth(ctx.props.columns, all))))
  })
  const columns = createMemo(() => tableColumns(ctx.props.columns, rows()))
  // What the table leaves out, said under it and reported to the agent.
  const counts = createMemo(
    () => {
      const total = allColumns(ctx.props.columns, allRows())
      return { rows: rows().length, totalRows: allRows().length, columns: columns().length, totalColumns: total }
    },
    undefined,
    {
      equals: (a, b) =>
        a.rows === b.rows &&
        a.totalRows === b.totalRows &&
        a.columns === b.columns &&
        a.totalColumns === b.totalColumns,
    },
  )
  const isCut = () => counts().rows < counts().totalRows || counts().columns < counts().totalColumns
  const cut = () => {
    const { rows, totalRows, columns, totalColumns } = counts()
    return isCut()
      ? host.t("c.table.cut", {
          rows: amount(rows),
          totalRows: amount(totalRows),
          columns: amount(columns),
          totalColumns: amount(totalColumns),
        })
      : ""
  }
  useCut(ctx, () => {
    const { rows, totalRows, columns, totalColumns } = counts()
    return isCut() ? tableCut(rows, totalRows, columns, totalColumns) : undefined
  })
  const values = createMemo(() => {
    const cols = columns()
    return rows().map((row) => cols.map((column) => cellValue(row, column)))
  })
  const cells = createMemo(() => values().map((row) => row.map(display)))
  const aligns = createMemo(() =>
    columns().map((column, index) => column.align ?? (isNumericColumn(values(), index) ? "end" : "start")),
  )
  const header = () => columns().some((column) => column.label !== "")
  const caption = () => str(ctx.props.caption).trim()
  const emptyText = () => (ctx.loading ? "" : str(ctx.props.emptyText).trim() || host.t("c.table.empty"))

  const path = createMemo(() => statePath(ctx.props.selectionPath))
  const selectable = () => !!path()
  const selected = createMemo(() => {
    const target = path()
    if (!target) return -1
    const value = getByPath(store.state, target)
    return typeof value === "number" && Number.isInteger(value) ? value : -1
  })

  // Roving focus: one row is in the tab order, the focused one, else the selected one, else the first.
  const [focused, setFocused] = createSignal<number>()
  const current = () => {
    const count = cells().length
    const index = focused() ?? selected()
    return index >= 0 && index < count ? index : 0
  }

  const select = (index: number) => {
    const target = path()
    if (!target) return
    store.set(target, index)
    void activate("select")
  }

  const onRowKeyDown = (event: KeyboardEvent, index: number) => {
    const row = event.currentTarget as HTMLElement
    const focus = (target: Element | null | undefined) => {
      event.preventDefault()
      if (target instanceof HTMLElement) target.focus()
    }
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault()
        select(index)
        break
      case "ArrowDown":
        focus(row.nextElementSibling)
        break
      case "ArrowUp":
        focus(row.previousElementSibling)
        break
      case "Home":
        focus(row.parentElement?.firstElementChild)
        break
      case "End":
        focus(row.parentElement?.lastElementChild)
        break
    }
  }

  return (
    <div data-gu="table" data-selectable={selectable() ? "" : undefined} ref={trackOverflow}>
      <table role={selectable() ? "grid" : undefined} aria-readonly={selectable() ? "true" : undefined}>
        <Show when={caption()}>
          <caption data-slot="caption">{caption()}</caption>
        </Show>
        <Show when={header()}>
          <thead>
            <tr>
              <Index each={columns()}>
                {(column, index) => (
                  <th scope="col" data-align={aligns()[index]}>
                    {column().label}
                  </th>
                )}
              </Index>
            </tr>
          </thead>
        </Show>
        <tbody>
          <Show
            when={cells().length > 0}
            fallback={
              <tr data-slot="empty">
                <td colSpan={Math.max(1, columns().length)}>{emptyText()}</td>
              </tr>
            }
          >
            <Index each={cells()}>
              {(row, index) => (
                <tr
                  data-selected={selected() === index ? "" : undefined}
                  aria-selected={selectable() ? (selected() === index ? "true" : "false") : undefined}
                  tabIndex={selectable() ? (current() === index ? 0 : -1) : undefined}
                  onClick={selectable() ? () => select(index) : undefined}
                  onKeyDown={selectable() ? (event) => onRowKeyDown(event, index) : undefined}
                  onFocus={selectable() ? () => setFocused(index) : undefined}
                >
                  <Index each={row()}>
                    {(cell, column) => (
                      <td
                        data-align={aligns()[column]}
                        data-numeric={aligns()[column] === "end" ? "" : undefined}
                        data-nowrap={unbreakable(cell()) ? "" : undefined}
                      >
                        {cell()}
                      </td>
                    )}
                  </Index>
                </tr>
              )}
            </Index>
          </Show>
        </tbody>
      </table>
      <Show when={cut()}>
        <p data-slot="cut">{cut()}</p>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Progress, Skeleton, Spinner
// ---------------------------------------------------------------------------------------------------------------------

/** components/progress.css: a label row over an 8px pill track. A missing value shows the indeterminate sweep. */
const Progress: GenuiComponent<"Progress"> = (ctx) => {
  const id = uid("progress")
  const max = () => {
    const value = num(ctx.props.max, 100)
    return value > 0 ? value : 100
  }
  const value = () => {
    const raw = num(ctx.props.value, Number.NaN)
    return Number.isFinite(raw) ? Math.min(max(), Math.max(0, raw)) : undefined
  }
  const indeterminate = () => value() === undefined
  const ratio = () => (value() ?? 0) / max()
  const label = () => str(ctx.props.label).trim()
  const showValue = () => bool(ctx.props.showValue, !!label()) && !indeterminate()
  const valueText = () => {
    const current = value()
    if (current === undefined) return ""
    if (max() === 100) return numberFormat({ style: "percent", maximumFractionDigits: 0 }).format(ratio())
    const format = numberFormat({ maximumFractionDigits: 2 })
    return `${format.format(current)} / ${format.format(max())}`
  }

  return (
    <div
      data-gu="progress"
      data-tone={oneOf(ctx.props.tone, TONES, "neutral")}
      data-indeterminate={indeterminate() ? "" : undefined}
    >
      <Show when={label() || showValue()}>
        <div data-slot="header">
          <span data-slot="label" id={id}>
            {label()}
          </span>
          <Show when={showValue()}>
            <span data-slot="value" aria-hidden="true">
              {valueText()}
            </span>
          </Show>
        </div>
      </Show>
      <div
        data-slot="track"
        role="progressbar"
        aria-labelledby={label() ? id : undefined}
        aria-valuemin={0}
        aria-valuemax={max()}
        aria-valuenow={value()}
        aria-valuetext={indeterminate() ? undefined : valueText()}
      >
        <div data-slot="fill" style={{ "--_fill": `${(ratio() * 100).toFixed(2)}%` }} />
      </div>
    </div>
  )
}

// A CSS length the model may set: a plain number (pixels) or a number with a common unit. Anything else is ignored,
// so a prop can never inject other CSS.
const LENGTH = /^(\d{1,4}(?:\.\d+)?)(px|%|rem|em|ch|lh|vw)?$/

function cssLength(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? `${Math.min(value, 4000)}px` : undefined
  if (typeof value !== "string") return undefined
  const match = LENGTH.exec(value.trim())
  if (!match) return undefined
  return `${match[1]}${match[2] ?? "px"}`
}

/** A placeholder block, or `lines` text-like bars, with a slow shimmer (none with reduced motion). */
const Skeleton: GenuiComponent<"Skeleton"> = (ctx) => {
  const host = useHost()
  const lines = () => {
    const value = Math.round(num(ctx.props.lines, 0))
    return value >= 1 ? Math.min(value, 12) : 0
  }
  const bars = createMemo(() => Array.from({ length: Math.max(1, lines()) }, (_, index) => index))
  return (
    <div
      data-gu="skeleton"
      data-lines={lines() > 0 ? "" : undefined}
      aria-busy="true"
      style={{ "--_w": cssLength(ctx.props.width), "--_h": cssLength(ctx.props.height) }}
    >
      <span data-gu-sr="">{host.t("c.skeleton.loading")}</span>
      <Index each={bars()}>{() => <span data-slot="bar" aria-hidden="true" />}</Index>
    </div>
  )
}

/** The app's loading indicator (`ui.Loader`) with an optional label; announced politely. */
const Spinner: GenuiComponent<"Spinner"> = (ctx) => {
  const host = useHost()
  const label = () => str(ctx.props.label).trim()
  const size = () => oneOf(ctx.props.size, SIZES, "normal")
  return (
    <div data-gu="spinner" data-size={size()} role="status">
      <span data-slot="loader" aria-hidden="true">
        <host.ui.Loader size={size()} />
      </span>
      <Show when={label()} fallback={<span data-gu-sr="">{host.t("c.spinner.loading")}</span>}>
        <span data-slot="label">{label()}</span>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Stat
// ---------------------------------------------------------------------------------------------------------------------

const TRENDS = ["up", "down", "neutral"] as const

/** The trend a change implies when the spec gives none: "+8%" is up, "-3" is down, anything else neutral. */
function inferTrend(change: string): (typeof TRENDS)[number] {
  const trimmed = change.trim()
  if (/^[+▲↑]/.test(trimmed)) return "up"
  if (/^[-−▼↓]/.test(trimmed)) return "down"
  return "neutral"
}

/**
 * A key metric tile: muted label, large value, and a change colored by trend with an arrow. It carries the card
 * frame so a Grid of stats reads as a dashboard row; inside a Card it drops the frame (data.css).
 */
const Stat: GenuiComponent<"Stat"> = (ctx) => {
  const host = useHost()
  const label = () => str(ctx.props.label)
  const value = () => display(ctx.props.value)
  const change = () => str(ctx.props.change).trim()
  const trend = () => oneOf(ctx.props.trend, TRENDS, inferTrend(change()))
  const description = () => str(ctx.props.description).trim()
  const icon = () => (isIconName(ctx.props.icon) ? ctx.props.icon : undefined)

  return (
    <div data-gu="stat" data-trend={trend()}>
      <div data-slot="header">
        <span data-slot="label">{label()}</span>
        <Show when={icon()}>
          {(name) => (
            <span data-slot="icon" aria-hidden="true">
              <host.ui.Icon name={name()} size="small" />
            </span>
          )}
        </Show>
      </div>
      <div data-slot="value">{value()}</div>
      <Show when={change() || description()}>
        <div data-slot="footer">
          <Show when={change()}>
            <span data-slot="change">
              <span data-slot="trend-icon" aria-hidden="true">
                <host.ui.Icon name={trend() === "neutral" ? "minus" : "arrow-up"} size="small" />
              </span>
              <span data-gu-sr="">{`${host.t(`c.stat.${trend()}`)}: `}</span>
              {change()}
            </span>
          </Show>
          <Show when={description()}>
            <span data-slot="description">{description()}</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Image, Avatar
// ---------------------------------------------------------------------------------------------------------------------

// Remote image URLs the user chose to load in this window. Shared by every surface, so loading an image once shows it
// again after its timeline row remounts, and in other components (Avatar, Carousel) that use the same URL.
const [approvedImages, setApprovedImages] = createSignal<ReadonlySet<string>>(new Set())

const approveImage = (url: string) => setApprovedImages((previous) => new Set(previous).add(url))

/** Whether an image URL (already through `safeUrl`) may load now: data: images always, remote ones per settings. */
export const imageAllowed = (host: Host, url: string) =>
  !isRemoteImage(url) || host.prefs().remoteImages || approvedImages().has(url)

/** A pixel dimension prop, or undefined unless it is a sensible positive number. */
const dimension = (value: unknown) => {
  const parsed = num(value, Number.NaN)
  return parsed >= 1 ? Math.min(Math.round(parsed), 4000) : undefined
}

export interface GuardedImageProps {
  readonly src: unknown
  readonly alt: string
  readonly fit?: "cover" | "contain"
}

/**
 * An image under the surface's URL policy, filling its parent: a refused URL (not https or data:image) shows an inert
 * placeholder with the alt text; a remote image waits for a click on "Load image from <host>" unless the settings
 * allow remote images; a failed load shows the placeholder again. Never renders model text as HTML.
 *
 * Loading sends the whole URL, which a spec may build from what the user typed, so the click goes through the same
 * confirm policy as outward actions (by default: a confirm with the full address on untrusted surfaces), and the button
 * shows the full address on hover.
 */
export function GuardedImage(props: GuardedImageProps) {
  const host = useHost()
  const surface = useSurface()
  const url = createMemo(() => safeUrl(props.src, "image"))
  let asking = false
  const load = async (src: string) => {
    if (asking) return
    asking = true
    try {
      const ok = await askOutward(host, surface, {
        title: host.t("confirm.loadImage", { host: urlHost(src) }),
        detail: src,
        detailLabel: host.t("confirm.label.address"),
        confirmLabel: host.t("confirm.load"),
      })
      if (ok) approveImage(src)
    } finally {
      asking = false
    }
  }
  const [failed, setFailed] = createSignal<string>()
  const state = () => {
    const current = url()
    if (!current) return "refused"
    if (failed() === current) return "failed"
    return imageAllowed(host, current) ? "show" : "ask"
  }
  const alt = () => props.alt.trim()

  const placeholder = (note: string) => (
    <div data-gu-image="placeholder" role="img" aria-label={alt() || host.t("c.image.untitled")}>
      <span data-slot="icon" aria-hidden="true">
        <host.ui.Icon name="outline-photo" size="normal" />
      </span>
      <Show when={alt()}>
        <span data-slot="alt" aria-hidden="true">
          {alt()}
        </span>
      </Show>
      <span data-slot="note" aria-hidden="true">
        {note}
      </span>
    </div>
  )

  return (
    <Switch>
      <Match when={state() === "show" && url()}>
        {(src) => (
          <img
            data-gu-image="img"
            data-fit={props.fit ?? "cover"}
            src={src()}
            alt={alt()}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setFailed(src())}
          />
        )}
      </Match>
      <Match when={state() === "ask" && url()}>
        {(src) => (
          <button type="button" data-gu-image="load" title={src()} onClick={() => void load(src())}>
            <span data-slot="icon" aria-hidden="true">
              <host.ui.Icon name="outline-photo" size="normal" />
            </span>
            <span data-slot="label">{host.t("c.image.load", { host: urlHost(src()) })}</span>
            <Show when={alt()}>
              <span data-slot="alt">{alt()}</span>
            </Show>
          </button>
        )}
      </Match>
      <Match when={state() === "failed"}>{placeholder(host.t("c.image.failed"))}</Match>
      <Match when={state() === "refused"}>{placeholder(host.t("c.image.unavailable"))}</Match>
    </Switch>
  )
}

/**
 * An image with optional size, fit and caption. width/height are pixels; with both, the box keeps their ratio and
 * shrinks to the surface width.
 */
const Image: GenuiComponent<"Image"> = (ctx) => {
  const width = () => dimension(ctx.props.width)
  const height = () => dimension(ctx.props.height)
  const caption = () => str(ctx.props.caption).trim()
  const fit = () => oneOf(ctx.props.fit, ["cover", "contain"] as const, "cover")
  const box = () => (width() && height() ? "ratio" : width() ? "width" : height() ? "height" : "natural")

  return (
    <figure
      data-gu="image"
      data-box={box()}
      style={{
        "--_w": width() ? `${width()}px` : undefined,
        "--_h": height() && !width() ? `${height()}px` : undefined,
        "--_ratio": width() && height() ? `${width()} / ${height()}` : undefined,
      }}
    >
      <div data-slot="media">
        <GuardedImage src={ctx.props.src} alt={str(ctx.props.alt)} fit={fit()} />
      </div>
      <Show when={caption()}>
        <figcaption data-slot="caption">{caption()}</figcaption>
      </Show>
    </figure>
  )
}

let segmenter: Intl.Segmenter | undefined | null

/** The first user-perceived character, so an emoji or accented letter is not split. */
function firstGrapheme(value: string): string {
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    } catch {
      segmenter = null
    }
  }
  if (segmenter) {
    for (const part of segmenter.segment(value)) return part.segment
  }
  return Array.from(value)[0] ?? ""
}

/** "Ada Lovelace" → "AL", "ada" → "A", "grace.hopper@navy.mil" → "GH". */
export function initials(name: string): string {
  const trimmed = name.trim()
  const base = !/\s/.test(trimmed) && trimmed.includes("@") ? (trimmed.split("@")[0] ?? "") : trimmed
  const words = base.split(/[\s._-]+/u).filter(Boolean)
  const first = words[0]
  if (!first) return "?"
  const last = words.length > 1 ? words[words.length - 1]! : ""
  return (firstGrapheme(first) + (last ? firstGrapheme(last) : "")).toLocaleUpperCase()
}

/** A stable categorical color (1-6) for a name, so the same person keeps their color everywhere. */
export function nameColor(name: string): number {
  let hash = 5381
  for (let index = 0; index < name.length; index++) hash = ((hash << 5) + hash + name.charCodeAt(index)) | 0
  return ((hash >>> 0) % 6) + 1
}

/** The app's avatar: initials on a categorical color, or an image when it is safe and remote images are allowed. */
const Avatar: GenuiComponent<"Avatar"> = (ctx) => {
  const host = useHost()
  const name = () => str(ctx.props.name).trim()
  const url = createMemo(() => safeUrl(ctx.props.src, "image"))
  const [failed, setFailed] = createSignal<string>()
  const image = () => {
    const current = url()
    return current && failed() !== current && imageAllowed(host, current) ? current : undefined
  }

  return (
    <span
      data-gu="avatar"
      data-size={oneOf(ctx.props.size, SIZES, "normal")}
      data-color={nameColor(name())}
      data-image={image() ? "" : undefined}
      role="img"
      aria-label={name() || undefined}
      title={name() || undefined}
    >
      <Show
        when={image()}
        fallback={
          <span data-slot="initials" aria-hidden="true">
            {initials(name())}
          </span>
        }
      >
        {(src) => (
          <img
            data-slot="image"
            src={src()}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setFailed(src())}
          />
        )}
      </Show>
    </span>
  )
}

export const dataComponents = { Table, Progress, Skeleton, Spinner, Stat, Image, Avatar } satisfies {
  [K in "Table" | "Progress" | "Skeleton" | "Spinner" | "Stat" | "Image" | "Avatar"]: GenuiComponent<K>
}
