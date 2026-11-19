import { createMemo, Show, type JSX } from "solid-js"
import type { CodeBlockProps } from "@opencode/plugin/gui"
import { compileBlock } from "../protocol/compile.ts"
import { blockKind, canvasIdOf, isMeaningful, parseBlock, type ParsedBlock } from "../protocol/surface.ts"
import { getSurface, surfaceKey } from "../runtime/surfaces.ts"
import { HostContext } from "./host.ts"
import { persistSurface, surfaceEntry } from "./persist.ts"
import type { GuiEnv } from "./setup.tsx"
import { SurfaceView } from "./surface.tsx"

/**
 * The CodeBlock render for ```spec and ```canvas blocks (once their fence has closed):
 * - an inline block renders as UI in place, its state kept per session and block id;
 * - a canvas block the session's index knows (it is in the agent's reply) renders as a chip that opens the canvas;
 * - a canvas block the index does not know (tool output, a file preview) renders as an untrusted preview when it is
 *   a whole canvas, and keeps its code when it only patches one.
 *
 * Returns undefined, so the app keeps showing the code, for a block with nothing to render.
 */
export function renderBlock(env: GuiEnv, props: CodeBlockProps): JSX.Element | undefined {
  const block = parseBlock(props.code)
  if (!isMeaningful(block) && Object.keys(block.header).length === 0) return undefined
  if (blockKind(props.language, block.header) === "canvas") return <CanvasBlock env={env} props={props} block={block} />
  return <InlineSurface env={env} props={props} block={block} />
}

function InlineSurface(input: {
  readonly env: GuiEnv
  readonly props: CodeBlockProps
  readonly block: ParsedBlock
  /** A canvas block shown in place because it is not from the agent's reply. */
  readonly preview?: boolean
}): JSX.Element {
  const { env, props, block } = input
  // Read `props.session` where it is used: it is a getter that changes when another session is routed.
  const session = () => props.session
  const id = input.preview ? `preview-${block.hash}` : (block.header.id ?? block.hash)
  const entry = createMemo(() => {
    const current = session()
    return current ? env.sessions.get(current) : undefined
  })
  const runtime = createMemo(() => getSurface(surfaceKey(session()?.key, "inline", id)))
  const compiled = () => compileBlock(block)
  const trusted = () => !input.preview && !!entry()?.index.knows(block.hash)

  persistSurface({
    runtime,
    store: () => {
      const current = session()
      return current ? env.store(current) : undefined
    },
    entry: () => surfaceEntry("inline", id),
  })

  const info = env.surfaceInfo({
    kind: "inline",
    id: () => id,
    title: () => block.header.title,
    trusted,
    session,
  })

  return (
    <SurfaceView
      host={env.host}
      compiled={compiled}
      runtime={runtime}
      info={info}
      lineErrors={() => block.errors}
      // Problems of a block that is not the agent's own are not the agent's to fix.
      canFix={() => trusted() && !!session()}
    />
  )
}

function CanvasBlock(input: { readonly env: GuiEnv; readonly props: CodeBlockProps; readonly block: ParsedBlock }) {
  const { env, props, block } = input
  const entry = createMemo(() => {
    const current = props.session
    return current ? env.sessions.get(current) : undefined
  })
  // While the index loads, assume the block is the agent's (the timeline shows assistant text far more often).
  const chip = () => {
    const index = entry()?.index
    return !!index && (!index.ready() || index.knows(block.hash))
  }
  return (
    <Show
      when={chip()}
      fallback={
        <Show
          when={block.hasRoot && !block.header.close}
          fallback={
            <HostContext.Provider value={env.host}>
              <env.host.ui.Code content={props.code} language={props.language} />
            </HostContext.Provider>
          }
        >
          <InlineSurface env={env} props={props} block={block} preview />
        </Show>
      }
    >
      <Chip env={env} props={props} block={block} />
    </Show>
  )
}

function Chip(input: { readonly env: GuiEnv; readonly props: CodeBlockProps; readonly block: ParsedBlock }) {
  const { env, props, block } = input
  const { host } = env
  const canvas = canvasIdOf(block.header)
  const entry = () => {
    const current = props.session
    return current ? env.sessions.get(current) : undefined
  }
  const index = () => entry()?.index
  const state = () => index()?.canvas(canvas)
  const closed = () => block.header.close === true || (!state() && !!index()?.removed().has(canvas))
  const title = () => block.header.title ?? entry()?.title(canvas) ?? canvas
  const open = () => {
    const current = props.session
    if (current) env.openCanvas(current, canvas, "select")
  }

  return (
    <div data-genui="" data-surface="chip">
      <div data-gu-chrome="chip" data-state={closed() ? "closed" : state()?.streaming ? "live" : "idle"}>
        <span data-slot="icon">
          <host.ui.Icon name="layout-right" />
        </span>
        <span data-slot="text">
          <span data-slot="title">{title()}</span>
          <span data-slot="meta">
            <span>{host.t(block.hasRoot || block.header.mode === "replace" ? "chip.canvas" : "chip.update")}</span>
            <Show when={closed()}>
              <span aria-hidden="true">·</span>
              <span>{host.t("chip.closed")}</span>
            </Show>
            <Show when={!closed() && state()?.streaming}>
              <span aria-hidden="true">·</span>
              <span data-gu-live="" />
              <span>{host.t("chip.updating")}</span>
            </Show>
          </span>
        </span>
        <Show when={!closed()}>
          <host.ui.Button size="small" variant="neutral" onClick={open}>
            {host.t("chip.open")}
          </host.ui.Button>
        </Show>
      </div>
    </div>
  )
}
