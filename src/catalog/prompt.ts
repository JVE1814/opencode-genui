import { standardDirectives } from "@json-render/directives"
import { CANVAS_LANGUAGE, DEFAULT_CANVAS, INLINE_LANGUAGE, RENDER_UNITS, TEXT_PER_UNIT } from "../shared/constants.ts"
import { formatSentMessage, MAX_SENT_MESSAGE, MAX_TEXT_WITH_DATA, TRUNCATED } from "../shared/message.ts"
import { MAX_PATTERN_INPUT, MAX_PATTERN_LENGTH } from "../protocol/pattern.ts"
import {
  actionDefinitions,
  describeActivations,
  getCatalog,
  listOf,
  OUTWARD_BURST,
  OUTWARD_INTERVAL_MS,
} from "./index.ts"

const FENCE = "```"
const SPEC = `${FENCE}${INLINE_LANGUAGE}`
const CANVAS = `${FENCE}${CANVAS_LANGUAGE}`

const indent = (text: string, by = "  ") =>
  text
    .split("\n")
    .map((line) => (line ? by + line : line))
    .join("\n")

/** showToast's variants, from its params schema: "default", "success" or "error". */
const TOAST_VARIANTS = listOf(
  actionDefinitions.showToast.params.shape.variant.unwrap().options.map((name) => `"${name}"`),
)

const sentExample = formatSentMessage({
  text: "Deploy with these settings",
  data: { env: "production", replicas: 3 },
})

