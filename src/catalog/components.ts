import { z } from "zod"
import { SUGGESTED_ICONS } from "./icons.ts"

// Adapted from @json-render/shadcn's catalog (Apache-2.0, see NOTICE): the same component names and props where they
// fit, without styling props (UI always takes the OpenCode app's look), with optional props marked `.optional()`, and
// with OpenCode-specific components. Every component here has a native implementation in src/gui/components.

// -----------------------------------------------------------------------------------------------------------------
// Shared prop schemas
// -----------------------------------------------------------------------------------------------------------------

const checks = z
  .array(z.object({ type: z.string(), message: z.string(), args: z.record(z.string(), z.unknown()).optional() }))
  .optional()
const validateOn = z.enum(["change", "blur", "submit"]).optional()
const gap = z.enum(["none", "xs", "sm", "md", "lg", "xl"]).optional()
const option = z.union([z.string(), z.object({ label: z.string(), value: z.string() })])
const icon = z.string().optional()
const tone = z.enum(["neutral", "info", "success", "warning", "danger"]).optional()

export type Option = z.infer<typeof option>

/** One option, a plain string or `{ label, value }`, as `{ label, value }`; undefined for anything else. */
export function normalizeOption(item: unknown): { label: string; value: string } | undefined {
  if (typeof item === "string") return { label: item, value: item }
  if (item && typeof item === "object" && typeof (item as { value?: unknown }).value === "string") {
    const { label, value } = item as { label?: unknown; value: string }
    return { label: typeof label === "string" ? label : value, value }
  }
  return undefined
}

/** Options may be plain strings or `{ label, value }`; components normalize them with this. */
export function normalizeOptions(options: readonly Option[] | undefined | null): { label: string; value: string }[] {
  if (!Array.isArray(options)) return []
  return options.flatMap((item) => {
    const option = normalizeOption(item)
    return option ? [option] : []
  })
}

// -----------------------------------------------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------------------------------------------

