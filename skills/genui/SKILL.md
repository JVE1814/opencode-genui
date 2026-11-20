---
name: genui
description: "Full reference for showing interactive UI in the OpenCode desktop app: how to write json-render specs in ```spec (inline) and ```canvas (sidebar canvas) blocks, the components, actions, state and canvas updates. Load it before writing your first UI in a session."
---

# Interactive UI in OpenCode

You are running in the OpenCode desktop app. Besides text, you can show interactive UI: you write a json-render spec (JSONL lines of RFC 6902 JSON Patch) in a fenced block of your reply, and the app renders it with its own components and theme.

## When to use UI

Use UI when the user would rather click or scan than read: collecting input (forms), choosing between options, dashboards and status, comparisons, previews, step-by-step flows. Use plain text for explanations, short answers and code; a greeting or a clarifying question never needs UI. Write a sentence or two before a UI, and do not repeat the UI's content in prose.

## Inline UI: ```spec

- A ```spec block renders in place in your reply when its closing fence arrives, not while it streams.
- Each block is one self-contained UI: it sets /root and adds every element and all the state it uses. Blocks never share elements or state.
- An optional first line is a header: {"id":"<stable-id>","title":"..."}. When you send a block again with the same id (say, with an extra field or an error message), what the user already entered is kept.
- It sits in the transcript, about 740px wide.

## Canvas: ```canvas

A canvas is a sidebar tab, about 360px wide, that stays open across turns: use it for dashboards, status boards, checklists, plans or previews that you keep updating while you work.

- The first line is the header: {"canvas":"<id>","title":"..."}, with a short lowercase id ("main" when omitted).
- A block that sets /root and adds that root element replaces the canvas: a new UI with fresh state.
- Any other block patches the canvas as it is, with RFC 6902 ops (add, replace, remove, move, copy) on /elements/<key>, /elements/<key>/props/<prop> and /state/.... Replacing /root with an element the canvas has switches the view, keeping the state and what the user entered.
- {"canvas":"<id>","close":true} on its own removes the canvas.
- The canvas renders while the block streams, so write /root and the layout first and the data after.
- Several canvases can exist, one tab each; give each its own id.
- If unsure what a canvas holds now (say, the chat was compacted), send the whole canvas again, with /root.
- In your reply the block shows as a small chip that opens the canvas.

A canvas, then a later block that patches it:

```canvas
{"canvas":"deploy","title":"Deploy"}
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Production deploy"},"children":["rollout","steps"]}}
{"op":"add","path":"/elements/rollout","value":{"type":"Progress","props":{"label":"Rollout","value":{"$state":"/progress"}},"children":[]}}
{"op":"add","path":"/elements/steps","value":{"type":"Table","props":{"columns":["Step","Status"],"rows":{"$state":"/steps"}},"children":[]}}
{"op":"add","path":"/state/progress","value":40}
{"op":"add","path":"/state/steps","value":[["Build","done"],["Migrate","running"],["Switch traffic","pending"]]}
```

```canvas
{"canvas":"deploy"}
{"op":"replace","path":"/state/progress","value":70}
{"op":"replace","path":"/state/steps/1/1","value":"done"}
```

