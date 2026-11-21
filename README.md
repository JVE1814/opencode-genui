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
  Links open only http, https and mailto URLs; images load only http(s) and base64 `data:image` URLs of raster formats
  (never SVG, which the window draws on its main thread: a few hundred bytes of nested shapes froze it for 43 s), and
  remote images wait for a click (which asks first, with the full address, where outward actions ask) unless you allow
  them.
- **Outward actions need your activation.** Sending a message, filling the composer, opening a link and copying run
  only when you deliberately activate a control of that UI: pressing a Button or Link, picking from a DropdownMenu or
  Table, Enter in an Input, or a choice in a Select, Radio, Checkbox, Switch, Toggle, ToggleGroup, ButtonGroup,
  Pagination or Tabs. Never from `watch`, focus, blur, typing or slider movement, and never from an `onSuccess`/`onError`
  handler read from state. One activation may run up to 3 of them (copy a code, then open a page); the next activation
  of that UI needs a second's gap, and a choice made sooner is sent once the second has passed (only the control's
  latest). Arrow keys in a Radio or Tabs only move the choice; Space, Enter or a click sends it (nothing, when the
  arrows brought it back to where it started). On a closed Select, arrow keys and typed characters (with Alt too) do
  nothing (the app's select would choose with them): its list opens with ArrowDown, Enter or Space.
- **Confirms show everything.** genui asks first when your setting says so, or when the spec asks. The dialog shows the
  whole payload (the full message with its data, the URL, the copied text) last and labelled, with line breaks shown as
  ↵ (the app's dialog runs its text together), invisible and blank characters spelled out, long runs counted, its
  length when it is long, and text hidden in Unicode tag characters decoded.
- **Blocks outside the agent's reply are untrusted.** A ` ```spec ` block in tool output or a previewed file is marked as
  such and asks before every outward action (by default), in genui's own words only: the spec's own title and message
  for the confirm are not shown (in one run of plain text, nothing could keep them from passing for genui's words). It
  gets state of its own (it cannot read or change the agent's UI with the same `id`), and has no "Ask agent to fix". It opens a Dialog or
  Drawer only during an activation of one of its controls: not by itself, and not while another of its choices waits for
  the gap, a message it sent is still on its way, or the actions of an activation wait for a later task (see below). A
  Dialog that an activation opened still opens when the render budget's task slice mounts it in a later task, within the
  activation's 5 s. Trust is decided by the block's exact text.
- **Passwords stay in memory.** What you type into a password Input is never written to stored UI state, also after
  the agent's next version of the UI drops that Input. Other edits are stored per session (up to 50 surfaces) so they
  survive reloads, until **Clear stored UI state**: per surface as many of its newest whole user actions (a click or
  key press with everything it sets off, also what runs in later tasks) as fit in 256 KB as stored and 4,000 edits
  (the newest whatever its number of edits); the stored edits record their actions, so a reload never restores half
  of a select-all, and an older action that no longer fits beside the newer ones is left out whole. The live UI keeps
  up to 10,000 edits (the oldest go a thousand at a time), holding up to 8 million characters (32 million for all UIs
  in the window); an edit past that is ignored.
- **Bounded work.** The work a spec can give the window, with or without your clicks, is bounded in these ways:
  - Validation patterns run on a linear-time matcher (no backreferences or lookarounds) with a shared work budget, and
    the other checks read at most 512 characters as a number (8,192 as a URL); Markdown is prepared, where a spec's
    password fields write is found, and json-render's check of a spec's repeat paths runs (on every streamed change of
    a canvas), in time linear in their size: an element is checked at most twice (in a repeat or not), plus once for
    each list with items in state that it can repeat over (at most 64).
  - A JSON pointer (a patch's path, or a state path that an action, a binding, a repeat or a watch names) has at most
    64 levels and 2,048 characters. A patch line with a longer one is a line error, nothing is written to a longer state
    path, and the validator reports one where the spec writes it out.
  - An element keeps at most 32 props (its component's own first) and watches at most 32 state paths; the rest are
    ignored and reported. json-render resolves an element's props and subscribes its watches for every instance of it
    (each entry of a parent's children, each row of a repeat), before it knows whether the instance renders (what
    those props keep is bounded: see below).
  - Elements nest at most 20 levels deep (the stack overflowed past about 50): a deeper one is not shown, and the UI
    says so. An element whose component throws shows nothing, and the UI lists its error.
  - What the app's Markdown renderer does with a text is bounded too: past a budget per text (in proportion to its
    length), emphasis markers (`*`, `_`, `~`) that marked would search a paragraph for show as plain characters, and so
    does inline math past about 20,000 characters of math (display math past it shows as a code block). Past a
    paragraph's first 100 backslash escapes, escapes are written as character references, which display the same, and
    so is the text of the links genui writes for bare addresses. genui reads a text's blocks with one model of marked's
    block lexer (the app's parser; the tests compare the two on generated documents), so what it counts is what marked
    renders. The render budget charges a text by the model's reading of it as written, in time linear in its length,
    whether or not the text then shows. A text that renders is read once more as genui hands it to marked: making links
    and tags inert lengthens lines, and marked decides some blocks by a line's length (a list item's or a quote's lines
    that are not indented), so where the model reads the two differently the text is cut, at that line; it then shows
    less than it was charged for, never more. A text shows up to 500,000 characters, and is cut where one run of
    inline text (a paragraph, a list item's text, a heading or a table cell, as marked lexes them) passes 20,000
    characters, since marked's inline work grows faster than a paragraph; where lists or quotes nest deeper than 8;
    where its paragraphs, headings, rules, quotes, list items and table cells, with its links, emphases, code spans,
    math and line breaks (each a node the renderer builds; counted so as never to fall short of what marked builds),
    pass 10,000 beyond one per 25 characters; or where marked's block lexer would do more than 40 million characters'
    worth of scanning beyond what it reads, in the text as genui hands it (about 0.1 s; making an address inert makes
    its line up to ten times longer; marked reads lines again where no blank line separates them in a list item or a
    quote, or between rules, and lines that start with spaces or with `|`, `:` or `-` cost it more: a quoted list of
    80 KB whose items go on to lines without the `>` shows whole). A note says "Showing the first N of M characters",
    and the agent gets an issue that says why. A text shows its first 32 fenced code blocks as code blocks of their own
    (the app's code block component) and the rest as code within its Markdown; every code block marked renders (fenced
    or indented, in a quote or a list item too) and every display math block costs the render budget, 4 units on its
    own and 1 within the Markdown, and so do its blocks and inline elements beyond one per 25 characters, a tenth of a
    unit each, as Table cells (a large text of tiny links or emphases costs more than a UI holds, and is refused).
  - State actions in a row (setState, pushState, removeState), and the first actions of the watches one change wakes,
    run in one batch, so the UI re-evaluates once instead of once per write; a write calls only the watches of its own
    path, and a watch is not woken by its own writes. `validateForm` checks every field and writes all results at once;
    each field shows only its own result, a hundred fields per frame. After the agent's patch, the edits you made in a
    list follow their items by looking them up, not by searching the list: by key, by whole item, or by the item apart
    from what the edit changed. Each value is hashed and each pair of values compared at most once per patch, so an
    edit costs the depth of its path, not the size of its item; a patch hashes at most 200,000 list items and visits 4
    million values in all (past that, an edit not matched yet stays at its index if its list kept its length and
    nothing about it is left to compare, and goes otherwise; the UI says so). The state the UI reads keeps its objects
    where their content did
    not change (json-render compares them by identity), and saving your edits checks each list item they go through
    once.
  - One change (a key press, a click, or anything else in one task) with all it sets off runs at most 4,000 watch
    wakes, 8,000 state actions (a select-all over a full UI whose rows write four times each) and 64 awaited actions
    (validateForm, custom actions) or actions of watches woken by other watches, counted across every UI in the
    window; the rest is skipped, the console says so and the UI shows an issue. Each of your input events counts
    afresh.
  - Once actions have run for 50 ms in one task, the rest of a list woken directly waits for the next task, so the
    window answers in between; a change goes on so over as many tasks as it takes, within the counts above, however
    slow the machine. Watches set off by other watches stop, and work the UI sets off as it renders while lists wait is
    skipped where it would wait once 40 such works have waited (so are lists that waited 40 tasks in a row without
    any action running). While an activation's actions wait so, its permission to act outward or open a modal is set
    aside, and they go on in a task of their own.
  - `$template`, `$concat` and `$join` build at most a million characters each, 4 million per task in all, and 4
    million for the actions of one change (also in its later tasks); past that the prop is left empty and an action
    using it does not run. What expressions build is also kept: every element instance (each row of a repeat, each
    entry of a parent's children, rendered or not) keeps its resolved props, so what they keep is bounded too, at most
    2 million characters per UI (a list or object built counts one per entry, a directive's text its length), in the
    same window-wide shares as rendering: 6 million for the agent's inline UIs (of which the newest keeps 2 million), 4
    million for canvases, and 2 million each for older copies and for blocks in tool output or files. Past that a prop
    is left empty, the UI says so, and the agent gets an issue ("left some of its props empty"); it fills in once room
    is freed. A list in state is turned into text only as far as there is room; `$truncate`, `$math`,
    `$pluralize` and `$format` read it only as far as their result needs, and `$format` makes one formatter per
    directive. A requested confirm's text reads at most a million characters from state, and stops once its shown
    length is reached.
  - Evaluating expressions is bounded too: one evaluation (an element's props or `visible`, an action's param, a field's
    validation) visits at most 100,000 expression nodes and stops after 200 ms, the first of a task included; once
    expressions have been evaluated for 50 ms in one task, the elements left are evaluated in the next tasks (each task
    evaluates at least one), and evaluations that are not for rendering stop once a task has evaluated for 400 ms.
    Until then an element shows nothing, or keeps what it showed; past a bound the prop is left empty, the action does
    not run, and the field counts as invalid. Numbers and dates are read from at most 512 characters.
  - A UI shows at most about 2,000 elements or 500,000 characters of text in all, and builds at most 4,000 child
    elements, each counted once more for every 250 characters it is written with, or that its `$template`, `$concat`,
    `$join` and `$truncate` build from the state they read now (an expression that surely builds more than a million
    characters keeps nothing and is not counted), where it is built (a repeat counts
    its rows times its children, so a repeat inside a repeat is the product of both lists, and an element listed 4,000
    times is refused before json-render resolves it 4,000 times); a
    repeat shows at most 2,000 rows, its first ones as far as they fit (only those rows are matched to the list's items,
    in linear time, so a long list costs no more than the rows it shows), and its rows share their element's values that
    hold no expression instead of copying them. A Table counts its cells and a Chart its points (drawn and listed for
    screen readers), ten to an element; a Table shows at most 500 rows, 50 columns and 10,000 cells, and a Chart 500
    labels and 6 series. A component that draws a list prop item by item draws at most: Keybind 16 keys; Radio, Tabs,
    ToggleGroup, ButtonGroup and DropdownMenu 200 items; Select, Accordion and Carousel 500, and each item drawn counts
    in the render budget (a radio option 0.4 units, a tab, key or button 0.2, an Accordion section 0.8). What a
    component leaves out is said under it ("Showing 200 of 10,000 options") and reported as an issue (twenty such issues
    per UI, the rest counted in one). The UIs in the window also share one bound per kind: about 6,000 for the agent's
    inline UIs (of which the newest one, mounted last, always keeps 2,000), 4,000 for canvases, 2,000 for older copies
    of a UI the agent sent again, and 2,000 for blocks in tool output or files, so twenty copies of a large block render
    once and never take the newest copy's room. What does not fit is reported as an issue and comes back once room is
    freed. Rendering more than about 1,000 elements or 100 ms in one task continues in the next tasks. Mounting a UI
    counts in that too: about ten elements' worth for each UI (its providers, chrome, and issues panel or error card),
    half that for a canvas chip or source view, plus one per 250 characters of its block. In a task of the app's (a
    message arriving, a session shown again), UIs mount for at most 50 ms (at least one); the rest show as empty boxes
    as tall as the UI was (or is expected to be) and mount, in order, in the next tasks. One edit of state holds at most
    a million characters, and `copy` operations add at most a million characters to a spec in all (a copy
    shares what it copies, so copies of copies doubled the state at each step); a copy past that is left out and
    reported.
  - A Dialog or Drawer never opens from focus, blur, a slider or a browsed choice, and the focus moves it makes as it
    opens and closes do not run a field's `on.focus` or `on.blur`. It opens at most once per task at its path (a second
    one bound to the same path stays closed while the first shows), never again in a task in which it closed, and at
    most 8 modals open per task in the whole window, counted per UI state, so a remounted Dialog counts too. Once you
    dismiss one (Escape, its close button, its backdrop), only a press or another activation opens a modal of that UI,
    until you activate one of its controls or the agent sends a new version of it; for 1.5 s that holds in every UI.
  - A session has at most 32 canvases open (each opens a tab). A block for another canvas is not applied (nor a
    later patch to it, until it is sent again whole while there is room): its chip says it was not opened, and the
    newest canvas reports how many were not, until one is closed. Each block counts the canvases open where it is in
    the conversation. A canvas the agent closes in the reply that opened it takes its tab with it; sent again whole, it
    opens its tab again (never one you closed). At most 32 of the tabs genui opened by itself stay open in a session:
    a new canvas takes the place of the oldest tab of a canvas the agent closed (at most 32 canvases are open, so it
    always finds one). After the app restarts, every canvas tab the session's strip kept counts toward the 32.
  - While replies stream, a session keeps the parses of at most 512 blocks and 1,000,000 characters (and the newest
    block), and recent saved versions (8 each) only of canvases still open; genui keeps what it measured of recent
    Markdown texts for at most 64 texts and 2,000,000 characters (and the newest text), and what it prepared of them
    for the app's renderer for at most 2,000,000 characters (and the newest).

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
  quote, or past a text's 32nd, stays with the app's renderer: its copy button may copy invisible joiners. Markdown
  links show no favicon, and their address shows in their tooltip rather than the status bar; a link whose text or
  address goes on to another line shows as text.
- A Markdown text is cut at a list item's or a quote's line that goes on without its indentation when making a tag,
  image, link or address in it inert changes how marked reads the lines after it (and at display math past the math
  budget in such lines, which genui shows as a code block); where the lines before it would then read otherwise too,
  it is cut after the fenced code block before them, or shows nothing. The note and the issue say so, and indenting
  those lines avoids it. A quoted list whose items each go on to a line without the `>` is cut for marked's work past
  about 80 KB when those lines are sentences, and sooner when they are shorter (with lines of a few characters marked
  took 3.6 s for 100 KB).
- A Markdown text's links, emphases, code spans, math and line breaks are counted by the characters each needs, so as
  never to count fewer than marked builds: bold counts as two (its two `**` could make two emphases), and so does a
  `[link](…)` whose address holds `://` or `www.`. A text dense with them is charged up to twice what it builds, and
  cut sooner: a 100 KB list of `- **key**: value` items costs about 650 units on top of the 400 its length costs, and
  one of 300 KB is cut at about 150 KB.
- The app's confirm dialog cannot be selected or copied from, and runs its text together: genui shows line breaks in
  the payload as ↵.
- What the bounds above send to later tasks still runs there: a spec at the bounds can keep the window busy in short
  tasks for a few seconds, while it answers in between (a select-all on a much slower machine, for minutes). Some work
  within one task is not split: an element's first evaluation in a task (up to 200 ms), re-rendering what one batch of
  a select-all changed, and one element's own rendering (a Table of 10,000 cells, a Markdown text of 100 KB or of
  10,000 table cells or list items, an open Select of 500 options). Measured in the playground with nothing else
  running: under 0.4 s per task for each (a Markdown text of 11,000 table cells about 0.25 s, of 12,000 list items
  about 0.35 s, of 450,000 characters written to be slow, built with `$template` from state, 0.1 to 0.4 s). A
  Markdown text with as many links as its length pays for (one per 25 characters: 18,000 in 450,000 characters) takes
  0.5 s, most of it the renderer building the links (genui's own part, up to 0.2 s); a denser one is cut, or refused.
- A message of thousands of small blocks keeps the window busy in short tasks for a few seconds while its UIs mount
  (1,700 blocks in 100 KB: about 2 s of work, the longest task 0.25 to 0.45 s here; 4,000 header-only blocks in
  110 KB: one task of 0.55 to 0.7 s, most of it the app's own rendering of the message). Each mounted UI holds about
  100 KB, so those 4,000 blocks take about 300 MB of page memory.
- A canvas whose base is in messages not loaded renders once its spec holds a whole tree, but keeps loading older
  messages, and is saved only once the base is found or the whole history was loaded without finding one (a session
  past 1,000 assistant messages may never settle such a canvas). Edits you make to it meanwhile may be dropped if the
  base found changes its generation.
- A remote image you load (with a click, or by the setting that allows remote images) is whatever its server sends,
  an SVG one too, whose drawing genui cannot bound: a page cannot learn an image's type before the browser draws it,
  and cross-origin reads to check it first are refused. Load images only from addresses you trust.
- A UI whose edits hold 8 million characters (32 million for all UIs in the window) ignores edits that would add to
  them, typing included, until some go (the agent's next version changes their values, or **Clear stored UI state**);
  the console says so.
- A watch acts once its element has rendered: a select-all pressed while a long list is still rendering misses the rows
  that render after it.
- A focused, closed Select stops typed keys, Alt+letter included, so the app's Alt shortcuts do not fire while it has
  focus (the app's select acts on a key even when its default was prevented). After you dismiss a modal, a watch cannot
  open one in that UI until you activate one of its controls or the agent sends a new version (and for 1.5 s, the
  agent's patch cannot either, in any UI); it is closed again quietly.
- Messages a UI sends use the model picked in the composer but the session's current agent: the plugin API does not
  expose the composer's agent.
- In windows narrower than 768 px the app has no side region: canvases show in the session's Canvas view (in the More
  menu), one at a time with a picker. This view has not been verified in the desktop app itself.

## License

MIT. Bundles and adapts [json-render](https://github.com/vercel-labs/json-render) (Apache-2.0); see [NOTICE](NOTICE).
