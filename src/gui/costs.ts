// What a component builds from its props beyond one element per element: a Table draws rows × columns cells and a Chart
// labels × series points, so their props' size (see unitsOf in src/gui/element.ts) understates their DOM by a product.
// Kept free of JSX and of json-render so element.ts, which charges these, loads without a DOM.

import type { ComponentName } from "../catalog/components.ts"
import { markdownShape, MAX_MARKDOWN_BLOCKS } from "./components/markdown.ts"

/** Rows a Table renders at most; a table this long belongs in a file, and the surface must stay cheap to update. */
export const MAX_TABLE_ROWS = 500

/** Columns a Table renders at most. */
export const MAX_TABLE_COLUMNS = 50

/** Cells a Table renders at most: a wide table renders fewer rows (a 50-column table, 200). */
export const MAX_TABLE_CELLS = 10_000

/** Series (the palette's size; the catalog asks the model for at most this many) and points a Chart draws at most. */
export const MAX_CHART_SERIES = 6
export const MAX_CHART_POINTS = 500

/**
 * How many cells, or chart points, cost one unit of the render budget (see RENDER_UNITS). A cell is a table cell with its
 * text, about a tenth of what a component such as a Checkbox builds: a 10,000-cell table costs 1,000 units, half of what
 * a surface shows.
 */
export const CELLS_PER_UNIT = 10

/**
 * A list prop of which a component draws a group of nodes per item (a radio and its labels per option, a key cap per
 * key): at most `max` items are drawn, and the component says what it leaves out (see useListCut in
 * src/gui/components/shared.tsx). `cells` is what drawing one item costs, in table cells (measured in Chromium against
 * a table cell: a radio option costs about four, a tab or a key cap two).
 */
export interface ItemList {
  readonly prop: string
  /** What the items are called, for the note and the issue. */
  readonly noun: string
  readonly max: number
  readonly cells: number
}

/**
 * Every component that draws a list prop item by item. A 96 KB Keybind of 48,000 keys built 96,000 nodes in one element
 * (3 s of frozen window), as did a Radio of 10,000 options (1.2 s): a list costs a character an item in the props' size,
 * far less than it builds. Select and DropdownMenu build their items only while open, all at once, in the app's list.
 */
export const ITEM_LISTS = {
  Keybind: { prop: "keys", noun: "keys", max: 16, cells: 2 },
  Tabs: { prop: "tabs", noun: "tabs", max: 200, cells: 2 },
  Radio: { prop: "options", noun: "options", max: 200, cells: 4 },
  ToggleGroup: { prop: "items", noun: "items", max: 200, cells: 2 },
  ButtonGroup: { prop: "buttons", noun: "buttons", max: 200, cells: 2 },
  DropdownMenu: { prop: "items", noun: "items", max: 200, cells: 1 },
  Select: { prop: "options", noun: "options", max: 500, cells: 1 },
  Accordion: { prop: "items", noun: "sections", max: 500, cells: 8 },
  Carousel: { prop: "items", noun: "cards", max: 500, cells: 4 },
} as const satisfies Partial<Record<ComponentName, ItemList>>

export type ListComponent = keyof typeof ITEM_LISTS

/** The ItemList of a component type, if it draws one. */
export const itemList = (type: unknown): ItemList | undefined =>
  typeof type === "string" && Object.hasOwn(ITEM_LISTS, type) ? ITEM_LISTS[type as ListComponent] : undefined

/**
 * The keys of a Keybind's `keys` written as one string ("Mod+K" for ["Mod", "K"]): its first `limit` non-blank parts,
 * and how many it has in all. Walks the string once, without building the parts past `limit`.
 */
export function splitKeys(text: string, limit: number): { readonly keys: string[]; readonly total: number } {
  const keys: string[] = []
  let total = 0
  for (let start = 0; start <= text.length; ) {
    let end = text.indexOf("+", start)
    if (end < 0) end = text.length
    let blank = true
    for (let index = start; index < end && blank; index++) blank = /\s/.test(text[index]!)
    if (!blank) {
      if (total < limit) keys.push(text.slice(start, end))
      total++
    }
    start = end + 1
  }
  return { keys, total }
}