export const componentDefinitions = {
  // ── Layout ────────────────────────────────────────────────────────────────────────────────────────────────────
  Stack: {
    props: z.object({
      direction: z.enum(["vertical", "horizontal"]).optional(),
      gap,
      align: z.enum(["start", "center", "end", "stretch", "baseline"]).optional(),
      justify: z.enum(["start", "center", "end", "between", "around"]).optional(),
      wrap: z.boolean().optional(),
    }),
    slots: ["default"],
    description: "Flex layout. Vertical by default (gap md). Use horizontal with wrap for rows of buttons or badges.",
    example: { direction: "vertical", gap: "md" },
  },
  Grid: {
    props: z.object({ columns: z.number().int().min(1).max(6).optional(), gap }),
    slots: ["default"],
    description: "Grid of 1-6 columns (default 2); they collapse on narrow surfaces such as a sidebar canvas.",
    example: { columns: 3, gap: "md" },
  },
  Card: {
    props: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      tone,
      padding: z.enum(["none", "sm", "md"]).optional(),
    }),
    slots: ["default"],
    description:
      "Bordered box for a section, form or item. tone colors its accent for status cards. Not for page headers.",
    example: { title: "Deployment", description: "Production · us-east-1" },
  },
  Separator: {
    props: z.object({ orientation: z.enum(["horizontal", "vertical"]).optional(), label: z.string().optional() }),
    description: "A divider line, optionally with a centered label.",
  },
  Tabs: {
    props: z.object({
      tabs: z.array(z.object({ label: z.string(), value: z.string() })),
      value: z.string().optional(),
      defaultValue: z.string().optional(),
    }),
    slots: ["default"],
    events: ["change"],
    description:
      "Child N is the panel of tabs[N]: give exactly one child per tab (wrap several elements in a Stack). Use { $bindState } on value to read or set the active tab.",
    example: {
      tabs: [
        { label: "Overview", value: "overview" },
        { label: "Logs", value: "logs" },
      ],
    },
  },
  Accordion: {
    props: z.object({
      items: z.array(z.object({ title: z.string(), content: z.string().optional() })),
      type: z.enum(["single", "multiple"]).optional(),
      defaultOpen: z.array(z.number().int()).optional(),
    }),
    slots: ["default"],
    description:
      "Collapsible sections. Each item's content is Markdown; or give children, where child N is the body of items[N]. type single (default) or multiple. defaultOpen lists item indexes.",
  },
  Collapsible: {
    props: z.object({ title: z.string(), defaultOpen: z.boolean().optional() }),
    slots: ["default"],
    description: "A section with a disclosure header; children render inside when open.",
  },

  // ── Content ───────────────────────────────────────────────────────────────────────────────────────────────────
  Heading: {
    props: z.object({ text: z.string(), level: z.enum(["h1", "h2", "h3", "h4"]).optional() }),
    description: "Section heading. h2 by default; use h1 at most once per surface.",
    example: { text: "Overview", level: "h2" },
  },
  Text: {
    props: z.object({
      text: z.string(),
      variant: z.enum(["body", "lead", "muted", "caption", "code"]).optional(),
      weight: z.enum(["regular", "medium"]).optional(),
      align: z.enum(["start", "center", "end"]).optional(),
    }),
    description: "A paragraph of plain text; use Markdown for links, lists or emphasis.",
  },
  Markdown: {
    props: z.object({ content: z.string() }),
    description:
      "Rich text as Markdown: lists, links, tables, code. Each code block counts as an element. Cut at a paragraph over 20,000 characters, lists or quotes nested over 8 deep, many tiny blocks or links, or long runs of lines without blank lines.",
  },
  Code: {
    props: z.object({ code: z.string(), language: z.string().optional(), title: z.string().optional() }),
    description: "A syntax-highlighted code block, with copy. language e.g. ts, json, sh.",
  },
  Badge: {
    props: z.object({
      text: z.string(),
      variant: z.enum(["default", "secondary", "outline", "success", "warning", "danger", "info"]).optional(),
    }),
    description: "A small status label.",
  },
  Alert: {
    props: z.object({
      title: z.string(),
      message: z.string().optional(),
      type: z.enum(["info", "success", "warning", "error"]).optional(),
    }),
    slots: ["default"],
    description: "A callout for important information; children (e.g. Buttons) render below the message.",
  },
  Table: {
    props: z.object({
      columns: z.array(
        z.union([
          z.string(),
          z.object({
            key: z.string(),
            label: z.string().optional(),
            align: z.enum(["start", "center", "end"]).optional(),
          }),
        ]),
      ),
      rows: z.array(z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())])),
      caption: z.string().optional(),
      selectionPath: z.string().optional(),
      emptyText: z.string().optional(),
    }),
    events: ["select"],
    description:
      'Data table, of at most 500 rows and 50 columns. columns are header labels, or { key, label, align } to read object rows by key. rows are arrays of cells (in column order) or objects. Bind rows to state with { "$state": "/rows" }. With selectionPath, clicking a row writes its index to that state path and fires on.select.',
    example: {
      columns: ["Service", "Status"],
      rows: [
        ["api", "healthy"],
        ["worker", "degraded"],
      ],
    },
  },
  Progress: {
    props: z.object({
      value: z.number(),
      max: z.number().optional(),
      label: z.string().optional(),
      showValue: z.boolean().optional(),
      tone,
    }),
    description: "A progress bar. value between 0 and max (default 100).",
  },
  Skeleton: {
    props: z.object({
      width: z.string().optional(),
      height: z.string().optional(),
      lines: z.number().int().min(1).max(12).optional(),
    }),
    description: "A loading placeholder. width/height are CSS lengths; lines renders text-like bars.",
  },
  Spinner: {
    props: z.object({ size: z.enum(["small", "normal", "large"]).optional(), label: z.string().optional() }),
    description: "The app's loading indicator, with an optional label.",
  },
  Stat: {
    props: z.object({
      label: z.string(),
      value: z.union([z.string(), z.number()]),
      change: z.string().optional(),
      trend: z.enum(["up", "down", "neutral"]).optional(),
      description: z.string().optional(),
      icon,
    }),
    description: 'A key metric. change is a short delta like "+12%"; trend colors it. Put several in a Grid.',
    example: { label: "Requests", value: "1.2M", change: "+8%", trend: "up" },
  },
  Icon: {
    props: z.object({ name: z.string(), size: z.enum(["small", "normal", "large"]).optional(), tone }),
    description: `One of the app's icons. Common names: ${SUGGESTED_ICONS.join(", ")}.`,
  },
  Keybind: {
    props: z.object({ keys: z.array(z.string()) }),
    description: 'A keyboard shortcut, e.g. { "keys": ["Mod", "K"] }.',
  },
  Image: {
    props: z.object({
      src: z.string(),
      alt: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      fit: z.enum(["cover", "contain"]).optional(),
      caption: z.string().optional(),
    }),
    description:
      "An image from an https URL or a raster data:image URL (no SVG). The user may need to click to load remote images.",
  },
  Avatar: {
    props: z.object({
      name: z.string(),
      src: z.string().optional(),
      size: z.enum(["small", "normal", "large"]).optional(),
    }),
    description: "A person or entity avatar; initials when there is no image.",
  },
  Chart: {
    props: z.object({
      type: z.enum(["bar", "line", "area", "donut"]).optional(),
      labels: z.array(z.string()),
      series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })),
      title: z.string().optional(),
      height: z.number().int().min(80).max(480).optional(),
      stacked: z.boolean().optional(),
      unit: z.string().optional(),
    }),
    description:
      "A simple chart in the app's colors. labels are the x-axis categories; each series has one value per label. donut uses the first series. At most 6 series and 500 labels.",
    example: { type: "bar", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Builds", values: [12, 18, 9] }] },
  },

  // ── Input ─────────────────────────────────────────────────────────────────────────────────────────────────────
  Input: {
    props: z.object({
      label: z.string(),
      name: z.string().optional(),
      type: z.enum(["text", "email", "password", "number", "search", "url"]).optional(),
      placeholder: z.string().optional(),
      description: z.string().optional(),
      value: z.union([z.string(), z.number()]).optional(),
      disabled: z.boolean().optional(),
      checks,
      validateOn,
    }),
    events: ["submit", "focus", "blur"],
    description:
      'Single-line text field. Bind value with { "$bindState": "/form/name" }. Enter fires on.submit. checks validate it (e.g. [{ "type": "required", "message": "Required" }]).',
  },
  Textarea: {
    props: z.object({
      label: z.string(),
      name: z.string().optional(),
      placeholder: z.string().optional(),
      description: z.string().optional(),
      rows: z.number().int().min(2).max(20).optional(),
      value: z.string().optional(),
      disabled: z.boolean().optional(),
      checks,
      validateOn,
    }),
    description: "Multi-line text field. Bind value with { $bindState }.",
  },
  Select: {
    props: z.object({
      label: z.string(),
      name: z.string().optional(),
      options: z.array(option),
      placeholder: z.string().optional(),
      value: z.string().optional(),
      disabled: z.boolean().optional(),
      checks,
      validateOn,
    }),
    events: ["change"],
    description: "Dropdown select of at most 500 options, strings or { label, value }. Bind value with { $bindState }.",
  },
  Checkbox: {
    props: z.object({
      label: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      checked: z.boolean().optional(),
      disabled: z.boolean().optional(),
      checks,
      validateOn,
    }),
    events: ["change"],
    description: "A checkbox. Bind checked with { $bindState } or, in a repeat, { $bindItem }.",
  },
  Radio: {
    props: z.object({
      label: z.string(),
      name: z.string().optional(),
      options: z.array(option),
      value: z.string().optional(),
      orientation: z.enum(["vertical", "horizontal"]).optional(),
      disabled: z.boolean().optional(),
      checks,
      validateOn,
    }),
    events: ["change"],
    description: "A group of radio buttons. Bind value with { $bindState }.",
  },
  Switch: {
    props: z.object({
      label: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      checked: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
    events: ["change"],
    description: "An on/off switch for settings. Bind checked with { $bindState }.",
  },
  Slider: {
    props: z.object({
      label: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().optional(),
      value: z.number().optional(),
      unit: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
    events: ["change"],
    description: "A range slider (default 0-100). Bind value with { $bindState }.",
  },
  Button: {
    props: z.object({
      label: z.string(),
      variant: z.enum(["primary", "secondary", "ghost", "danger"]).optional(),
      size: z.enum(["small", "normal", "large"]).optional(),
      icon,
      disabled: z.boolean().optional(),
    }),
    events: ["press"],
    description:
      "A button; on.press runs actions. primary for the main action of a form (one per surface), secondary (default) otherwise, danger for destructive actions.",
    example: { label: "Deploy", variant: "primary" },
  },
  Link: {
    props: z.object({ label: z.string(), href: z.string().optional() }),
    events: ["press"],
    description: "An inline link. With an http(s) href it opens in the browser; without one, on.press runs actions.",
  },
  Toggle: {
    props: z.object({ label: z.string(), pressed: z.boolean().optional(), icon, disabled: z.boolean().optional() }),
    events: ["change"],
    description: "A two-state button. Bind pressed with { $bindState }.",
  },
  ToggleGroup: {
    props: z.object({
      items: z.array(z.object({ label: z.string(), value: z.string(), icon })),
      type: z.enum(["single", "multiple"]).optional(),
      value: z.union([z.string(), z.array(z.string())]).optional(),
      disabled: z.boolean().optional(),
    }),
    events: ["change"],
    description:
      "Toggle buttons: single (default) binds a string value, multiple an array. Bind value with { $bindState }.",
  },
  ButtonGroup: {
    props: z.object({
      buttons: z.array(z.object({ label: z.string(), value: z.string() })),
      selected: z.string().optional(),
    }),
    events: ["change"],
    description: "A segmented control to pick one option. Bind selected with { $bindState }.",
  },
  DropdownMenu: {
    props: z.object({
      label: z.string(),
      items: z.array(z.object({ label: z.string(), value: z.string(), icon })),
      value: z.string().optional(),
    }),
    events: ["select"],
    description:
      "A button that opens a menu. Choosing an item writes its value to the bound value ({ $bindState }) and fires on.select.",
  },
  Pagination: {
    props: z.object({ totalPages: z.number().int().min(1), page: z.number().int().optional() }),
    events: ["change"],
    description: "Page navigation (pages start at 1). Bind page with { $bindState }.",
  },

  // ── Overlay ───────────────────────────────────────────────────────────────────────────────────────────────────
  Dialog: {
    props: z.object({ title: z.string(), description: z.string().optional(), openPath: z.string() }),
    slots: ["default"],
    description:
      'A modal dialog shown while the boolean at state path openPath is true. Open it from a press with setState {"statePath":"/dialogOpen","value":true}; it closes itself.',
  },
  Drawer: {
    props: z.object({ title: z.string(), description: z.string().optional(), openPath: z.string() }),
    slots: ["default"],
    description: "Like Dialog, but slides in from the side for longer content.",
  },
  Tooltip: {
    props: z.object({ content: z.string(), text: z.string().optional() }),
    slots: ["default"],
    description: "Shows content on hover over its children, or over text when it has no children.",
  },
  Popover: {
    props: z.object({ trigger: z.string(), content: z.string().optional() }),
    slots: ["default"],
    description: "A button labelled trigger that opens a small panel with content (Markdown) and/or children.",
  },
  Carousel: {
    props: z.object({
      items: z.array(z.object({ title: z.string(), description: z.string().optional(), image: z.string().optional() })),
    }),
    description: "A horizontally scrolling set of cards.",
  },
}

export type ComponentName = keyof typeof componentDefinitions

export const COMPONENT_NAMES = Object.keys(componentDefinitions) as ComponentName[]
