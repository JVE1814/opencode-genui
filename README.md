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
header: `id` keeps what you typed when the agent re-sends the block, `title` labels it.

### Canvases: ` ```canvas `

````text
```canvas
{"canvas":"migration","title":"Migration checklist"}
{"op":"add","path":"/root","value":"list"}
...
```
````

- The header names the canvas (`main` when omitted). Each canvas is a tab in the session's side panel.
- A block that sets `/root` replaces the canvas; a block without it **patches** it (`{"op":"replace","path":"/state/done/2","value":true}`).
- `{"canvas":"migration","close":true}` removes it.
- Canvases render **while the agent is still writing**, and a new canvas opens its tab automatically (configurable).
- They survive reloads: the transcript is the log, and each canvas's last settled state is also stored, so canvases
  created long ago in a session still open.

### Components

41 components with native implementations: layout (Stack, Grid, Card, Separator, Tabs, Accordion, Collapsible),
content (Heading, Text, Markdown, Code, Badge, Alert, Table, Progress, Skeleton, Spinner, Stat, Icon, Keybind, Image,
Avatar, Chart), input (Input, Textarea, Select, Checkbox, Radio, Switch, Slider, Button, Link, Toggle, ToggleGroup,
ButtonGroup, DropdownMenu, Pagination) and overlays (Dialog, Drawer, Tooltip, Popover, Carousel). All of json-render's
spec features work: state, `$state` / `$bindState` / `$item` / `$cond` / `$template` expressions, `repeat`, `visible`,
`watch`, validation checks, the built-in state actions, and the standard directives (`$format`, `$math`, …).

### Actions

| Action | What it does |
| --- | --- |
| `sendPrompt { text, data? }` | Sends a message to the agent as you: the text, then the data as a fenced JSON block. |
| `insertPrompt { text }` | Puts text in your message box, unsent. |
| `openLink { url }` | Opens an http(s) or mailto link in your browser. |
| `copyText { text }` | Copies to the clipboard. |
| `showToast { title }` | Shows a notification. |
| `openCanvas { canvas }` | Focuses a canvas tab. |

### How the agent learns it

The full catalog and rules (generated from json-render's catalog prompt) are registered as the on-demand skill
`genui`. A short hint tells the agent the skill exists; by default the desktop app attaches it to each session it opens,
so terminal-only sessions are not told to emit UI they cannot show.

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

Desktop settings (**Settings › genui**): how new canvases open (focus / add quietly / off), when outward actions ask
first, and whether remote images load without a click.

## Security model

Specs are written by a model and treated as data:

- No raw HTML; text is rendered as text (Markdown through the app's own renderer).
- Links only open http, https and mailto URLs; images only load http(s) and base64 `data:image` URLs, and remote images
  wait for a click unless you allow them.
- Actions that leave the UI (send a message, fill the composer, open a link, copy) need a real click, are rate limited,
  and ask first when you choose so, when the spec asks for a confirmation, or when the block did not come from the
  assistant's own reply (for example a ` ```spec ` block inside tool output or a previewed file).

## Development

```sh
bun install
bun run dev          # rebuild dist/gui-experimental.cjs on change; the desktop app hot-reloads it
bun run playground   # the plugin in a fake desktop host, with scripted conversations
bun run test         # unit tests
bun run test:e2e     # Playwright against the playground
bun run build        # skill + bundle + bundle checks
```

Point your global config at the checkout to develop against the real app. The desktop bundle and
`skills/genui/SKILL.md` are committed because OpenCode installs plugins with install scripts disabled; CI fails when
either is stale.

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

## License

MIT. Bundles and adapts [json-render](https://github.com/vercel-labs/json-render) (Apache-2.0); see [NOTICE](NOTICE).