The rest of this skill describes the patch lines. They are the same in both fences; in a ```canvas block they follow the header.

## When the user interacts

Inputs keep what the user enters. Bind each input you want back to a state path you choose ({"$bindState":"/form/email"}), then send it with sendPrompt.

- sendPrompt { text, data? } sends a user message that you then answer as usual: the text (cut after about 4,000 characters when there is data), a blank line, then the data as the last fenced json block (pretty-printed, cut after about 16,000 characters); a cut ends in "... (truncated)". Write text as the user's own words for what they did; data is usually {"$state":"/form"}. A button with params {"text":"Deploy with these settings","data":{"$state":"/form"}} sends:

  Deploy with these settings

  ```json
  {
    "env": "production",
    "replicas": 3
  }
  ```

- insertPrompt { text } puts text in the message box for the user to edit and send.
- openLink { url } opens an http(s) or mailto URL. copyText { text, label? } copies to the clipboard. showToast { title, description?, variant? } shows a notification; variant is "default", "success" or "error". openCanvas { canvas } shows a canvas tab.
- sendPrompt, insertPrompt, openLink and copyText leave the UI, so they run only when the user activates a control: on.press of Button or Link, on.select of DropdownMenu or Table, on.submit of Input or on.change of Select, Radio, Checkbox, Switch, Toggle, ToggleGroup, ButtonGroup, Pagination or Tabs. Bound anywhere else (watch, on.focus, on.blur, a Slider's on.change) they never run. One activation runs at most 3 of them, in order (say, copyText then openLink); the next activation in the same UI must come at least 1 s later. The app may ask the user to confirm first, showing exactly what will be sent, opened or copied.
- Arrow keys in Radio and Tabs move the choice without sending it; Space, Enter or a click sends it. A choice the user should look over first is best sent from a Button.
- "confirm" on an action binding asks the user first, e.g. {"action":"sendPrompt","params":{"text":"Delete the branch"},"confirm":{"title":"Delete branch?","message":"This cannot be undone.","variant":"danger"}}. It works for the custom actions only, not for setState, pushState, removeState or validateForm, and never in watch, on.focus or on.blur.
- onSuccess runs after a custom action succeeded and onError after it failed. When the user declines a confirm or the app refuses the action, neither runs and the rest of the bound actions stop. Write each onSuccess/onError out as { "action": ..., "params": {...} } or { "set": {...} }: one written as an expression, or read from state, is ignored.
- setState, pushState, removeState and validateForm run neither: to do something after one, list it next in an array ("press":[{"action":"setState",...},{"action":"showToast",...}]).
- Use setState, pushState and removeState for changes within the UI (tabs, toggles, list edits); they need no round trip to you.

## Design

The UI always takes the app's design and follows the user's theme and light or dark mode, so there are no color, style or className props: choose components and variants, not looks.

- Keep it compact: a UI shows at most about 2,000 elements, or 500,000 characters of text, in all. Prefer Card, Stack and Grid for layout, Card titles or Headings for structure, Badge and Stat for status, and at most one primary Button per UI.
- Put realistic data in /state, taken from the task at hand.
- Give each repeat a "key" (an id field): what the user enters in an item then stays with it when you add, remove or reorder items.
- Never put secrets (API keys, tokens, passwords) in a spec: it stays in the transcript.

# Spec format and catalog (json-render)

You can answer with interactive UI as well as text. This reference covers the JSONL patch lines inside ```spec and ```canvas blocks.

OUTPUT FORMAT (text + JSONL, RFC 6902 JSON Patch):
You respond conversationally. When generating UI, first write a brief explanation (1-3 sentences), then output JSONL patch lines wrapped in a ```spec code fence.
The JSONL lines use RFC 6902 JSON Patch operations to build a UI tree. Always wrap them in a ```spec fence block:
  ```spec
  {"op":"add","path":"/root","value":"main"}
  {"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Hello"},"children":[]}}
  ```
If the user's message does not require a UI (e.g. a greeting or clarifying question), respond with text only — no JSONL.
Each line is a JSON patch operation (add, remove, replace). Start with /root, then stream /elements and /state patches interleaved so the UI fills in progressively as it streams.

Example output (each line is a separate JSON object):

{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Stack","props":{"direction":"vertical","gap":"md"},"children":["child-1","list"]}}
{"op":"add","path":"/elements/child-1","value":{"type":"Grid","props":{"columns":3,"gap":"md"},"children":[]}}
{"op":"add","path":"/elements/list","value":{"type":"Stack","props":{"direction":"vertical","gap":"md"},"repeat":{"statePath":"/items","key":"id"},"children":["item"]}}
{"op":"add","path":"/elements/item","value":{"type":"Grid","props":{"columns":3,"gap":"md"},"children":[]}}
{"op":"add","path":"/state/items","value":[]}
{"op":"add","path":"/state/items/0","value":{"id":"1","title":"First Item"}}
{"op":"add","path":"/state/items/1","value":{"id":"2","title":"Second Item"}}

Note: state patches appear right after the elements that use them, so the UI fills in as it streams. ONLY use component types from the AVAILABLE COMPONENTS list below.

INITIAL STATE:
Specs include a /state field to seed the state model. Components with { $bindState } or { $bindItem } read from and write to this state, and $state expressions read from it.
CRITICAL: You MUST include state patches whenever your UI displays data via $state, $bindState, $bindItem, $item, or $index expressions, or uses repeat to iterate over arrays. Without state, these references resolve to nothing and repeat lists render zero items.
Output state patches right after the elements that reference them, so the UI fills in progressively as it streams.
Stream state progressively - output one patch per array item instead of one giant blob:
  For arrays: {"op":"add","path":"/state/posts/0","value":{"id":"1","title":"First Post",...}} then /state/posts/1, /state/posts/2, etc.
  For scalars: {"op":"add","path":"/state/newTodoText","value":""}
  Initialize the array first if needed: {"op":"add","path":"/state/posts","value":[]}
When content comes from the state model, use { "$state": "/some/path" } dynamic props to display it instead of hardcoding the same value in both state and props. The state model is the single source of truth.
Include realistic data in state, taken from the task at hand. Never leave arrays empty.

DYNAMIC LISTS (repeat field):
Any element can have a top-level "repeat" field to render its children once per item in a state array: { "repeat": { "statePath": "/arrayPath", "key": "id" } }.
The element itself renders once (as the container), and its children are expanded once per array item. "statePath" is the state array path. "key" is an optional field name on each item for stable React keys.
For nested lists, an inner repeat can read an array from the enclosing item with { "statePath": { "$item": "field" } }. This form is valid only inside another repeat. Use an empty field to repeat over the enclosing item itself.
Example: {"type":"Stack","props":{"direction":"vertical","gap":"md"},"repeat":{"statePath":"/todos","key":"id"},"children":["todo-item"]}
Inside children of a repeated element, use { "$item": "field" } to read a field from the current item, and { "$index": true } to get the current array index. For two-way binding to an item field use { "$bindItem": "completed" } on the appropriate prop.
ALWAYS use the repeat field for lists backed by state arrays. NEVER hardcode individual elements for each array item.
IMPORTANT: "repeat" is a top-level field on the element (sibling of type/props/children), NOT inside props.

ARRAY STATE ACTIONS:
Use action "pushState" to append items to arrays. Params: { statePath: "/arrayPath", value: { ...item }, clearStatePath: "/inputPath" }.
Values inside pushState can contain { "$state": "/statePath" } references to read current state (e.g. the text from an input field).
Use "$id" inside a pushState value to auto-generate a unique ID.
Example: on: { "press": { "action": "pushState", "params": { "statePath": "/todos", "value": { "id": "$id", "title": { "$state": "/newTodoText" }, "completed": false }, "clearStatePath": "/newTodoText" } } }
Use action "removeState" to remove items from arrays by index. Params: { statePath: "/arrayPath", index: N }. Inside a repeated element's children, use { "$index": true } for the current item index. Action params support the same expressions as props: { "$item": "field" } resolves to the absolute state path for built-ins bound directly (to the field's value for sendPrompt and the other custom actions, and anywhere in an onSuccess/onError chain), { "$index": true } resolves to the index number, and { "$state": "/path" } reads a value from state.
For lists where users can add/remove items (todos, carts, etc.), use pushState and removeState instead of hardcoding with setState.

IMPORTANT: State paths use RFC 6901 JSON Pointer syntax (e.g. "/todos/0/title"). Do NOT use JavaScript-style dot notation (e.g. "/todos.length" is WRONG). To generate unique IDs for new items, use "$id" instead of trying to read array length.

AVAILABLE COMPONENTS (42):

- Stack: { direction?: "vertical" | "horizontal", gap?: "none" | "xs" | "sm" | "md" | "lg" | "xl", align?: "start" | "center" | "end" | "stretch" | "baseline", justify?: "start" | "center" | "end" | "between" | "around", wrap?: boolean } - Flex layout. Vertical by default (gap md). Use horizontal with wrap for rows of buttons or badges. [accepts children]
- Grid: { columns?: number, gap?: "none" | "xs" | "sm" | "md" | "lg" | "xl" } - Grid of 1-6 columns (default 2). Columns collapse automatically when the surface is narrow, e.g. in a sidebar canvas. [accepts children]
- Card: { title?: string, description?: string, tone?: "neutral" | "info" | "success" | "warning" | "danger", padding?: "none" | "sm" | "md" } - Bordered container for a section, form or item. tone colors its accent for status cards. Not for page headers. [accepts children]
- Separator: { orientation?: "horizontal" | "vertical", label?: string } - A divider line, optionally with a centered label.
- Tabs: { tabs: Array<{ label: string, value: string }>, value?: string, defaultValue?: string } - Tabs. Child N is the panel of tabs[N]: give exactly one child per tab (wrap several elements in a Stack). Use { $bindState } on value to read or set the active tab. [accepts children] [events: change]
- Accordion: { items: Array<{ title: string, content?: string }>, type?: "single" | "multiple", defaultOpen?: Array<number> } - Collapsible sections. Each item's content is Markdown; or give children, where child N is the body of items[N]. type single (default) or multiple. defaultOpen lists item indexes. [accepts children]
- Collapsible: { title: string, defaultOpen?: boolean } - A section with a disclosure header; children render inside when open. [accepts children]
- Heading: { text: string, level?: "h1" | "h2" | "h3" | "h4" } - Section heading. h2 by default; use h1 at most once per surface.
- Text: { text: string, variant?: "body" | "lead" | "muted" | "caption" | "code", weight?: "regular" | "medium", align?: "start" | "center" | "end" } - A paragraph of plain text. For rich text with links, lists or emphasis use Markdown.
- Markdown: { content: string } - Rich text rendered as Markdown, in the app's style. Supports lists, links, tables and code.
- Code: { code: string, language?: string, title?: string } - A syntax-highlighted code block, with copy. language e.g. ts, json, sh.
- Badge: { text: string, variant?: "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info" } - A small status label.
- Alert: { title: string, message?: string, type?: "info" | "success" | "warning" | "error" } - A callout for important information; children (e.g. Buttons) render below the message. [accepts children]
- Table: { columns: Array<string | { key: string, label?: string, align?: "start" | "center" | "end" }>, rows: Array<Array<unknown> | Record<string, unknown>>, caption?: string, selectionPath?: string, emptyText?: string } - Data table. columns are header labels, or { key, label, align } to read object rows by key. rows are arrays of cells (in column order) or objects. Bind rows to state with { "$state": "/rows" }. With selectionPath, clicking a row writes its index to that state path and fires on.select. [events: select]
- Progress: { value: number, max?: number, label?: string, showValue?: boolean, tone?: "neutral" | "info" | "success" | "warning" | "danger" } - A progress bar. value between 0 and max (default 100).
- Skeleton: { width?: string, height?: string, lines?: number } - A loading placeholder. width/height are CSS lengths; lines renders text-like bars.
- Spinner: { size?: "small" | "normal" | "large", label?: string } - The app's loading indicator, with an optional label.
- Stat: { label: string, value: string | number, change?: string, trend?: "up" | "down" | "neutral", description?: string, icon?: string } - A key metric. change is a short delta like "+12%"; trend colors it. Put several in a Grid.
- Icon: { name: string, size?: "small" | "normal" | "large", tone?: "neutral" | "info" | "success" | "warning" | "danger" } - One of the app's icons. Common names: check, circle-check, circle-x, circle-exclamation, warning, info, help, plus, minus, close, edit, trash, copy, download, cloud-upload, refresh, magnifying-glass, settings-gear, sliders, folder, file-document, code, terminal, branch, github, globe, link, lock, shield, eye, comment, speech-bubble, notifications, status, task, checklist, bullet-list, server, monitor, cube, brain, flask, arrow-right, arrow-up-right, chevron-right, chevron-down, stop, share.
- Keybind: { keys: Array<string> } - A keyboard shortcut, e.g. { "keys": ["Mod", "K"] }.
- Image: { src: string, alt: string, width?: number, height?: number, fit?: "cover" | "contain", caption?: string } - An image from an https URL or a data:image URL. The user may need to click to load remote images.
- Avatar: { name: string, src?: string, size?: "small" | "normal" | "large" } - A person or entity avatar; shows initials when there is no image.
- Chart: { type?: "bar" | "line" | "area" | "donut", labels: Array<string>, series: Array<{ name: string, values: Array<number> }>, title?: string, height?: number, stacked?: boolean, unit?: string } - A simple chart in the app's colors. labels are the x-axis categories; each series has one value per label. donut uses the first series. Keep to at most 6 series.
- Input: { label: string, name?: string, type?: "text" | "email" | "password" | "number" | "search" | "url", placeholder?: string, description?: string, value?: string | number, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Single-line text field. Bind value with { "$bindState": "/form/name" }. Enter fires on.submit. checks validate it (e.g. [{ "type": "required", "message": "Required" }]). [events: submit, focus, blur]
- Textarea: { label: string, name?: string, placeholder?: string, description?: string, rows?: number, value?: string, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Multi-line text field. Bind value with { $bindState }.
- Select: { label: string, name?: string, options: Array<string | { label: string, value: string }>, placeholder?: string, value?: string, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - Dropdown select. options are strings or { label, value }. Bind value with { $bindState }. [events: change]
- Checkbox: { label: string, name?: string, description?: string, checked?: boolean, disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - A checkbox. Bind checked with { $bindState } or, in a repeat, { $bindItem }. [events: change]
- Radio: { label: string, name?: string, options: Array<string | { label: string, value: string }>, value?: string, orientation?: "vertical" | "horizontal", disabled?: boolean, checks?: Array<{ type: string, message: string, args?: Record<string, unknown> }>, validateOn?: "change" | "blur" | "submit" } - A group of radio buttons. Bind value with { $bindState }. [events: change]
- Switch: { label: string, name?: string, description?: string, checked?: boolean, disabled?: boolean } - An on/off switch for settings. Bind checked with { $bindState }. [events: change]
- Slider: { label?: string, min?: number, max?: number, step?: number, value?: number, unit?: string, disabled?: boolean } - A range slider (default 0-100). Bind value with { $bindState }. [events: change]
- Button: { label: string, variant?: "primary" | "secondary" | "ghost" | "danger", size?: "small" | "normal" | "large", icon?: string, disabled?: boolean } - A button; on.press runs actions. primary for the main action of a form (one per surface), secondary (default) otherwise, danger for destructive actions. [events: press]
- Link: { label: string, href?: string } - An inline link. With an http(s) href it opens in the browser; without one, on.press runs actions. [events: press]
- Toggle: { label: string, pressed?: boolean, icon?: string, disabled?: boolean } - A two-state button. Bind pressed with { $bindState }. [events: change]
- ToggleGroup: { items: Array<{ label: string, value: string, icon?: string }>, type?: "single" | "multiple", value?: string | Array<string>, disabled?: boolean } - A set of toggle buttons. single (default) binds a string value, multiple binds an array of values. Bind value with { $bindState }. [events: change]
- ButtonGroup: { buttons: Array<{ label: string, value: string }>, selected?: string } - A segmented control to pick one option. Bind selected with { $bindState }. [events: change]
- DropdownMenu: { label: string, items: Array<{ label: string, value: string, icon?: string }>, value?: string } - A button that opens a menu. Choosing an item writes its value to the bound value ({ $bindState }) and fires on.select. [events: select]
- Pagination: { totalPages: number, page?: number } - Page navigation (pages start at 1). Bind page with { $bindState }. [events: change]
- Dialog: { title: string, description?: string, openPath: string } - A modal dialog shown while the boolean at state path openPath is true. Open it with setState { "statePath": "/dialogOpen", "value": true }; it closes itself. [accepts children]
- Drawer: { title: string, description?: string, openPath: string } - Like Dialog, but slides in from the side for longer content. [accepts children]
- Tooltip: { content: string, text?: string } - Shows content on hover over its children, or over text when it has no children. [accepts children]
- Popover: { trigger: string, content?: string } - A button labelled trigger that opens a small panel with content (Markdown) and/or children. [accepts children]
- Carousel: { items: Array<{ title: string, description?: string, image?: string }> } - A horizontally scrolling set of cards.

AVAILABLE ACTIONS:

- setState: Update a value in the state model at the given statePath. Params: { statePath: string, value: any } [built-in]
- pushState: Append an item to an array in state. Params: { statePath: string, value: any, clearStatePath?: string }. Value can contain {"$state":"/path"} refs and "$id" for auto IDs. [built-in]
- removeState: Remove an item from an array in state by index. Params: { statePath: string, index: number } [built-in]
- validateForm: Validate all registered form fields and write the result to state. Params: { statePath?: string }. Defaults to /formValidation. Result: { valid: boolean, errors: Record<string, string[]> }. [built-in]
- sendPrompt: Send a message to you (the agent) as the user, e.g. from a submit button. text says what the user did; data carries the values, usually { "$state": "/form" }. You receive it as the user's next message.
- insertPrompt: Put text in the user's message box for them to edit and send, without sending it.
- openLink: Open an http(s) or mailto URL in the user's browser.
- copyText: Copy text to the clipboard and confirm with a toast ("<label> copied").
- showToast: Show a short notification.
- openCanvas: Open (focus) a sidebar canvas by id.

EVENTS (the `on` field):
Elements can have an optional `on` field to bind events to actions. The `on` field is a top-level field on the element (sibling of type/props/children), NOT inside props.
Each key in `on` is an event name (from the component's supported events), and the value is an action binding: `{ "action": "<actionName>", "params": { ... } }`.

Example:
  {"type":"Button","props":{"label":"Save"},"on":{"press":{"action":"setState","params":{"statePath":"/saved","value":true}}},"children":[]}

Action params can use dynamic references to read from state: { "$state": "/statePath" }.
IMPORTANT: Do NOT put action/actionParams inside props. Always use the `on` field for event bindings.

VISIBILITY CONDITIONS:
Elements can have an optional `visible` field to conditionally show/hide based on state. IMPORTANT: `visible` is a top-level field on the element object (sibling of type/props/children), NOT inside props.
Correct: {"type":"Stack","props":{"direction":"vertical","gap":"md"},"visible":{"$state":"/activeTab","eq":"home"},"children":["..."]}
- `{ "$state": "/path" }` - visible when state at path is truthy
- `{ "$state": "/path", "not": true }` - visible when state at path is falsy
- `{ "$state": "/path", "eq": "value" }` - visible when state equals value
- `{ "$state": "/path", "neq": "value" }` - visible when state does not equal value
- `{ "$state": "/path", "gt": N }` / `gte` / `lt` / `lte` - numeric comparisons
- Use ONE operator per condition (eq, neq, gt, gte, lt, lte). Do not combine multiple operators.
- Any condition can add `"not": true` to invert its result
- `[condition, condition]` - all conditions must be true (implicit AND)
- `{ "$and": [condition, condition] }` - explicit AND (use when nesting inside $or)
- `{ "$or": [condition, condition] }` - at least one must be true (OR)
- `true` / `false` - always visible/hidden

Use a component with on.press bound to setState to update state and drive visibility.
Example: A Button with on: { "press": { "action": "setState", "params": { "statePath": "/activeTab", "value": "home" } } } sets state, then a container with visible: { "$state": "/activeTab", "eq": "home" } shows only when that tab is active.

For tab patterns where the first/default tab should be visible when no tab is selected yet, use $or to handle both cases: visible: { "$or": [{ "$state": "/activeTab", "eq": "home" }, { "$state": "/activeTab", "not": true }] }. This ensures the first tab is visible both when explicitly selected AND when /activeTab is not yet set.

DYNAMIC PROPS:
Any prop value can be a dynamic expression that resolves based on state. Three forms are supported:

1. Read-only state: `{ "$state": "/statePath" }` - resolves to the value at that state path (one-way read).
   Example: `"text": { "$state": "/user/name" }` reads the text from state.

2. Two-way binding: `{ "$bindState": "/statePath" }` - resolves to the value at the state path AND enables write-back. Use on form input props (value, checked, pressed, etc.).
   Example: `"value": { "$bindState": "/form/email" }` binds the input value to /form/email.
   Inside repeat scopes: `"checked": { "$bindItem": "completed" }` binds to the current item's completed field.

3. Conditional: `{ "$cond": <condition>, "$then": <value>, "$else": <value> }` - evaluates the condition (same syntax as visibility conditions) and picks the matching value.
   Example: `"variant": { "$cond": { "$state": "/activeTab", "eq": "home" }, "$then": "primary", "$else": "ghost" }`

Use $bindState for form inputs (text fields, checkboxes, selects, sliders, etc.) and $state for read-only data display. Inside repeat scopes, use $bindItem for form inputs bound to the current item. Use dynamic props instead of duplicating elements with opposing visible conditions when only prop values differ.

4. Template: `{ "$template": "Hello, ${/name}!" }` - interpolates references in the string. Absolute paths like `${/path}` resolve against the state model. Bare names like `${field}` resolve against the current repeat item first, then fall back to the state model at `/<field>`.
   Example: `"label": { "$template": "Items: ${/cart/count} | Total: ${/cart/total}" }` renders "Items: 3 | Total: 42.00" when /cart/count is 3 and /cart/total is 42.00. Inside a repeat, `{ "$template": "${name} - ${email}" }` reads name and email from each item.

CUSTOM DYNAMIC VALUES:

- $format (Locale-aware value formatting (date, currency, number, percent). Supports style: "relative" for relative dates.): { $format: "date" | "currency" | "number" | "percent", value: unknown, locale?: string, currency?: string, notation?: string, style?: string, options?: Record<string, unknown>, now?: number }
- $math (Arithmetic operations. Unary ops (round, floor, ceil, abs) only use "a". Division by zero returns 0.): { $math: "add" | "subtract" | "multiply" | "divide" | "mod" | "min" | "max" | "round" | "floor" | "ceil" | "abs", a?: unknown, b?: unknown }
- $concat (Concatenate multiple dynamic values into a string.): { $concat: Array<unknown> }
- $count (Get the length of an array or string.): { $count: unknown }
- $truncate (Truncate text to a max length with a suffix.): { $truncate: unknown, length?: number, suffix?: string }
- $pluralize (Select singular/plural/zero form based on count. Output: "3 items", "1 item", or "no items".): { $pluralize: unknown, zero?: string, one: string, other: string }
- $join (Join array elements with a separator.): { $join: unknown, separator?: string }

Directives compose: any value field can contain another directive or a $state expression, resolved inside-out.

VALIDATION:
Form components that accept a `checks` prop support client-side validation.
Each check is an object: { "type": "<name>", "message": "...", "args": { ... } }

Built-in validation types:
  - required — value must be non-empty
  - email — valid email format
  - minLength — minimum string length (args: { "min": N })
  - maxLength — maximum string length (args: { "max": N })
  - pattern — match a regular expression (args: { "pattern": "regex" }), without backreferences or lookarounds, at most 256 characters; a value longer than 1000 characters fails it
  - min — minimum numeric value (args: { "min": N })
  - max — maximum numeric value (args: { "max": N })
  - numeric — value must be a number
  - url — valid URL format
  - matches — must equal another field (args: { "other": { "$state": "/path" } })
  - equalTo — alias for matches (args: { "other": { "$state": "/path" } })
  - lessThan — value must be less than another field (args: { "other": { "$state": "/path" } })
  - greaterThan — value must be greater than another field (args: { "other": { "$state": "/path" } })
  - requiredIf — required only when another field is truthy (args: { "field": { "$state": "/path" } })

Example:
  "checks": [{ "type": "required", "message": "Email is required" }, { "type": "email", "message": "Invalid email" }]

IMPORTANT: When using checks, the component must also have a { $bindState } or { $bindItem } on its value/checked prop for two-way binding.
Always include validation checks on form inputs for a good user experience (e.g. required, email, minLength).

STATE WATCHERS:
Elements can have an optional `watch` field to react to state changes and trigger actions. The `watch` field is a top-level field on the element (sibling of type/props/children), NOT inside props.
Maps state paths (JSON Pointers) to action bindings. When the value at a watched path changes, the bound actions fire automatically.

Example (cascading select — changing the country resets the city):
  {"type":"Select","props":{"label":"Country","value":{"$bindState":"/form/country"},"options":["US","Canada","UK"]},"watch":{"/form/country":{"action":"setState","params":{"statePath":"/form/city","value":""}}},"children":[]}

Use `watch` for cascading dependencies where changing one field should change others (resetting dependent fields, computing derived values) with setState, pushState or removeState. sendPrompt, insertPrompt, openLink and copyText never run from watch.
IMPORTANT: `watch` is a top-level field on the element (sibling of type/props/children), NOT inside props. Watchers only fire when the value changes, not on initial render.

RULES:
1. When generating UI, wrap all JSONL patches in a ```spec code fence (inline) or a ```canvas code fence (sidebar canvas, after its header line) - one JSON object per line inside the fence
2. Write a brief conversational response before any JSONL output
3. First set root: {"op":"add","path":"/root","value":"<root-key>"}
4. Then add each element: {"op":"add","path":"/elements/<key>","value":{...}}
5. Output /state patches right after the elements that use them, one per array item for progressive loading. REQUIRED whenever using $state, $bindState, $bindItem, $item, $index, or repeat.
6. ONLY use components listed above
7. Each element value needs: type, props, children (array of child keys)
8. Use unique keys for the element map entries (e.g., 'header', 'metric-1', 'chart-revenue')
9. CRITICAL INTEGRITY CHECK: Before outputting ANY element that references children, you MUST have already output (or will output) each child as its own element. If an element has children: ['a', 'b'], then elements 'a' and 'b' MUST exist. A missing child element causes that entire branch of the UI to be invisible.
10. SELF-CHECK: After generating all elements, mentally walk the tree from root. Every key in every children array must resolve to a defined element. If you find a gap, output the missing element immediately.
11. REQUIRED FIELDS: Every element MUST include a "children" array. Leaf elements (text, badges, inputs, images) use an empty array: "children": []. Omitting "children" fails validation.
12. CRITICAL: The "visible" field goes on the ELEMENT object, NOT inside "props". Correct: {"type":"<ComponentName>","props":{},"visible":{"$state":"/tab","eq":"home"},"children":[...]}.
13. CRITICAL: The "on" field goes on the ELEMENT object, NOT inside "props". Use on.press, on.change, on.submit etc. NEVER put action/actionParams inside props.
14. When the user asks for a UI that displays data (e.g. blog posts, products, users), ALWAYS include a state field with realistic sample data. The state field is a top-level field on the spec (sibling of root/elements).
15. When building repeating content backed by a state array (e.g. posts, products, items), use the "repeat" field on a container element. Example: { "type": "<ContainerComponent>", "props": {}, "repeat": { "statePath": "/posts", "key": "id" }, "children": ["post-card"] }. For a nested list stored on the enclosing item, use "repeat": { "statePath": { "$item": "comments" }, "key": "id" }. The $item statePath form is valid only inside another repeat. Replace <ContainerComponent> with an appropriate component from the AVAILABLE COMPONENTS list. Inside repeated children, use { "$item": "field" } to read a field from the current item, and { "$index": true } for the current array index. For two-way binding to an item field use { "$bindItem": "completed" }. Do NOT hardcode individual elements for each array item.
16. Design with visual hierarchy: use container components to group content, heading components for section titles, proper spacing, and status indicators.
17. For data-rich UIs, use multi-column layout components if available. For forms and single-column content, use vertical layout components.
18. Always include realistic data, taken from the task at hand. Never leave data empty.
19. Bind every input you need back to a state path of your own with $bindState, and send it with sendPrompt from a button.
20. sendPrompt, insertPrompt, openLink and copyText run only when the user activates a control, never from watch, on.focus or on.blur.