/** How many items a component's list prop holds (its entries, or the parts of a Keybind string), for its charge. */
function itemCount(type: unknown, value: unknown): number {
  if (type === "Keybind" && typeof value === "string") return splitKeys(value, 0).total
  return Array.isArray(value) ? value.length : 0
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

/**
 * How many columns a Table with these props shows: its `columns` that name one (strings, numbers, objects with a `key`
 * or `label`), or else the keys of its first 50 object rows or the width of its first 50 array rows; at most
 * MAX_TABLE_COLUMNS. src/gui/components/data.tsx builds the columns themselves.
 */
export function tableWidth(columns: unknown, rows: readonly unknown[]): number {
  let named = 0
  for (const column of listOf(columns)) {
    if (typeof column === "string" || typeof column === "number") named++
    else if (isRecord(column) && (isName(column.key) || isName(column.label))) named++
    if (named >= MAX_TABLE_COLUMNS) return MAX_TABLE_COLUMNS
  }
  if (named > 0) return named
  const keys = new Set<string>()
  let width = 0
  for (const row of rows.slice(0, 50)) {
    if (Array.isArray(row)) width = Math.max(width, row.length)
    else if (isRecord(row)) for (const key in row) if (Object.hasOwn(row, key)) keys.add(key)
    if (keys.size >= MAX_TABLE_COLUMNS || width >= MAX_TABLE_COLUMNS) return MAX_TABLE_COLUMNS
  }
  return keys.size > 0 ? keys.size : width
}

// A string or finite number that names a column (str() in components/shared.tsx).
const isName = (value: unknown) =>
  (typeof value === "string" && value !== "") || (typeof value === "number" && Number.isFinite(value))

/** How many rows a Table of `width` columns shows out of `rows`: at most MAX_TABLE_ROWS and MAX_TABLE_CELLS cells. */
export const tableRows = (rows: number, width: number): number =>
  Math.min(rows, MAX_TABLE_ROWS, Math.floor(MAX_TABLE_CELLS / Math.max(1, width)))

/** How many points a Chart with these props draws: its labels (or longest series) times its series. */
function chartPoints(props: Record<string, unknown>): number {
  const series = listOf(props.series).filter(isRecord).slice(0, MAX_CHART_SERIES)
  const labels = listOf(props.labels).length
  let longest = 0
  for (const item of series) longest = Math.max(longest, listOf(item.values).length)
  const count = Math.min(MAX_CHART_POINTS, labels > 0 ? labels : longest)
  // Each point is drawn and listed in the chart's table for screen readers.
  return 2 * count * Math.max(1, series.length)
}

/**
 * What a code block in a Markdown text costs: one it shows on its own (see MAX_CODE_PARTS in components/markdown.ts)
 * CODE_PART_UNITS, since the app's code block is a Markdown renderer of its own, a few elements' worth; one left in the
 * prose (fenced, indented, display math) a unit, about what the renderer builds for it (in the playground, an
 * element's worth).
 */
export const CODE_PART_UNITS = 4

/** The units of a Markdown text's code blocks (see CODE_PART_UNITS), in what it shows. */
export function textCodeUnits(text: string): number {
  const { code, own } = markdownShape(text)
  return own * CODE_PART_UNITS + (code - own)
}

/**
 * The units of a Markdown text beyond its length: its code blocks (see textCodeUnits), and its blocks (paragraphs,
 * headings, rules, quotes, list items, table cells) and inline elements (links, emphasis, code spans, line breaks)
 * charged as Table cells are, as far as its length does not pay for them already (see CHARS_PER_BLOCK in
 * components/markdown.ts; at most MAX_MARKDOWN_BLOCKS such show). A text of tiny blocks built 47,000 table cells, or
 * 24,000 list items, and one of tiny links or emphases 80,000 of them, in one element; charged, the time slice keeps
 * such texts in tasks of their own, and the budget refuses those too large for a UI.
 */
export function markdownUnits(text: string): number {
  return textCodeUnits(text) + Math.floor(Math.min(MAX_MARKDOWN_BLOCKS, markdownShape(text).blocks) / CELLS_PER_UNIT)
}

// The units of an Accordion's items' Markdown, by its items list (the rows of a repeat share it).
const accordionCode = new WeakMap<object, number>()

/** The units of the Markdown texts of an element (Markdown, Popover, Accordion items) beyond their length. */
function codeUnits(type: unknown, props: Record<string, unknown>): number {
  if (type === "Markdown" || type === "Popover")
    return typeof props.content === "string" ? markdownUnits(props.content) : 0
  if (type !== "Accordion" || !Array.isArray(props.items)) return 0
  const items = props.items
  let units = accordionCode.get(items)
  if (units === undefined) {
    units = 0
    for (const item of items.slice(0, ITEM_LISTS.Accordion.max))
      if (isRecord(item) && typeof item.content === "string") units += markdownUnits(item.content)
    accordionCode.set(items, units)
  }
  return units
}

/**
 * The units an element of `type` costs on top of its props' size: its cells, points or drawn list items over
 * CELLS_PER_UNIT, and the code blocks and blocks its Markdown shows (see markdownUnits). Zero for components whose DOM
 * follows their props' size.
 */
export function domUnits(type: unknown, props: unknown): number {
  if (!isRecord(props)) return 0
  const code = codeUnits(type, props)
  let cells = 0
  const list = itemList(type)
  if (type === "Table") {
    const rows = listOf(props.rows)
    const width = Math.max(1, tableWidth(props.columns, rows))
    cells = tableRows(rows.length, width) * width
  } else if (type === "Chart") cells = chartPoints(props)
  else if (list) cells = Math.min(list.max, itemCount(type, props[list.prop])) * list.cells
  return Math.ceil(cells / CELLS_PER_UNIT) + code
}
