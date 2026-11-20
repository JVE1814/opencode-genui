import { createMemo, createSignal, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { MAX_CHART_POINTS as MAX_POINTS, MAX_CHART_SERIES as MAX_SERIES } from "../costs.ts"
import { useHost } from "../host.ts"
import { numberFormat } from "./data.tsx"
import { bool, display, list, num, oneOf, str, uid, type GenuiComponent } from "./shared.tsx"

// Chart: bar (grouped or stacked), line, area and donut as plain SVG. Styles: src/gui/styles/chart.css.
//
// Marks follow one quiet spec: bars at most 24px thick with 4px rounded data ends and square baselines, 2px lines,
// area fills as a light wash, 2px gaps between touching marks, hairline gridlines, text in text colors (never the
// series color). Colors are the categorical palette (--gu-cat-1..6) in series order. Every value is also in a visually
// hidden table, and keyboard users can step through the points with the arrow keys.

const TYPES = ["bar", "line", "area", "donut"] as const
type ChartType = (typeof TYPES)[number]

const DEFAULT_HEIGHT = 200
/** Average advance of a character at --gu-size-sm, to fit labels without measuring text. */
const CHAR = 7.2
const GAP = 2
const BAR_MAX = 24
const RADIUS = 4
const MARGIN_TOP = 8
const MARGIN_RIGHT = 8
const MARGIN_BOTTOM = 24
/** Below this inner radius a donut has no room for its center readout. */
const DONUT_CENTER_MIN = 30

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finite = (value: unknown): number | undefined => {
  const parsed = num(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Two decimals are plenty for SVG coordinates and keep path strings short. */
const f = (value: number) => Math.round(value * 100) / 100

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const truncate = (text: string, chars: number) =>
  text.length <= chars ? text : chars <= 1 ? "…" : `${text.slice(0, chars - 1).trimEnd()}…`

// ---------------------------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------------------------

export interface ChartSeries {
  readonly name: string
  /** One per label; undefined where the spec gave no finite number. */
  readonly values: readonly (number | undefined)[]
}

export interface ChartData {
  readonly labels: readonly string[]
  readonly series: readonly ChartSeries[]
  readonly count: number
}

/**
 * The spec's labels and series, made consistent: one value per label in every series (missing and non-numeric values
 * become gaps), at most MAX_SERIES series. Without labels, the longest series decides the count and labels are 1..n.
 */
export function chartData(labels: unknown, series: unknown, seriesName: (index: number) => string): ChartData {
  const raw = list(series).filter(isRecord).slice(0, MAX_SERIES)
  const names = list(labels).map((label) => display(label))
  const longest = raw.reduce((max, item) => Math.max(max, list(item.values).length), 0)
  const count = Math.min(MAX_POINTS, names.length > 0 ? names.length : longest)
  return {
    count,
    labels: Array.from({ length: count }, (_, index) => names[index] || String(index + 1)),
    series: raw.map((item, index) => {
      const values = list(item.values)
      return {
        name: str(item.name).trim() || seriesName(index + 1),
        values: Array.from({ length: count }, (_, point) => finite(values[point])),
      }
    }),
  }
}

export interface Ticks {
  readonly ticks: readonly number[]
  readonly min: number
  readonly max: number
  readonly decimals: number
}

/** Round axis ticks (steps of 1, 2, 2.5 or 5 times a power of ten) covering [min, max], about `target` intervals. */
export function niceTicks(min: number, max: number, target: number): Ticks {
  let lo = Number.isFinite(min) ? min : 0
  let hi = Number.isFinite(max) ? max : 1
  if (hi < lo) [lo, hi] = [hi, lo]
  if (hi === lo) {
    if (lo === 0) hi = 1
    else {
      const pad = Math.abs(lo) * 0.1
      lo = lo > 0 && lo - pad < 0 ? 0 : lo - pad
      hi = hi + pad
    }
  }
  const raw = (hi - lo) / Math.max(1, Math.round(target))
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude
  const fixed = step.toFixed(12).replace(/0+$/, "")
  const decimals = fixed.endsWith(".") ? 0 : fixed.length - fixed.indexOf(".") - 1
  const start = Math.floor(lo / step + 1e-9)
  const end = Math.ceil(hi / step - 1e-9)
  const ticks: number[] = []
  for (let index = start; index <= end && ticks.length < 50; index++)
    ticks.push(Number((index * step).toFixed(decimals)))
  return { ticks, min: ticks[0] ?? lo, max: ticks[ticks.length - 1] ?? hi, decimals }
}

const PREFIX_UNITS = /^[$€£¥₹₩₽]$/
const SUFFIX_UNITS = new Set(["%", "‰", "°", "x", "×", "°C", "°F"])

/** A formatted number with the spec's unit: "$12", "12%", "12 ms". */
export function withUnit(text: string, unit: string): string {
  if (!unit) return text
  if (PREFIX_UNITS.test(unit)) return /^[-−]/.test(text) ? `${text[0]}${unit}${text.slice(1)}` : `${unit}${text}`
  if (SUFFIX_UNITS.has(unit)) return `${text}${unit}`
  return `${text} ${unit}`
}

/** Units short enough to repeat on every axis tick; longer ones are shown once, in the header. */
const tickUnit = (unit: string) => (PREFIX_UNITS.test(unit) || SUFFIX_UNITS.has(unit) || unit.length <= 2 ? unit : "")

// ---------------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------------

/** A bar with a rounded data end and a square end on its base. `end` above `base` (smaller y) grows up. */
function barPath(x: number, width: number, base: number, end: number, radius: number): string {
  const height = Math.abs(base - end)
  if (height < 0.5 || width <= 0) return ""
  const r = f(Math.max(0, Math.min(radius, width / 2, height)))
  const right = x + width
  if (end <= base) {
    return `M${f(x)},${f(base)}V${f(end + r)}A${r},${r} 0 0 1 ${f(x + r)},${f(end)}H${f(right - r)}A${r},${r} 0 0 1 ${f(right)},${f(end + r)}V${f(base)}Z`
  }
  return `M${f(x)},${f(base)}V${f(end - r)}A${r},${r} 0 0 0 ${f(x + r)},${f(end)}H${f(right - r)}A${r},${r} 0 0 0 ${f(right)},${f(end - r)}V${f(base)}Z`
}

interface Mark {
  readonly series: number
  readonly d: string
}

interface BarMark extends Mark {
  readonly index: number
}

interface Point {
  readonly x: number
  readonly y: number
}

interface Cartesian {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly band: number
  readonly ticks: readonly { readonly y: number; readonly label: string }[]
  readonly baseline?: number
  readonly xLabels: readonly { readonly x: number; readonly text: string }[]
  readonly bars: readonly BarMark[]
  readonly areas: readonly Mark[]
  readonly lines: readonly Mark[]
  /** Points drawn as dots because no line reaches them (a value between two gaps). */
  readonly isolated: readonly (Point & { readonly series: number })[]
  /** Where each series' value sits at each index (the top of its stack), for the hover dots. */
  readonly points: readonly (readonly (Point | undefined)[])[]
  readonly center: (index: number) => number
}

interface CartesianInput {
  readonly data: ChartData
  readonly type: "bar" | "line" | "area"
  readonly stacked: boolean
  readonly width: number
  readonly height: number
  readonly formatTick: (value: number, ticks: Ticks) => string
}

/** The value domain: data extent, with zero for bars and areas (they grow from a baseline) and for most lines. */
function extent(data: ChartData, type: CartesianInput["type"], stacked: boolean): [number, number] {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  const see = (value: number) => {
    if (value < lo) lo = value
    if (value > hi) hi = value
  }
  for (let index = 0; index < data.count; index++) {
    if (stacked) {
      let positive = 0
      let negative = 0
      let running = 0
      for (const series of data.series) {
        const value = series.values[index] ?? 0
        if (type === "bar") {
          if (value > 0) positive += value
          else negative += value
        } else {
          running += value
          see(running)
        }
      }
      if (type === "bar") {
        see(positive)
        see(negative)
      }
    } else {
      for (const series of data.series) {
        const value = series.values[index]
        if (value !== undefined) see(value)
      }
    }
  }
  if (lo > hi) return [0, 1]
  if (type !== "line") return [Math.min(0, lo), Math.max(0, hi)]
  // Lines start at zero unless the values sit in a narrow band far from it (the rule spreadsheet charts use).
  if (lo >= 0 && hi - lo > hi / 6) return [0, hi]
  if (hi <= 0 && hi - lo > -lo / 6) return [lo, 0]
  return [lo, hi]
}

function cartesian(input: CartesianInput): Cartesian {
  const { data, type, stacked, width, height } = input
  const plotHeight = Math.max(16, height - MARGIN_TOP - MARGIN_BOTTOM)
  const [lo, hi] = extent(data, type, stacked)
  const scale = niceTicks(lo, hi, clamp(Math.floor(plotHeight / 36), 2, 8))
  const tickLabels = scale.ticks.map((value) => input.formatTick(value, scale))
  const longest = tickLabels.reduce((max, label) => Math.max(max, label.length), 1)
  const left = clamp(Math.ceil(longest * CHAR + 10), 24, Math.max(24, width * 0.4))
  const right = Math.max(left + 1, width - MARGIN_RIGHT)
  const top = MARGIN_TOP
  const bottom = top + plotHeight
  const span = scale.max - scale.min || 1
  const y = (value: number) => top + (1 - (value - scale.min) / span) * plotHeight
  const count = Math.max(1, data.count)
  const band = (right - left) / count
  const center = (index: number) => left + band * (index + 0.5)
  const zero = scale.min <= 0 && scale.max >= 0 ? y(0) : undefined
  const base = y(clamp(0, scale.min, scale.max))

  const ticks = scale.ticks.map((value, index) => ({ y: Math.round(y(value)) + 0.5, label: tickLabels[index] ?? "" }))

  // X labels: every `stride`-th label, so neighbours never overlap; each truncated to the room it has.
  const longestLabel = data.labels.reduce((max, label) => Math.max(max, Math.min(label.length, 16)), 1)
  const stride = Math.max(1, Math.ceil((longestLabel * CHAR + 8) / band))
  const room = Math.max(1, Math.floor((band * stride - 6) / CHAR))
  // A label at an edge is pulled inside the chart; one that would then touch its neighbour is left out.
  const xLabels: { x: number; text: string }[] = []
  let previousEnd = Number.NEGATIVE_INFINITY
  for (let index = 0; index < data.count; index += stride) {
    const text = truncate(data.labels[index] ?? "", room)
    const half = (text.length * CHAR) / 2
    const x = clamp(center(index), Math.min(half, width / 2), Math.max(width - half, width / 2))
    if (x - half < previousEnd + 4) continue
    previousEnd = x + half
    xLabels.push({ x, text })
  }

  const bars: BarMark[] = []
  const areas: Mark[] = []
  const lines: Mark[] = []
  const isolated: (Point & { series: number })[] = []
  const points: (Point | undefined)[][] = data.series.map(() => [])

  if (type === "bar" && stacked) {
    const thickness = Math.max(1, Math.min(BAR_MAX, band * 0.64))
    for (let index = 0; index < data.count; index++) {
      const x = center(index) - thickness / 2
      const values = data.series.map((series) => series.values[index] ?? 0)
      const lastPositive = values.findLastIndex((value) => value > 0)
      const lastNegative = values.findLastIndex((value) => value < 0)
      let positive = 0
      let negative = 0
      let firstPositive = true
      let firstNegative = true
      values.forEach((value, series) => {
        if (value === 0) return
        const up = value > 0
        const from = up ? positive : negative
        const to = from + value
        if (up) positive = to
        else negative = to
        const first = up ? firstPositive : firstNegative
        if (up) firstPositive = false
        else firstNegative = false
        const start = y(from)
        const end = y(to)
        // The 2px surface gap between stacked segments, taken from the segment's base side.
        const gap = first ? 0 : Math.min(GAP, Math.abs(end - start) / 2)
        const d = barPath(
          x,
          thickness,
          up ? start - gap : start + gap,
          end,
          series === (up ? lastPositive : lastNegative) ? RADIUS : 0,
        )
        if (d) bars.push({ series, index, d })
        points[series]![index] = { x: center(index), y: end }
      })
    }
  } else if (type === "bar") {
    const count = Math.max(1, data.series.length)
    const group = band * 0.72
    let thickness = Math.min(BAR_MAX, (group - GAP * (count - 1)) / count)
    let gap = GAP
    if (thickness < 2) {
      gap = 0
      thickness = Math.max(0.5, (band * 0.9) / count)
    }
    const total = thickness * count + gap * (count - 1)
    for (let index = 0; index < data.count; index++) {
      const start = center(index) - total / 2
      data.series.forEach((series, position) => {
        const value = series.values[index]
        if (value === undefined) return
        const x = start + position * (thickness + gap)
        const end = y(value)
        const d = barPath(x, thickness, base, end, RADIUS)
        if (d) bars.push({ series: position, index, d })
        points[position]![index] = { x: x + thickness / 2, y: end }
      })
    }
  } else {
    // Lines and areas. Stacked areas add up the series (gaps count as zero); otherwise gaps break the line.
    const running = Array.from({ length: data.count }, () => 0)
    data.series.forEach((series, position) => {
      const tops: (Point | undefined)[] = []
      const bottoms: Point[] = []
      for (let index = 0; index < data.count; index++) {
        const value = series.values[index]
        if (stacked) {
          const below = running[index]!
          const above = below + (value ?? 0)
          running[index] = above
          tops.push({ x: center(index), y: y(above) })
          bottoms.push({ x: center(index), y: y(below) })
        } else {
          tops.push(value === undefined ? undefined : { x: center(index), y: y(value) })
        }
      }
      points[position] = tops

      let line = ""
      let area = ""
      let run: Point[] = []
      const flush = () => {
        if (run.length === 1) isolated.push({ ...run[0]!, series: position })
        if (run.length > 1) {
          line += run.map((point, index) => `${index ? "L" : "M"}${f(point.x)},${f(point.y)}`).join("")
          if (!stacked) {
            const first = run[0]!
            const last = run[run.length - 1]!
            area += `${run.map((point, index) => `${index ? "L" : "M"}${f(point.x)},${f(point.y)}`).join("")}L${f(last.x)},${f(base)}L${f(first.x)},${f(base)}Z`
          }
        }
        run = []
      }
      for (const point of tops) {
        if (point) run.push(point)
        else flush()
      }
      flush()
      if (stacked && tops.length > 1) {
        const upper = tops.map((point, index) => `${index ? "L" : "M"}${f(point!.x)},${f(point!.y)}`).join("")
        const lower = bottoms
          .toReversed()
          .map((point) => `L${f(point.x)},${f(point.y)}`)
          .join("")
        area = `${upper}${lower}Z`
      }
      if (type === "area" && area) areas.push({ series: position, d: area })
      if (line) lines.push({ series: position, d: line })
    })
  }

  return {
    left,
    right,
    top,
    bottom,
    band,
    ticks,
    baseline: zero === undefined ? undefined : Math.round(zero) + 0.5,
    xLabels,
    bars,
    areas,
    lines,
    isolated,
    points,
    center,
  }
}

interface Slice {
  /** Index into the chart's labels, or -1 for the folded "Other" slice. */
  readonly index: number
  readonly label: string
  readonly value: number
  readonly share: number
  readonly start: number
  readonly end: number
}

/** Donut slices: positive values of the first series, the sixth and later folded into one "Other" slice. */
function donutSlices(data: ChartData, other: string): Slice[] {
  const values = data.series[0]?.values ?? []
  const items = data.labels.flatMap((label, index) => {
    const value = values[index]
    return value !== undefined && value > 0 ? [{ index, label, value }] : []
  })
  const kept =
    items.length > MAX_SERIES
      ? [
          ...items.slice(0, MAX_SERIES - 1),
          {
            index: -1,
            label: other,
            value: items.slice(MAX_SERIES - 1).reduce((sum, item) => sum + item.value, 0),
          },
        ]
      : items
  const total = kept.reduce((sum, item) => sum + item.value, 0)
  let angle = 0
  return kept.map((item) => {
    const share = total > 0 ? item.value / total : 0
    const start = angle
    angle += share * Math.PI * 2
    return { ...item, share, start, end: angle }
  })
}

/** An annular sector from angle `start` to `end` (radians, clockwise from 12 o'clock), with a 2px gap on each side. */
function slicePath(cx: number, cy: number, outer: number, inner: number, start: number, end: number, whole: boolean) {
  if (whole) {
    return `M${f(cx)},${f(cy - outer)}A${f(outer)},${f(outer)} 0 1 1 ${f(cx)},${f(cy + outer)}A${f(outer)},${f(outer)} 0 1 1 ${f(cx)},${f(cy - outer)}ZM${f(cx)},${f(cy - inner)}A${f(inner)},${f(inner)} 0 1 0 ${f(cx)},${f(cy + inner)}A${f(inner)},${f(inner)} 0 1 0 ${f(cx)},${f(cy - inner)}Z`
  }
  const padOuter = Math.min(GAP / 2 / outer, (end - start) / 4)
  const padInner = Math.min(GAP / 2 / inner, (end - start) / 4)
  const point = (radius: number, angle: number) =>
    `${f(cx + radius * Math.sin(angle))},${f(cy - radius * Math.cos(angle))}`
  const large = end - start > Math.PI ? 1 : 0
  return `M${point(outer, start + padOuter)}A${f(outer)},${f(outer)} 0 ${large} 1 ${point(outer, end - padOuter)}L${point(inner, end - padInner)}A${f(inner)},${f(inner)} 0 ${large} 0 ${point(inner, start + padInner)}Z`
}

// ---------------------------------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------------------------------

const Chart: GenuiComponent<"Chart"> = (ctx) => {
  const host = useHost()
  const id = uid("chart")

  const type = (): ChartType => oneOf(ctx.props.type, TYPES, "bar")
  const stacked = () => bool(ctx.props.stacked) && (type() === "bar" || type() === "area")
  const height = () => clamp(Math.round(num(ctx.props.height, DEFAULT_HEIGHT)), 80, 480)
  const title = () => str(ctx.props.title).trim()
  const unit = () => str(ctx.props.unit).trim().slice(0, 16)
  const headerUnit = () => (unit() && !tickUnit(unit()) ? unit() : "")

  const data = createMemo(() =>
    chartData(ctx.props.labels, ctx.props.series, (index) => host.t("c.chart.seriesName", { index })),
  )
  const slices = createMemo(() => (type() === "donut" ? donutSlices(data(), host.t("c.chart.other")) : []))
  const total = createMemo(() => slices().reduce((sum, slice) => sum + slice.value, 0))
  const empty = () =>
    type() === "donut"
      ? slices().length === 0
      : data().series.every((series) => series.values.every((value) => value === undefined))

  const format = (value: number) => withUnit(numberFormat({ maximumFractionDigits: 2 }).format(value), unit())
  const percent = (share: number) => numberFormat({ style: "percent", maximumFractionDigits: 1 }).format(share)
  const formatTick = (value: number, ticks: Ticks) => {
    const extent = Math.max(Math.abs(ticks.min), Math.abs(ticks.max))
    const format =
      extent >= 10_000
        ? numberFormat({ notation: "compact", maximumFractionDigits: 1 })
        : numberFormat({ minimumFractionDigits: ticks.decimals, maximumFractionDigits: ticks.decimals })
    return withUnit(format.format(value), tickUnit(unit()))
  }

  // Width follows the container, so text keeps its size: the SVG is drawn at the measured width, not scaled.
  const [width, setWidth] = createSignal(0)
  let body: HTMLDivElement | undefined
  onMount(() => {
    if (!body) return
    if (typeof ResizeObserver === "undefined") {
      setWidth(body.clientWidth || 480)
      return
    }
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(body)
    onCleanup(() => observer.disconnect())
  })

  const donutSize = () => Math.min(height(), width())
  const geometry = createMemo(() => {
    const kind = type()
    if (kind === "donut" || width() <= 0 || empty()) return undefined
    return cartesian({ data: data(), type: kind, stacked: stacked(), width: width(), height: height(), formatTick })
  })

  const [active, setActive] = createSignal<number>()
  const [keyboard, setKeyboard] = createSignal(false)

  // ── Hover and keyboard ──────────────────────────────────────────────────────────────────────────────────────────

  const svgPoint = (event: PointerEvent) => {
    const target = event.currentTarget as Element
    const rect = target.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const onPointerMove = (event: PointerEvent) => {
    setKeyboard(false)
    const point = svgPoint(event)
    if (type() === "donut") {
      const size = donutSize()
      const outer = size / 2 - 4
      const dx = point.x - size / 2
      const dy = point.y - size / 2
      const distance = Math.hypot(dx, dy)
      let angle = Math.atan2(dx, -dy)
      if (angle < 0) angle += Math.PI * 2
      const found = slices().findIndex((slice) => angle >= slice.start && angle < slice.end)
      setActive(distance >= outer * 0.6 - 4 && distance <= outer + 6 && found >= 0 ? found : undefined)
      return
    }
    const geo = geometry()
    if (!geo) return
    const inside = point.x >= geo.left && point.x <= geo.right
    setActive(inside ? clamp(Math.floor((point.x - geo.left) / geo.band), 0, data().count - 1) : undefined)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const count = type() === "donut" ? slices().length : data().count
    if (count === 0) return
    const now = active()
    let next: number | undefined
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = now === undefined ? 0 : Math.min(count - 1, now + 1)
        break
      case "ArrowLeft":
      case "ArrowUp":
        next = now === undefined ? count - 1 : Math.max(0, now - 1)
        break
      case "Home":
        next = 0
        break
      case "End":
        next = count - 1
        break
      case "Escape":
        if (now === undefined) return
        next = undefined
        break
      default:
        return
    }
    event.preventDefault()
    setKeyboard(true)
    setActive(next)
  }

  const clear = () => {
    setActive(undefined)
    setKeyboard(false)
  }

  // ── Readouts ────────────────────────────────────────────────────────────────────────────────────────────────────

  const rows = createMemo(() => {
    const index = active()
    if (index === undefined || type() === "donut") return []
    return data().series.flatMap((series, position) => {
      const value = series.values[index]
      return value === undefined ? [] : [{ series: position, name: series.name, value: format(value) }]
    })
  })

  const stackTotal = () => {
    const index = active()
    if (index === undefined || !stacked() || data().series.length < 2) return undefined
    return format(data().series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0))
  }

  const activeSlice = () => {
    const index = active()
    return index === undefined ? undefined : slices()[index]
  }

  const readout = () => {
    const index = active()
    if (index === undefined) return ""
    const slice = activeSlice()
    if (type() === "donut") {
      return slice
        ? host.t("c.chart.readout", {
            label: slice.label,
            values: `${format(slice.value)} (${percent(slice.share)})`,
          })
        : ""
    }
    const values = rows().map((row) => host.t("c.chart.pair", { name: row.name, value: row.value }))
    return host.t("c.chart.readout", { label: data().labels[index] ?? "", values: values.join(", ") || "–" })
  }

  const summary = createMemo(() => {
    const kind = host.t(`c.chart.kind.${type() === "bar" && stacked() ? "stacked" : type()}`)
    const head = title() ? host.t("c.chart.titled", { kind, title: title() }) : kind
    const count = data().count
    const points = host.t(count === 1 ? "c.chart.points.one" : "c.chart.points.other", { count })
    if (type() === "donut") {
      const parts = slices().length
      return host.t("c.chart.summaryDonut", {
        head,
        points: host.t(parts === 1 ? "c.chart.points.one" : "c.chart.points.other", { count: parts }),
        total: format(total()),
      })
    }
    const all = data().series.flatMap((series) => series.values.filter((value): value is number => value !== undefined))
    const seriesCount = data().series.length
    return host.t("c.chart.summary", {
      head,
      series: host.t(seriesCount === 1 ? "c.chart.series.one" : "c.chart.series.other", { count: seriesCount }),
      points,
      min: all.length ? format(Math.min(...all)) : "–",
      max: all.length ? format(Math.max(...all)) : "–",
    })
  })

  const legend = () => (type() !== "donut" && data().series.length > 1 ? data().series : [])

  // ── Render ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const Cartesian = (props: { readonly geo: Cartesian }) => {
    const activeX = () => {
      const index = active()
      return index === undefined ? undefined : props.geo.center(index)
    }
    return (
      <svg
        width={width()}
        height={height()}
        viewBox={`0 0 ${width()} ${height()}`}
        aria-hidden="true"
        onPointerMove={onPointerMove}
        onPointerLeave={clear}
      >
        <g data-slot="grid">
          <Index each={props.geo.ticks}>
            {(tick) => <line data-mark="grid" x1={props.geo.left} x2={props.geo.right} y1={tick().y} y2={tick().y} />}
          </Index>
        </g>
        <Show when={type() === "bar" && active() !== undefined}>
          <rect
            data-mark="band"
            x={f(props.geo.left + props.geo.band * (active() ?? 0))}
            y={props.geo.top}
            width={f(props.geo.band)}
            height={props.geo.bottom - props.geo.top}
            rx={RADIUS}
          />
        </Show>
        <g data-slot="y-axis">
          <Index each={props.geo.ticks}>
            {(tick) => (
              <text data-mark="tick" x={props.geo.left - 8} y={tick().y} dy="0.32em" text-anchor="end">
                {tick().label}
              </text>
            )}
          </Index>
        </g>
        <g data-slot="x-axis">
          <Index each={props.geo.xLabels}>
            {(label) => (
              <text data-mark="label" x={f(label().x)} y={props.geo.bottom + 17} text-anchor="middle">
                {label().text}
              </text>
            )}
          </Index>
        </g>
        <Index each={props.geo.areas}>
          {(area) => <path data-mark="area" data-series={area().series} d={area().d} />}
        </Index>
        <Index each={props.geo.bars}>
          {(bar) => (
            <path
              data-mark="bar"
              data-series={bar().series}
              data-dim={active() !== undefined && active() !== bar().index ? "" : undefined}
              d={bar().d}
            />
          )}
        </Index>
        <Show when={props.geo.baseline !== undefined}>
          <line
            data-mark="baseline"
            x1={props.geo.left}
            x2={props.geo.right}
            y1={props.geo.baseline}
            y2={props.geo.baseline}
          />
        </Show>
        <Index each={props.geo.lines}>
          {(line) => <path data-mark="line" data-series={line().series} d={line().d} />}
        </Index>
        <Index each={props.geo.isolated}>
          {(point) => <circle data-mark="dot" data-series={point().series} cx={point().x} cy={point().y} r={4} />}
        </Index>
        <Show when={type() !== "bar" && activeX() !== undefined}>
          <line
            data-mark="crosshair"
            x1={Math.round(activeX() ?? 0) + 0.5}
            x2={Math.round(activeX() ?? 0) + 0.5}
            y1={props.geo.top}
            y2={props.geo.bottom}
          />
          <Index each={props.geo.points}>
            {(series, position) => (
              <Show when={series()[active() ?? -1]}>
                {(point) => (
                  <circle data-mark="dot" data-series={position} data-ring="" cx={point().x} cy={point().y} r={4} />
                )}
              </Show>
            )}
          </Index>
        </Show>
      </svg>
    )
  }

  const Donut = () => {
    const size = () => donutSize()
    const outer = () => size() / 2 - 4
    const inner = () => outer() * 0.6
    const whole = () => slices().length === 1
    const centerValue = () => {
      const slice = activeSlice()
      return slice ? format(slice.value) : format(total())
    }
    const centerLabel = () => {
      const slice = activeSlice()
      return truncate(slice ? slice.label : host.t("c.chart.total"), Math.floor((inner() * 1.7) / CHAR))
    }
    return (
      <svg
        width={size()}
        height={size()}
        viewBox={`0 0 ${size()} ${size()}`}
        aria-hidden="true"
        onPointerMove={onPointerMove}
        onPointerLeave={clear}
      >
        <Index each={slices()}>
          {(slice, index) => (
            <path
              data-mark="slice"
              data-series={index}
              data-active={active() === index ? "" : undefined}
              d={slicePath(
                size() / 2,
                size() / 2,
                outer() + (active() === index && !whole() ? 3 : 0),
                inner(),
                slice().start,
                slice().end,
                whole(),
              )}
              fill-rule="evenodd"
            />
          )}
        </Index>
        <Show when={inner() >= DONUT_CENTER_MIN}>
          <text data-mark="center-value" x={size() / 2} y={size() / 2 - 2} text-anchor="middle">
            {centerValue()}
          </text>
          <text data-mark="center-label" x={size() / 2} y={size() / 2 + 16} text-anchor="middle">
            {centerLabel()}
          </text>
        </Show>
      </svg>
    )
  }

  return (
    <figure data-gu="chart" data-type={type()} data-stacked={stacked() ? "" : undefined}>
      <Show when={title() || headerUnit()}>
        <figcaption data-slot="header">
          <Show when={title()}>
            <span data-slot="title">{title()}</span>
          </Show>
          <Show when={headerUnit()}>
            <span data-slot="unit">{headerUnit()}</span>
          </Show>
        </figcaption>
      </Show>
      <Show when={legend().length > 0}>
        <ul data-slot="legend" aria-hidden="true">
          <Index each={legend()}>
            {(series, position) => (
              <li data-slot="legend-item">
                <span data-slot="swatch" data-series={position} data-shape={type() === "line" ? "line" : "box"} />
                <span data-slot="legend-name">{series().name}</span>
              </li>
            )}
          </Index>
        </ul>
      </Show>
      <div data-slot="body" ref={body}>
        <Show
          when={!empty()}
          fallback={
            // While the spec streams the box keeps the chart's height, so the surface does not jump when data arrives.
            <div data-slot="empty" style={{ height: `${ctx.loading ? height() : Math.min(height(), 120)}px` }}>
              {ctx.loading ? "" : host.t("c.chart.empty")}
            </div>
          }
        >
          <div
            data-slot="plot"
            role="img"
            aria-label={summary()}
            aria-describedby={`${id}-hint`}
            tabIndex={0}
            style={{ height: `${type() === "donut" ? donutSize() : height()}px` }}
            onKeyDown={onKeyDown}
            onBlur={clear}
          >
            <Switch>
              <Match when={type() === "donut" && width() > 0}>
                <Donut />
              </Match>
              <Match when={geometry()}>{(geo) => <Cartesian geo={geo()} />}</Match>
            </Switch>
            <Show when={type() !== "donut" && active() !== undefined && geometry()}>
              {(geo) => {
                const x = () => geo().center(active() ?? 0)
                return (
                  <div
                    data-slot="tooltip"
                    data-side={x() > width() / 2 ? "start" : "end"}
                    aria-hidden="true"
                    style={{
                      left: `${f(x())}px`,
                      top: `${geo().top}px`,
                      // Clear of the highlighted band for bars, close to the crosshair for lines.
                      "--_offset": `${f(type() === "bar" ? Math.max(12, geo().band / 2 + 4) : 12)}px`,
                    }}
                  >
                    <div data-slot="tooltip-label">{data().labels[active() ?? 0]}</div>
                    <Index each={rows()}>
                      {(row) => (
                        <div data-slot="tooltip-row">
                          <span data-slot="tooltip-key" data-series={row().series} />
                          <span data-slot="tooltip-value">{row().value}</span>
                          <span data-slot="tooltip-name">{row().name}</span>
                        </div>
                      )}
                    </Index>
                    <Show when={stackTotal()}>
                      <div data-slot="tooltip-row" data-total="">
                        <span data-slot="tooltip-key" />
                        <span data-slot="tooltip-value">{stackTotal()}</span>
                        <span data-slot="tooltip-name">{host.t("c.chart.total")}</span>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </Show>
          </div>
          <Show when={type() === "donut"}>
            <ul data-slot="donut-legend" aria-hidden="true">
              <Index each={slices()}>
                {(slice, index) => (
                  <li
                    data-slot="legend-item"
                    data-active={active() === index ? "" : undefined}
                    onPointerEnter={() => setActive(index)}
                    onPointerLeave={clear}
                  >
                    <span data-slot="swatch" data-series={index} data-shape="box" />
                    <span data-slot="legend-name">{slice().label}</span>
                    <span data-slot="legend-value">{percent(slice().share)}</span>
                  </li>
                )}
              </Index>
            </ul>
          </Show>
        </Show>
      </div>
      <span data-gu-sr="" id={`${id}-hint`}>
        {host.t("c.chart.keys")}
      </span>
      <div data-gu-sr="" aria-live="polite">
        {keyboard() ? readout() : ""}
      </div>
      <Show when={!empty()}>
        <table data-gu-sr="">
          <caption>{title() || host.t("c.chart.data")}</caption>
          <Show
            when={type() === "donut"}
            fallback={
              <>
                <thead>
                  <tr>
                    <th scope="col">{host.t("c.chart.category")}</th>
                    <Index each={data().series}>{(series) => <th scope="col">{series().name}</th>}</Index>
                  </tr>
                </thead>
                <tbody>
                  <Index each={data().labels}>
                    {(label, index) => (
                      <tr>
                        <th scope="row">{label()}</th>
                        <Index each={data().series}>
                          {(series) => {
                            const value = () => series().values[index]
                            return <td>{value() === undefined ? "–" : format(value()!)}</td>
                          }}
                        </Index>
                      </tr>
                    )}
                  </Index>
                </tbody>
              </>
            }
          >
            <thead>
              <tr>
                <th scope="col">{host.t("c.chart.category")}</th>
                <th scope="col">{host.t("c.chart.value")}</th>
                <th scope="col">{host.t("c.chart.share")}</th>
              </tr>
            </thead>
            <tbody>
              <Index each={slices()}>
                {(slice) => (
                  <tr>
                    <th scope="row">{slice().label}</th>
                    <td>{format(slice().value)}</td>
                    <td>{percent(slice().share)}</td>
                  </tr>
                )}
              </Index>
            </tbody>
          </Show>
        </table>
      </Show>
    </figure>
  )
}

export const chartComponents = { Chart } satisfies { [K in "Chart"]: GenuiComponent<K> }
