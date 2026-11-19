import {
  createEffect,
  createMemo,
  createSignal,
  For,
  getOwner,
  Match,
  on,
  onCleanup,
  runWithOwner,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { render } from "solid-js/web"
import { CodeBlock, CodeBlockAction, type CodeBlockProps } from "@opencode/plugin/gui"
import type { FenceBlock } from "../../src/protocol/fence.ts"
import type { App } from "./app.ts"
import { Contribution } from "./contribution.tsx"
import { MarkdownView } from "./markdown.tsx"
import { useItems, type Item } from "./registry.ts"
import type { AssistantMessage, AssistantPart, Message } from "./server.ts"
import { CopyButton, Icon, Loader } from "./ui.tsx"

/** The session timeline: the routed session's messages from the client's store, as the app renders them. */
export function Timeline(props: { readonly app: App }) {
  const data = () => props.app.server.ref.data
  const sessionID = () => props.app.sessions.current().id
  const messages = () => data().session.message.list(sessionID()) as unknown as readonly Message[]
  const [loading, setLoading] = createSignal(false)

  return (
    <div data-playground-timeline>
      <Show when={data().session.message.more(sessionID())}>
        <button
          type="button"
          data-component="button-v2"
          data-size="small"
          data-variant="ghost-muted"
          data-playground-load-older
          disabled={loading()}
          onClick={() => {
            setLoading(true)
            void data()
              .session.message.loadMore(sessionID())
              .finally(() => setLoading(false))
          }}
        >
          Load older messages
        </button>
      </Show>
      <Show when={messages().length === 0}>
        <div data-playground-empty>No messages yet. Pick a scenario above, or type below.</div>
      </Show>
      <For each={messages()}>{(message) => <Row app={props.app} message={message} />}</For>
    </div>
  )
}

function Row(props: { readonly app: App; readonly message: Message }) {
  return (
    <div
      data-playground-message={props.message.type}
      data-message-id={props.message.id}
      data-streaming={props.message.type === "assistant" && props.message.time.completed === undefined ? "" : undefined}
    >
      <Show when={!props.app.virtualized()} fallback={<div data-playground-offscreen />}>
        <Switch>
          <Match when={props.message.type === "user"}>
            <div data-playground-user-text>{(props.message as Extract<Message, { type: "user" }>).text}</div>
          </Match>
          <Match when={props.message.type === "assistant"}>
            <Assistant app={props.app} message={props.message as AssistantMessage} />
          </Match>
        </Switch>
      </Show>
    </div>
  )
}

function Assistant(props: { readonly app: App; readonly message: AssistantMessage }) {
  return (
    <>
      <For each={props.message.content}>{(part) => <Part app={props.app} part={part} />}</For>
      <Show when={props.message.time.completed === undefined}>
        <div data-playground-working>
          <Loader size="small" /> Working…
        </div>
      </Show>
    </>
  )
}

function Part(props: { readonly app: App; readonly part: AssistantPart }) {
  return (
    <Switch>
      <Match when={props.part.type === "text"}>
        <MarkdownView
          text={(props.part as Extract<AssistantPart, { type: "text" }>).text}
          code={(block) => <CodeBlockView app={props.app} block={block} />}
        />
      </Match>
      <Match when={props.part.type === "reasoning"}>
        <details data-playground-reasoning>
          <summary>Thinking</summary>
          {(props.part as Extract<AssistantPart, { type: "reasoning" }>).text}
        </details>
      </Match>
      <Match when={props.part.type === "tool"}>
        <div data-playground-tool>
          <Icon name="terminal" size="small" /> {(props.part as Extract<AssistantPart, { type: "tool" }>).name}
        </div>
        {/* Tool output is Markdown on the session screen too, so its fenced blocks reach CodeBlock contributions. */}
        <Show when={(props.part as Extract<AssistantPart, { type: "tool" }>).state.output}>
          {(output) => (
            <div data-playground-tool-output>
              <MarkdownView text={output()} code={(block) => <CodeBlockView app={props.app} block={block} />} />
            </div>
          )}
        </Show>
      </Match>
    </Switch>
  )
}

interface Mount {
  readonly item: Item<CodeBlock>
  readonly code: string
  readonly language: string
}

/**
 * One fenced block, as the app's Markdown decorates it (packages/session-ui/src/components/markdown.tsx): the code in a
 * `<pre>`; once the closing fence arrives and a CodeBlock contribution lists the language (the first contributed wins,
 * compared lowercased), the contribution renders into `[data-slot="markdown-code-content"]` in its own Solid root and
 * the wrapper gets `data-code-content`, which hides the code. It renders again only when the block or the renderer
 * changes. A render that throws, or returns undefined or null, shows the code again.
 */
export function CodeBlockView(props: { readonly app: App; readonly block: () => FenceBlock }) {
  const app = props.app
  const renderers = useItems(app.contributions, CodeBlock)
  const actions = useItems(app.contributions, CodeBlockAction)
  const owner = getOwner()
  let wrapper!: HTMLDivElement

  const renderer = createMemo(() => {
    const language = props.block().language
    if (!language) return undefined
    return renderers().find((item) => item.value.languages.some((candidate) => candidate.toLowerCase() === language))
  })

  const mount = createMemo<Mount | undefined>(
    () => {
      const block = props.block()
      const item = renderer()
      return block.closed && item ? { item, code: block.body, language: block.language } : undefined
    },
    undefined,
    { equals: (a, b) => a?.item === b?.item && a?.code === b?.code && a?.language === b?.language },
  )

  const [failed, setFailed] = createSignal<Mount>()
  const content = () => !!mount() && failed() !== mount()

  const input = (current: Mount): CodeBlockProps => ({
    code: current.code,
    language: current.language,
    get session() {
      return app.sessions.current()
    },
  })

  createEffect(
    on(mount, (current) => {
      if (!current) return
      const host = document.createElement("div")
      host.dataset.slot = "markdown-code-content"
      wrapper.appendChild(host)
      let dispose: (() => void) | undefined
      let live = true
      const clear = () => {
        dispose?.()
        dispose = undefined
        host.remove()
      }
      const fallback = () => {
        if (!live) return
        live = false
        clear()
        setFailed(current)
      }
      dispose = runWithOwner(owner, () =>
        render(
          () => (
            <Contribution app={app} plugin={current.item.plugin} where="CodeBlock render" failed={fallback}>
              {() => {
                const view = current.item.value.render(input(current))
                // Declined: the code shows again once this render returns.
                if (view === undefined || view === null) queueMicrotask(fallback)
                return view
              }}
            </Contribution>
          ),
          host,
        ),
      )
      if (!live) clear()
      onCleanup(() => {
        live = false
        clear()
      })
    }),
  )

  const blockActions = createMemo(() => {
    const block = props.block()
    if (!block.closed) return []
    return actions()
      .filter((item) => item.value.languages.some((language) => language.toLowerCase() === block.language))
      .toSorted((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0))
  })

  return (
    <div
      ref={wrapper}
      data-component="markdown-code"
      data-language={props.block().language || undefined}
      data-code-content={content() ? "" : undefined}
      data-playground-code={
        !props.block().closed
          ? "streaming"
          : content()
            ? "content"
            : failed() && failed() === mount()
              ? "failed"
              : "code"
      }
    >
      <pre>
        <code>{props.block().body}</code>
      </pre>
      <div data-slot="markdown-code-toolbar">
        <div data-slot="markdown-code-actions">
          <For each={blockActions()}>
            {(item) => (
              <button
                type="button"
                data-component="icon-button-v2"
                data-size="normal"
                data-variant="ghost-muted"
                aria-label={item.value.title}
                title={item.value.title}
                onClick={() => {
                  const block = untrack(props.block)
                  void Promise.try(() =>
                    item.value.run({
                      code: block.body,
                      language: block.language,
                      get session() {
                        return app.sessions.current()
                      },
                    }),
                  ).catch((error: unknown) => app.fail(item.plugin, `CodeBlockAction ${item.value.id}`, error))
                }}
              >
                <Icon name={item.value.icon} />
              </button>
            )}
          </For>
        </div>
        <CopyButton text={() => props.block().body} />
      </div>
    </div>
  )
}