/** How UI works in OpenCode. Comes before json-render's reference, which only knows inline `spec` blocks. */
const OPENCODE_SECTION = `# Interactive UI in OpenCode

You are running in the OpenCode desktop app. Besides text, you can show interactive UI: you write a json-render spec (JSONL lines of RFC 6902 JSON Patch) in a fenced block of your reply, and the app renders it with its own components and theme.

## When to use UI

Use UI when the user would rather click or scan than read: collecting input (forms), choosing between options, dashboards and status, comparisons, previews, step-by-step flows. Use plain text for explanations, short answers and code; a greeting or a clarifying question never needs UI. Write a sentence or two before a UI, and do not repeat the UI's content in prose.

## Inline UI: ${SPEC}

- A ${SPEC} block renders in place in your reply when its closing fence arrives, not while it streams.
- Each block is one self-contained UI: it sets /root and adds every element and all the state it uses. Blocks never share elements or state.
- An optional first line is a header: {"id":"<stable-id>","title":"..."}. When you send a block again with the same id (say, with an extra field or an error message), what the user already entered is kept.
- It sits in the transcript, about 740px wide.

## Canvas: ${CANVAS}

A canvas is a sidebar tab, about 360px wide, that stays open across turns: use it for dashboards, status boards, checklists, plans or previews that you keep updating while you work.

- The first line is the header: {"canvas":"<id>","title":"..."}, with a short lowercase id ("${DEFAULT_CANVAS}" when omitted).
- A block that sets /root and adds that root element replaces the canvas: a new UI with fresh state.
- Any other block patches the canvas as it is, with RFC 6902 ops (add, replace, remove, move, copy) on /elements/<key>, /elements/<key>/props/<prop> and /state/.... Replacing /root with an element the canvas has switches the view, keeping the state and what the user entered.
- {"canvas":"<id>","close":true} on its own removes the canvas.
- The canvas renders while the block streams, so write /root and the layout first and the data after.
- Several canvases can exist, one tab each; give each its own id.
- If unsure what a canvas holds now (say, the chat was compacted), send the whole canvas again, with /root.
- In your reply the block shows as a small chip that opens the canvas.

A canvas, then a later block that patches it:

${CANVAS}
{"canvas":"deploy","title":"Deploy"}
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Production deploy"},"children":["rollout","steps"]}}
{"op":"add","path":"/elements/rollout","value":{"type":"Progress","props":{"label":"Rollout","value":{"$state":"/progress"}},"children":[]}}
{"op":"add","path":"/elements/steps","value":{"type":"Table","props":{"columns":["Step","Status"],"rows":{"$state":"/steps"}},"children":[]}}
{"op":"add","path":"/state/progress","value":40}
{"op":"add","path":"/state/steps","value":[["Build","done"],["Migrate","running"],["Switch traffic","pending"]]}
${FENCE}

${CANVAS}
{"canvas":"deploy"}
{"op":"replace","path":"/state/progress","value":70}
{"op":"replace","path":"/state/steps/1/1","value":"done"}
${FENCE}

The rest of this skill describes the patch lines. They are the same in both fences; in a ${CANVAS} block they follow the header.

## When the user interacts

Inputs keep what the user enters. Bind each input you want back to a state path you choose ({"$bindState":"/form/email"}), then send it with sendPrompt.

- sendPrompt { text, data? } sends a user message that you then answer as usual: the text (cut after about ${MAX_TEXT_WITH_DATA.toLocaleString("en-US")} characters when there is data), a blank line, then the data as the last fenced json block (pretty-printed, cut after about ${MAX_SENT_MESSAGE.toLocaleString("en-US")} characters); a cut ends in "${TRUNCATED}". Write text as the user's own words for what they did; data is usually {"$state":"/form"}. A button with params {"text":"Deploy with these settings","data":{"$state":"/form"}} sends:

${indent(sentExample)}

- insertPrompt { text } puts text in the message box for the user to edit and send.
- openLink { url } opens an http(s) or mailto URL. copyText { text, label? } copies to the clipboard. showToast { title, description?, variant? } shows a notification; variant is ${TOAST_VARIANTS}. openCanvas { canvas } shows a canvas tab.
- sendPrompt, insertPrompt, openLink and copyText leave the UI, so they run only when the user activates a control: ${describeActivations()}. Bound anywhere else (watch, on.focus, on.blur, a Slider's on.change) they never run. One activation runs at most ${OUTWARD_BURST} of them, in order (say, copyText then openLink); the next activation in the same UI must come at least ${OUTWARD_INTERVAL_MS / 1000} s later. The app may ask the user to confirm first, showing exactly what will be sent, opened or copied.
- Arrow keys in Radio and Tabs move the choice without sending it; Space, Enter or a click sends it. A choice the user should look over first is best sent from a Button.
- "confirm" on an action binding asks the user first, e.g. {"action":"sendPrompt","params":{"text":"Delete the branch"},"confirm":{"title":"Delete branch?","message":"This cannot be undone.","variant":"danger"}}. It works for the custom actions only, not for setState, pushState, removeState or validateForm, and never in watch, on.focus or on.blur.
- onSuccess runs after a custom action succeeded and onError after it failed. When the user declines a confirm or the app refuses the action, neither runs and the rest of the bound actions stop. Write each onSuccess/onError out as { "action": ..., "params": {...} } or { "set": {...} }: one written as an expression, or read from state, is ignored.
- setState, pushState, removeState and validateForm run neither: to do something after one, list it next in an array ("press":[{"action":"setState",...},{"action":"showToast",...}]).
- Use setState, pushState and removeState for changes within the UI (tabs, toggles, list edits); they need no round trip to you.

## Design

The UI always takes the app's design and follows the user's theme and light or dark mode, so there are no color, style or className props: choose components and variants, not looks.

- Keep it compact: a UI shows at most about ${RENDER_UNITS.toLocaleString("en-US")} elements, or ${(RENDER_UNITS * TEXT_PER_UNIT).toLocaleString("en-US")} characters of text, in all. Prefer Card, Stack and Grid for layout, Headings for structure, Badge and Stat for status, and at most one primary Button per UI.
- Put realistic data in /state, taken from the task at hand.
- Give each repeat a "key" (an id field): what the user enters in an item then stays with it when you add, remove or reorder items.
- Never put secrets (API keys, tokens, passwords) in a spec: it stays in the transcript.`

/** One line that opens json-render's part: it fits an agent that also writes text, unlike json-render's default. */
const SYSTEM = `You can answer with interactive UI as well as text. This reference covers the JSONL patch lines inside ${SPEC} and ${CANVAS} blocks.`

// The OpenCode section already says there are no style props and never to put secrets in a spec.
const RULES = [
  "Bind every input you need back to a state path of your own with $bindState, and send it with sendPrompt from a button.",
  "sendPrompt, insertPrompt, openLink and copyText run only when the user activates a control, never from watch, on.focus or on.blur.",
]

/**
 * Minimal edits to json-render's generated prompt where it contradicts OpenCode or this catalog: it only knows the
 * `spec` fence, its dynamic-prop examples set colors, its watch example calls an action that does not exist here (on a
 * Select without its required label) and suggests watch for loading data, its event examples bind `press` on the first
 * catalog component (Stack, which has no events), it says `$item` params resolve to a path (genui's own actions get the
 * value), its `pattern` check knows no limits, its sample data is about blogs and shops rather than the task, and two
 * of its rules repeat another ("ONLY use components listed above"). Each `from` must occur in the generated text; a test
 * checks that, so a json-render update that changes the wording fails loudly.
 */
