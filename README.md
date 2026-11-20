# opencode-genui

Generative UI for the [OpenCode](https://opencode.ai) desktop app. The agent can answer with interactive UI, built
with Vercel's [json-render](https://json-render.dev):

- **Inline** in the session, where the reply would otherwise be prose: forms, choices, tables, status cards, charts.
- **In sidebar canvases**: tabs in the session's side panel that the agent keeps updating as the work goes on, such as a
  live dashboard, a checklist or a comparison.

Generated UI uses OpenCode's own components and design tokens, so it follows your theme and light/dark mode and looks
like part of the app. Clicks come back to the agent as ordinary messages from you.

> Desktop GUI plugins are an **experimental** OpenCode API (`./gui-experimental`). This plugin targets
> `@opencode/plugin` 2.3.x and may need updates as that API changes.

## Install

Add the plugin to your **global** OpenCode config (the desktop app loads GUI plugins only from there):

```sh
opencode plugin add github:jve1814/opencode-genui
```

or edit `~/.config/opencode/opencode.jsonc` yourself:

```jsonc
{
  "plugins": ["github:jve1814/opencode-genui"],
}
```

To run a local checkout instead, point the entry at its directory (`"plugins": ["/path/to/opencode-genui"]`).

Restart the desktop app, or toggle the plugin under **Settings › Extensions › Plugins**. Then ask for something visual:
"show me a form to configure the deploy", "keep a checklist of the migration in a canvas".

## How it works

The agent writes json-render's standard [SpecStream](https://json-render.dev) format, one JSON patch per line, in a
fenced block in its reply. Nothing new to install on the server and no tool calls: the reply streams as usual and the
desktop app renders the blocks.

### Inline UI: ` ```spec `

````text
Here's the deploy form:

```spec
{"id":"deploy-form","title":"Deploy"}
{"op":"add","path":"/root","value":"card"}
{"op":"add","path":"/elements/card","value":{"type":"Card","props":{"title":"Deploy"},"children":["env","go"]}}
{"op":"add","path":"/elements/env","value":{"type":"Select","props":{"label":"Environment","options":["staging","production"],"value":{"$bindState":"/env"}},"children":[]}}
{"op":"add","path":"/elements/go","value":{"type":"Button","props":{"label":"Deploy","variant":"primary"},"on":{"press":{"action":"sendPrompt","params":{"text":"Deploy","data":{"$state":"/env"}}}},"children":[]}}
{"op":"add","path":"/state/env","value":"staging"}
```
````

The block renders in place once it is complete (until then the app shows its source). The optional first line is a
header: `id` keeps what you typed when the agent re-sends the block (the older copy keeps it too), `title` labels it.
What you change stays on top of the agent's state until the agent writes a new value at the same place: the newest
writer wins. What you change in a list item stays with that item (found by the repeat's `key`) when the agent adds,
removes or reorders items around it, and goes when the agent removes the item.

### Canvases: ` ```canvas `

````text
```canvas
{"canvas":"migration","title":"Migration checklist"}
{"op":"add","path":"/root","value":"list"}
...
```
````

- The header names the canvas (`main` when omitted). Each canvas is a tab in the session's side panel.
- A block that sets `/root` and adds that root element replaces the canvas; any other block **patches** it
  (`{"op":"replace","path":"/state/done/2","value":true}`). Pointing `/root` at an element the canvas already has
  switches the view and keeps its elements and state, also when the block rewrites that element with `replace`, or
  copies or moves one of the canvas's elements there.
- `{"canvas":"migration","close":true}` removes it.
- Canvases render **while the agent is still writing**, and a new canvas opens its tab automatically (configurable).
- They survive reloads: the transcript is the log, and each canvas's last settled state is also stored, so canvases
  created long ago in a session still open; a switch of `/root` whose canvas was created before the loaded messages
  loads them first. A canvas whose reply was reverted stays gone, also when the revert was committed while the app was
  closed (genui asks the server whether that reply still exists, and asks again after a failed request).

### Components

42 components with native implementations: layout (Stack, Grid, Card, Separator, Tabs, Accordion, Collapsible),
content (Heading, Text, Markdown, Code, Badge, Alert, Table, Progress, Skeleton, Spinner, Stat, Icon, Keybind, Image,
Avatar, Chart), input (Input, Textarea, Select, Checkbox, Radio, Switch, Slider, Button, Link, Toggle, ToggleGroup,
ButtonGroup, DropdownMenu, Pagination) and overlays (Dialog, Drawer, Tooltip, Popover, Carousel). All of json-render's
spec features work: state, `$state` / `$bindState` / `$item` / `$cond` / `$template` expressions, `repeat`, `visible`,
`watch`, validation checks, the built-in state actions, and the standard directives (`$format`, `$math`, …).

### Actions

| Action                                        | What it does                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sendPrompt { text, data? }`                  | Sends a message to the agent as you: the text, then the data as a fenced JSON block; long text or data is cut and marked. |
| `insertPrompt { text }`                       | Puts text in your message box, unsent.                                                                                    |
| `openLink { url }`                            | Opens an http(s) or mailto link in your browser.                                                                          |
| `copyText { text, label? }`                   | Copies to the clipboard; the toast names the label ("Install command copied").                                            |
| `showToast { title, description?, variant? }` | Shows a notification (variant: default, success or error).                                                                |
| `openCanvas { canvas }`                       | Focuses a canvas tab.                                                                                                     |

### How the agent learns it

The full catalog and rules (generated from json-render's catalog prompt) are registered as the on-demand skill
`genui`. A short hint tells the agent the skill exists; by default the desktop app attaches it to each session it opens,
so terminal-only sessions are not told to emit UI they cannot show. The session hint ends with a note that it applies
only while the `genui` skill is available, so sessions that keep the hint after you uninstall genui tell the agent to
ignore it. To remove it from a session, set `"instructions": "off"` and open that session in the desktop app once.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:jve1814/opencode-genui",
      "options": {
        // "session" (default): hint attached by the desktop app per session.
        // "always": hint added to every agent request (also terminal sessions).
        // "off": no hint; the skill is still available.
        "instructions": "session",
        // Extra rules for the agent's UI instructions.
        "rules": ["Prefer canvases for anything the user will revisit."],
      },
    },
  ],
}
```

Desktop settings (**Settings › genui**): how new canvases open (open and show / add the tab quietly / don't open),
when to ask before outward actions (always / only for tool output, the default / never), whether remote images load
without a click, and **Clear stored UI state**.

## Security model

Specs are written by a model and treated as data:

- **Text is text.** Markdown goes through the app's renderer, but genui writes every link, image, autolink and bare
  address in it as a link it opens itself, and shows raw HTML as text: nothing in it loads remote content (the app would
  otherwise fetch a favicon for each web link as soon as it renders) or adds markup, whatever the text is built from.
  Links open only http, https and mailto URLs; images load only http(s) and base64 `data:image` URLs, and remote images
  wait for a click (which asks first, with the full address, where outward actions ask) unless you allow them.
- **Outward actions need your activation.** Sending a message, filling the composer, opening a link and copying run
  only when you deliberately activate a control of that UI: pressing a Button or Link, picking from a DropdownMenu or
  Table, Enter in an Input, or a choice in a Select, Radio, Checkbox, Switch, Toggle, ToggleGroup, ButtonGroup,
  Pagination or Tabs. Never from `watch`, focus, blur, typing or slider movement, and never from an `onSuccess`/`onError`
  handler read from state. One activation may run up to 3 of them (copy a code, then open a page); the next activation
  of that UI needs a second's gap, and a choice made sooner is sent once the second has passed (only the control's
  latest). Arrow keys in a Radio or Tabs only move the choice; Space, Enter or a click sends it (nothing, when the
  arrows brought it back to where it started). On a closed Select, arrow keys and letters do nothing (the app's select
  would choose with them): its list opens with ArrowDown, Enter or Space.
- **Confirms show everything.** genui asks first when your setting says so, or when the spec asks. The dialog shows the
  whole payload (the full message with its data, the URL, the copied text) last and labelled, with line breaks shown as
  ↵ (the app's dialog runs its text together), invisible and blank characters spelled out, long runs counted, its
  length when it is long, and text hidden in Unicode tag characters decoded.
- **Blocks outside the agent's reply are untrusted.** A ` ```spec ` block in tool output or a previewed file is marked as
  such and asks before every outward action (by default), keeping genui's own wording; the spec's text appears only
  quoted. It gets state of its own (it cannot read or change the agent's UI with the same `id`), cannot open a Dialog or
  Drawer by itself (also not while another of its choices waits for the gap), and has no "Ask agent to fix". Trust is decided by the block's exact text.
- **Passwords stay in memory.** What you type into a password Input is never written to stored UI state, also after
  the agent's next version of the UI drops that Input. Other edits are
  stored per session (up to 50 surfaces) so they survive reloads, until **Clear stored UI state**.
- **Bounded work.** Validation patterns run on a linear-time matcher (no backreferences or lookarounds) with a shared work
  budget, and Markdown is prepared in time linear in its length. State actions in a row (setState, pushState,
  removeState), and the first actions of the watches one change wakes, run in one batch, so the UI re-evaluates once
  instead of once per write. A watch is not woken by its own writes, and watches set off by other watches stop after 64
  actions without a break (in all, also across remounts), while one change may still wake a watch in every row. A
  Dialog or Drawer opens at most once per task and not in a task in which it closed, so it cannot loop on a field's
  focus and blur, or be re-opened by a watch as you close it. A UI shows at most about 2,000 elements or 500,000
  characters of text in all (a repeat inside a repeat renders the product of both lists; the rest is reported as an
  issue), a repeat at most 2,000 rows, and one edit of its state holds at most a million characters.

## Development

```sh
bun install
bun run dev          # rebuild dist/gui-experimental.cjs on change; the desktop app hot-reloads it
bun run playground   # the plugin in a fake desktop host, with scripted conversations
bun run test         # unit tests
bun run test:e2e     # Playwright against the playground (PW_PORT=5180 to use a dev server on another port)
bun run bundle       # skill + bundle + bundle checks
```

Point your global config at the checkout to develop against the real app. The desktop bundle and
`skills/genui/SKILL.md` are committed because nothing is built when OpenCode installs the plugin: package.json has no
`build`, `prepare` or install script (npm runs one for a git dependency even with scripts disabled, and a unit test
keeps it that way), so `bun run bundle` builds both. CI fails when either is stale.

Layout:

```text
src/index.ts       server part: registers the skill, optional prompt hint (no runtime dependencies)
src/catalog/       components, actions, prompt builder (zod; shared by the prompt and the renderer)
src/protocol/      fence scanner, block parser, immutable patches, canvas folding, validation, normalization
src/runtime/       state stores, session index, snapshots, backfill, per-session activation
src/gui.tsx        desktop entry: CodeBlock renderer, canvas panel, settings, commands
src/gui/           host adapter, native components, styles (OpenCode tokens only)
playground/        fake desktop host for development and end-to-end tests
```

## Limitations

- Inline UI appears when its block is complete; only canvases render progressively (the app passes a code block to
  plugins once its closing fence arrives).
- With `instructions: "session"`, the hint reaches a brand-new session from its second step on; use `"always"` if the
  first reply must already know about UI.
- Desktop only: the web app and the terminal UI show the blocks as code.
- Generated UI keeps clear of the code block's toolbar by measuring it, which relies on the app's markup; so does the
  rule that shortens a spec's source while it streams (it applies only while the app marks the block as still being
  written). Neither, nor flushing edits when the plugin reloads and
  re-sending the session hint after a reconnect, has been verified in the desktop app itself (only in the playground
  and in unit tests).
- A fenced code block in a Markdown list item renders after the item, as a block of its own. One inside a Markdown
  quote stays with the app's renderer: its copy button may copy invisible joiners. Markdown links show no favicon, and
  their address shows in their tooltip rather than the status bar.
- The app's confirm dialog cannot be selected or copied from, and runs its text together: genui shows line breaks in
  the payload as ↵.
- Expressions that repeat a long text are not bounded while they resolve: a `$template` or `$concat` that reads one
  long string from state many times builds the whole result before the UI's size limit leaves it out, so a very large
  block built for it can still exhaust memory.
- Messages a UI sends use the model picked in the composer but the session's current agent: the plugin API does not
  expose the composer's agent.
- In windows narrower than 768 px the app has no side region: canvases show in the session's Canvas view (in the More
  menu), one at a time with a picker. This view has not been verified in the desktop app itself.

## License

MIT. Bundles and adapts [json-render](https://github.com/vercel-labs/json-render) (Apache-2.0); see [NOTICE](NOTICE).
