import { For, Index, Match, Show, Switch, type JSX } from "solid-js"
import { scanFences, type FenceBlock } from "../../src/protocol/fence.ts"

/**
 * A small, safe Markdown renderer for the playground: everything becomes Solid elements and text nodes, never HTML, so
 * model-written text cannot inject markup. It covers what transcripts use (paragraphs, headings, lists, quotes, rules,
 * pipe tables, inline code, emphasis, http/https/mailto links) and splits fenced code blocks out with the plugin's own
 * fence scanner (src/protocol/fence.ts), so the timeline treats blocks exactly as the plugin does.
 */

export type Segment =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "fence"; readonly block: FenceBlock }

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const CLOSE = /^( {0,3})(`{3,}|~{3,})$/

/** Splits Markdown into prose and fenced blocks, in order. Fence contents come from `scanFences`. */
export function segment(text: string): Segment[] {
  const blocks = scanFences(text)
  const segments: Segment[] = []
  let prose: string[] = []
  let open: { char: string; length: number } | undefined
  let ordinal = 0

  const flush = () => {
    if (prose.length > 0) segments.push({ kind: "prose", text: prose.join("\n") })
    prose = []
  }

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!open) {
      const match = OPEN.exec(line)
      if (match && !(match[2]!.startsWith("`") && match[3]!.includes("`"))) {
        flush()
        open = { char: match[2]![0]!, length: match[2]!.length }
        continue
      }
      prose.push(line)
      continue
    }
    const close = CLOSE.exec(line.trimEnd())
    if (close && close[2]![0] === open.char && close[2]!.length >= open.length) {
      const block = blocks[ordinal]
      if (block) segments.push({ kind: "fence", block })
      ordinal++
      open = undefined
    }
  }
  if (open) {
    const block = blocks[ordinal]
    if (block) segments.push({ kind: "fence", block })
  }
  flush()
  return segments
}

/** Markdown with fenced blocks rendered by `code` (the timeline passes its CodeBlock-aware renderer). */
export function MarkdownView(props: {
  readonly text: string
  readonly class?: string
  readonly code?: (block: () => FenceBlock) => JSX.Element
}) {
  const segments = () => segment(props.text)
  return (
    <div data-component="markdown" class={props.class}>
      <Index each={segments()}>
        {(item) => (
          <Switch>
            <Match when={item().kind === "prose"}>
              <Prose text={(item() as Extract<Segment, { kind: "prose" }>).text} />
            </Match>
            <Match when={item().kind === "fence"}>
              {(() => {
                const block = () => (item() as Extract<Segment, { kind: "fence" }>).block
                return props.code ? props.code(block) : <PlainCode block={block()} />
              })()}
            </Match>
          </Switch>
        )}
      </Index>
    </div>
  )
}

/** A fenced block shown as code, as the app shows a block no plugin claims. */
export function PlainCode(props: { readonly block: FenceBlock; readonly toolbar?: JSX.Element }) {
  return (
    <div data-component="markdown-code" data-language={props.block.language || undefined}>
      <pre data-closed={props.block.closed ? "" : undefined}>
        <code>{props.block.body}</code>
      </pre>
      <Show when={props.toolbar}>
        <div data-slot="markdown-code-toolbar">{props.toolbar}</div>
      </Show>
    </div>
  )
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "rule" }
  | { type: "table"; head: string[]; rows: string[][] }

function blocks(text: string): Block[] {
  const lines = text.split("\n")
  const out: Block[] = []
  let index = 0
  const isTableRow = (line: string | undefined) => !!line && /^\s*\|.*\|\s*$/.test(line)
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim())

  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === "") {
      index++
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push({ type: "heading", level: heading[1]!.length, text: heading[2]! })
      index++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ type: "rule" })
      index++
      continue
    }
    if (isTableRow(line) && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1] ?? "")) {
      const head = cells(line)
      index += 2
      const rows: string[][] = []
      while (isTableRow(lines[index])) rows.push(cells(lines[index++]!))
      out.push({ type: "table", head, rows })
      continue
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/
    const first = bullet.exec(line)
    if (first) {
      const ordered = /\d/.test(first[1]!)
      const items: string[] = []
      while (index < lines.length) {
        const match = bullet.exec(lines[index]!)
        if (match) items.push(match[2]!)
        else if (/^\s{2,}\S/.test(lines[index]!) && items.length > 0)
          items[items.length - 1] += ` ${lines[index]!.trim()}`
        else break
        index++
      }
      out.push({ type: "list", ordered, items })
      continue
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/, ""))
      out.push({ type: "quote", text: quoted.join(" ") })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && lines[index]!.trim() !== "" && !/^(#{1,6})\s/.test(lines[index]!)) {
      paragraph.push(lines[index++]!)
    }
    out.push({ type: "paragraph", text: paragraph.join(" ") })
  }
  return out
}

function Prose(props: { readonly text: string }) {
  return (
    <For each={blocks(props.text)}>
      {(block) => {
        switch (block.type) {
          case "heading": {
            const level = Math.min(block.level, 4)
            if (level === 1) return <h1>{inline(block.text)}</h1>
            if (level === 2) return <h2>{inline(block.text)}</h2>
            if (level === 3) return <h3>{inline(block.text)}</h3>
            return <h4>{inline(block.text)}</h4>
          }
          case "paragraph":
            return <p>{inline(block.text)}</p>
          case "list":
            return block.ordered ? (
              <ol>
                <For each={block.items}>{(item) => <li>{inline(item)}</li>}</For>
              </ol>
            ) : (
              <ul>
                <For each={block.items}>{(item) => <li>{inline(item)}</li>}</For>
              </ul>
            )
          case "quote":
            return <blockquote>{inline(block.text)}</blockquote>
          case "rule":
            return <hr />
          case "table":
            return (
              <div data-component="markdown-table">
                <table>
                  <thead>
                    <tr>
                      <For each={block.head}>{(cell) => <th>{inline(cell)}</th>}</For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={block.rows}>
                      {(row) => (
                        <tr>
                          <For each={row}>{(cell) => <td>{inline(cell)}</td>}</For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            )
        }
      }}
    </For>
  )
}

const SAFE_LINK = /^(https?:|mailto:)/i

/** Inline Markdown: `code`, **strong**, *em* / _em_, [links](https://...). Anything else stays text. */
export function inline(text: string): JSX.Element[] {
  const out: JSX.Element[] = []
  const pattern =
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    if (match[2] !== undefined) out.push(<code>{match[2]}</code>)
    else if (match[3] !== undefined) out.push(<strong>{inline(match[3])}</strong>)
    else if (match[4] !== undefined) out.push(<em>{inline(match[4])}</em>)
    else if (match[5] !== undefined) out.push(<em>{inline(match[5])}</em>)
    else if (match[6] !== undefined) {
      const href = match[7]!
      out.push(
        SAFE_LINK.test(href) ? (
          <a href={href} target="_blank" rel="noopener noreferrer" class="external-link">
            {inline(match[6])}
          </a>
        ) : (
          <span>{match[0]}</span>
        ),
      )
    }
    last = start + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
