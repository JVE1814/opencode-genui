# Playground

A fake OpenCode desktop host for developing and testing the plugin without the Electron app. It implements the parts of
the window plugin API that genui uses (`Plugin.define` setup, stores, `CodeBlock`, `Panel`, `MenuItem`, `Command`,
`SettingsPage`, `Style`, layout, sessions, composer, dialogs, toasts, `ctx.ui`, the server client and synced messages)
with the app's real stylesheets and theme, and plays scripted conversations that stream like a model reply.

```sh
bun run playground          # http://localhost:5178
bun run playground:build    # static build in playground/dist (vite preview serves it, bundles included)
bun run test:e2e            # Playwright against the playground
```

## URL parameters

| Parameter         | Effect                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `scenario=<name>` | Conversation to play: `empty` (default), `form`, `canvas`, `invalid`, `gallery`, `history`, `untrusted`.              |
| `speed=<speed>`   | `instant` (tests), `fast`, `normal` (default), `slow`.                                                                |
| `theme=dark`      | Start in dark mode (`data-color-scheme="dark"` on `<html>`). The header button toggles it.                            |
| `plugin=stub`     | Load `playground/stub/gui.tsx`, a tiny plugin for testing the host itself, instead of `src/gui.tsx`.                  |
| `bundle=1`        | Load the **built** `dist/gui-experimental.cjs` (run `bun run bundle` first) through the app's require shim and check. |
| `bundle=stub`     | Same, with the stub plugin built in memory by the same `gui()` preset.                                                |
| `options=<json>`  | Plugin options, as in `opencode.json`, e.g. `options={"instructions":"always"}`.                                      |
| `window=<n>`      | How many of the newest messages the session store holds (default 20, like the app).                                   |
| `persist=0`       | Do not keep storage, the side strip and the transcript across reloads.                                                |

By default the plugin loads from source (`src/gui.tsx`, with `@opencode/plugin/gui` aliased to `fake-sdk/`), so edits
hot-reload. Storage, the side strip and the transcript are kept in `sessionStorage`: reloading the page is "restarting
the app" (the transcript comes back from the "server", the plugin starts again), while a new tab starts clean. Pick a
scenario or press **Restart** to replay it.

## Layout

```text
fake-sdk/        stand-in for @opencode/plugin/gui: re-exports the SDK's own window runtime (usePlugin, createKeyed, ...)
host/            the fake app: context.ts (SetupContext), server.ts (messages, client), layout.ts + region.ts + side.tsx
                 (side panel), timeline.tsx (Markdown and CodeBlock mounting), ui.tsx (ctx.ui), chrome.tsx (shell,
                 palette, settings, toasts), dialogs.tsx, loader.ts (bundle evaluation), theme.ts
scenarios/       scripted conversations (JSONL specs written with build.ts helpers) and the streaming runner
stub/gui.tsx     test plugin used by test/e2e/harness.spec.ts
hooks.ts         window.__genui test hooks
```

## Test hooks

`window.__genui` (typed in `hooks.ts`) records what plugins did and drives the host:

- Records: `prompts` (`client.session.prompt` calls, i.e. `sendPrompt`), `toasts`, `confirms` (with the answer),
  `alerts`, `copies`, `opened` (`openExternal` URLs, never opened), `instructions` (session instruction entries),
  `errors` (renders that threw, setup failures).
- Driving: `runScenario(name)`, `appendUser(text)`, `appendAssistant(text, { stream?, complete? })`,
  `appendText(delta)`, `completeMessage()`, `virtualize(true | false)` (unmount / remount timeline rows, as when they
  scroll off screen), `runCommand("<plugin>.<id>")`, `routeSession(1)`, `setConfirmAnswer(true | false | null)`.
- Reading: `messages()`, `layout()`, `composerText()`, `ready` and `scenarioDone` (promises).

## Fidelity notes

- Code blocks: a block renders through a `CodeBlock` contribution only once its closing fence arrives, in its own Solid
  root inside `[data-component="markdown-code"] > [data-slot="markdown-code-content"]`, with `data-code-content` on the
  wrapper (as packages/session-ui's Markdown does). A render that throws or returns `undefined`/`null` shows the code.
- Panels: tabs in one `group` share one mounted render; other tabs mount while selected; content unmounts while the side
  region is closed. `ctx.layout.open` supports the `open`, `preview`, `append` and `select` modes.
- `ctx.sessions.current()` and `ctx.screen.current()` are undefined during setup and defined once the shell mounts;
  layout writes made before that wait, as in the app.
- Not faked (calls throw "The genui playground does not implement ..."): file and comment models, embeds, `ctx.main`
  Ipcs, most of the server client. `ctx.ui.Markdown` renders fenced blocks as code (no `CodeBlock` content).
