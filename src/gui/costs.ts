// What a component builds from its props beyond one element per element: a Table draws rows × columns cells and a Chart
// labels × series points, so their props' size (see unitsOf in src/gui/element.ts) understates their DOM by a product.
// Kept free of JSX and of json-render so element.ts, which charges these, loads without a DOM.

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
 * The units an element of `type` costs on top of its props' size: its cells or points over CELLS_PER_UNIT. Zero for
 * components whose DOM follows their props' size.
 */
export function domUnits(type: unknown, props: unknown): number {
  if (!isRecord(props)) return 0
  let cells = 0
  if (type === "Table") {
    const rows = listOf(props.rows)
    const width = Math.max(1, tableWidth(props.columns, rows))
    cells = tableRows(rows.length, width) * width
  } else if (type === "Chart") cells = chartPoints(props)
  return Math.ceil(cells / CELLS_PER_UNIT)
}