export const PROMPT_FIXES: readonly { readonly from: string; readonly to: string }[] = [
  {
    from: "When generating UI, wrap all JSONL patches in a ```spec code fence - one JSON object per line inside the fence",
    to: `When generating UI, wrap all JSONL patches in a ${SPEC} code fence (inline) or a ${CANVAS} code fence (sidebar canvas, after its header line) - one JSON object per line inside the fence`,
  },
  {
    from: 'Example: `"color": { "$state": "/theme/primary" }` reads the color from state.',
    to: 'Example: `"text": { "$state": "/user/name" }` reads the text from state.',
  },
  {
    from: '`"color": { "$cond": { "$state": "/activeTab", "eq": "home" }, "$then": "#007AFF", "$else": "#8E8E93" }`',
    to: '`"variant": { "$cond": { "$state": "/activeTab", "eq": "home" }, "$then": "primary", "$else": "ghost" }`',
  },
  {
    from: "Example (cascading select — country changes trigger city loading):",
    to: "Example (cascading select — changing the country resets the city):",
  },
  {
    from: '{"type":"Select","props":{"value":{"$bindState":"/form/country"},',
    to: '{"type":"Select","props":{"label":"Country","value":{"$bindState":"/form/country"},',
  },
  {
    from: '"watch":{"/form/country":{"action":"loadCities","params":{"country":{"$state":"/form/country"}}}}',
    to: '"watch":{"/form/country":{"action":"setState","params":{"statePath":"/form/city","value":""}}}',
  },
  {
    from: '{"type":"Stack","props":{"direction":"vertical","gap":"md"},"on":{"press":',
    to: '{"type":"Button","props":{"label":"Save"},"on":{"press":',
  },
  {
    from: 'Example: A Stack with on: { "press":',
    to: 'Example: A Button with on: { "press":',
  },
  {
    from: '{ "$item": "field" } resolves to the absolute state path,',
    to: '{ "$item": "field" } resolves to the absolute state path for built-ins bound directly (to the field\'s value for sendPrompt and the other custom actions, and anywhere in an onSuccess/onError chain),',
  },
  {
    from: '- pattern — match a regex (args: { "pattern": "regex" })',
    to: `- pattern — match a regular expression (args: { "pattern": "regex" }), without backreferences or lookarounds, at most ${MAX_PATTERN_LENGTH} characters; a value longer than ${MAX_PATTERN_INPUT} characters fails it`,
  },
  {
    from: "Include realistic sample data in state. For blogs: 3-4 posts with titles, excerpts, authors, dates. For product lists: 3-5 items with names, prices, descriptions. Never leave arrays empty.",
    to: "Include realistic data in state, taken from the task at hand. Never leave arrays empty.",
  },
  {
    from: "Always include realistic, professional-looking sample data. For blogs include 3-4 posts with varied titles, authors, dates, categories. For products include names, prices, images. Never leave data empty.",
    to: "Always include realistic data, taken from the task at hand. Never leave data empty.",
  },
  {
    from: "and status indicators. ONLY use components from the AVAILABLE COMPONENTS list.",
    to: "and status indicators.",
  },
  {
    from: "use vertical layout components. ONLY use components from the AVAILABLE COMPONENTS list.",
    to: "use vertical layout components.",
  },
  {
    from: "Use `watch` for cascading dependencies where changing one field should trigger side effects (loading data, resetting dependent fields, computing derived values).",
    to: "Use `watch` where changing one field should change others (resetting dependent fields, deriving values) with setState, pushState or removeState, at most 8,000 of them per change. sendPrompt, insertPrompt, openLink and copyText never run from watch.",
  },
]

/** json-render's catalog prompt for this catalog, before PROMPT_FIXES. */
export function catalogPrompt(rules: readonly string[] = []): string {
  return getCatalog().prompt({
    mode: "inline",
    system: SYSTEM,
    customRules: [...RULES, ...rules],
    directives: standardDirectives,
  })
}

/** Applies PROMPT_FIXES. A fix whose text is missing is skipped. */
export function applyPromptFixes(text: string): string {
  return PROMPT_FIXES.reduce((result, fix) => result.split(fix.from).join(fix.to), text)
}

/**
 * The agent's full UI instructions, the body of the `genui` skill: the OpenCode section (surfaces, interaction, design),
 * then json-render's catalog prompt (format, components, actions, expressions, rules). `rules` are appended to the
 * rules list.
 */
export function buildPrompt(options: { readonly rules?: readonly string[] } = {}): string {
  return `${OPENCODE_SECTION}\n\n# Spec format and catalog (json-render)\n\n${applyPromptFixes(catalogPrompt(options.rules ?? []))}`
}
