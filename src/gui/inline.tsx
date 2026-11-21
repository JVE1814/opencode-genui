import { createComputed, createMemo, Show, untrack, type JSX } from "solid-js"
import type { CodeBlockProps } from "@opencode/plugin/gui"
import { compileBlock } from "../protocol/compile.ts"
import { MAX_CANVASES } from "../protocol/fold.ts"
import { blockKind, canvasIdOf, isMeaningful, parseBlock, type ParsedBlock } from "../protocol/surface.ts"
import { MOUNT_UNITS, mountUnits, sliceMount } from "../runtime/budget.ts"
import { getSurface, peekSurface, surfaceKey } from "../runtime/surfaces.ts"
import { reserveToolbar } from "./components/shared.tsx"
import { handOverInline, inlineSurfaceId, persistSurface, surfaceEntry } from "./persist.ts"
import type { GuiEnv } from "./setup.tsx"
import { SurfaceView } from "./surface.tsx"

/**
 * The CodeBlock render for ```spec and ```canvas blocks (once their fence has closed):
 * - an inline block renders as UI in place, its state kept per session and block id;
 * - a canvas block the session's index knows (it is in the agent's reply) renders as a chip that opens the canvas;
 * - a canvas block the index does not know (tool output, a file preview) renders as an untrusted preview when it is
 *   a whole canvas, and keeps its source when it only patches one.
 *
 * Returns undefined, so the app keeps showing the code, for a block with nothing to render.
 */
export function renderBlock(env: GuiEnv, props: CodeBlockProps): JSX.Element | undefined {
  const block = parseBlock(props.code)
  if (!isMeaningful(block) && Object.keys(block.header).length === 0) return undefined
  if (blockKind(props.language, block.header) === "canvas") {
    // A patch for a canvas that is not the agent's has nothing to show but its code: when that is already known, the
    // app keeps its own highlighted code (and its one Copy button).
    const foreignPatch = untrack(() => {
      const session = props.session
      const index = session ? env.sessions.get(session).index : undefined
      return !!index && index.ready() && !index.knows(block.text) && !(block.hasRoot && !block.header.close)
    })
    if (foreignPatch) return undefined
    return <CanvasBlock env={env} props={props} block={block} />
  }
  return (
    <Sliced cost={mountUnits(block.text.length)} pending={() => arrived(env, props, block)}>
      <InlineSurface env={env} props={props} block={block} />
    </Sliced>
  )
}

/** What mounting a canvas chip or a source view costs a task's slice: half a surface (see MOUNT_UNITS). */
const CHIP_UNITS = MOUNT_UNITS / 2

/**
 * Mounts a block's surface, chip or source view once the task's slice has room for `cost` (see `sliceMount`), also
 * when a canvas block switches between them (all of a reopened session's canvas blocks do once its index has loaded).
 * Mounting one counts in the slice like the elements it renders: a message of 1,700 small blocks mounted all of them
 * in one task (2 s). Past the slice, a placeholder of the height it is expected to take shows instead, and a later task
 * mounts it, in order with everything else waiting.
 */
function Sliced(props: {
  readonly cost: number
  readonly chip?: boolean
  /** For a surface that waits: what it does on arrival, and the height it reserves. */
  readonly pending?: () => number
  readonly children: JSX.Element
}) {
  const mounted = sliceMount(props.cost)
  return (
    <Show when={mounted()} fallback={<Pending chip={props.chip} pending={props.pending} />}>
      {props.children}
    </Show>
  )
}

/**
 * An inline block whose surface mounts in a later task: when the agent re-sent the UI of an id, hands its shared state
 * over now (the copy it replaces stops being the newest now; see InlineSurface), and returns the height to reserve.
 * Untracked, once: the surface follows changes when it mounts.
 */
function arrived(env: GuiEnv, props: CodeBlockProps, block: ParsedBlock): number {
  return untrack(() => {
    const session = props.session
    const index = session ? env.sessions.get(session).index : undefined
    const trusted = !!index?.knows(block.text)
    const id = block.header.id
    const latest = id === undefined || !trusted ? undefined : index?.latestInline(id)
    const newest = latest === undefined || latest === block.text
    const runtime = peekSurface(surfaceKey(session?.key, "inline", inlineSurfaceId(block, trusted, newest)))
    if (runtime && id !== undefined && trusted && newest)
      handOverInline({
        shared: runtime,
        keyOf: (surface) => surfaceKey(session?.key, "inline", surface),
        block,
        store: session ? env.store(session) : undefined,
      })
    return runtime?.height ?? estimatedHeight(block)
  })
}

/** The height a surface not laid out yet in this window probably takes: a line per patch, within bounds. */
const estimatedHeight = (block: ParsedBlock) =>
  Math.min(PENDING_MAX, Math.max(PENDING_MIN, block.patches.length * PENDING_LINE))
const PENDING_MIN = 36
const PENDING_LINE = 28
const PENDING_MAX = 360

/**
 * In place of a surface (or a chip) that a later task mounts: an empty box of the height it is expected to take, so
 * the transcript does not jump when it mounts. A surface laid out before in this window (a row that scrolled back
 * into view) keeps its last height. Not a [data-genui] root: the theme's many custom properties there would be
 * computed for each box.
 */
function Pending(props: { readonly chip?: boolean | undefined; readonly pending?: (() => number) | undefined }) {
  // Read once, as the box mounts.
  const height = props.chip ? "calc(var(--gu-control, 28px) + 12px)" : `${props.pending?.() ?? PENDING_MIN}px`
  const style = `min-height: ${height}; margin-block: 4px`
  return <div data-genui-pending={props.chip ? "chip" : "surface"} aria-busy="true" style={style} />
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
  const entry = createMemo(() => {
    const current = session()
    return current ? env.sessions.get(current) : undefined
  })
  // Trust is the exact text of the block among the agent's text parts (see SessionIndex.knows).
  const trusted = createMemo(() => !input.preview && !!entry()?.index.knows(block.text))
  const newest = createMemo(() => {
    const id = block.header.id
    if (id === undefined || !trusted()) return true
    const latest = entry()?.index.latestInline(id)
    return latest === undefined || latest === block.text
  })
  const surfaceId = createMemo(() => inlineSurfaceId(block, trusted(), newest()))
  const runtime = createMemo(() => getSurface(surfaceKey(session()?.key, "inline", surfaceId())))
  const compiled = () => compileBlock(block)

  // The newest block of an id drives its shared state; the copy it replaces keeps what the user entered in it.
  // (A computed of this component runs before the surface below sets the new block's state.)
  createComputed(() => {
    if (block.header.id === undefined || !trusted() || !newest()) return
    const shared = runtime()
    const current = session()
    untrack(() =>
      handOverInline({
        shared,
        keyOf: (id) => surfaceKey(current?.key, "inline", id),
        block,
        store: current ? env.store(current) : undefined,
      }),
    )
  })

  persistSurface({
    runtime,
    store: () => {
      const current = session()
      return current ? env.store(current) : undefined
    },
    entry: () => surfaceEntry("inline", surfaceId()),
  })

  const info = env.surfaceInfo({
    kind: "inline",
    id: () => block.header.id ?? block.hash,
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
      superseded={() => !newest()}
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
    return !!index && (!index.ready() || index.knows(block.text))
  }
  return (
    <Show
      when={chip()}
      fallback={
        <Show
          when={block.hasRoot && !block.header.close}
          // A patch for a canvas that turned out not to be the agent's after this rendered: its source as plain text.
          // The app's own Copy button stays over the block's corner, so this draws no copy control of its own.
          fallback={
            <Sliced cost={CHIP_UNITS} pending={() => estimatedHeight(block)}>
              <div data-genui="" data-surface="source" ref={reserveToolbar}>
                <pre data-gu-chrome="source">
                  <code>{props.code}</code>
                </pre>
              </div>
            </Sliced>
          }
        >
          <Sliced cost={mountUnits(block.text.length)} pending={() => arrived(env, props, block)}>
            <InlineSurface env={env} props={props} block={block} preview />
          </Sliced>
        </Show>
      }
    >
      <Sliced cost={CHIP_UNITS} chip>
        <Chip env={env} props={props} block={block} />
      </Sliced>
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
  // Not opened: MAX_CANVASES were open (the canvas issue says so to the agent, see CanvasView).
  const refused = () => !state() && !closed() && !!index()?.refused().has(canvas)
  const title = () => block.header.title ?? entry()?.title(canvas) ?? canvas
  const open = () => {
    const current = props.session
    if (current) env.openCanvas(current, canvas, "select")
  }

  return (
    <div data-genui="" data-surface="chip" ref={reserveToolbar}>
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
            <Show when={refused()}>
              <span aria-hidden="true">·</span>
              <span>{host.t("chip.refused", { max: MAX_CANVASES })}</span>
            </Show>
            <Show when={!closed() && state()?.streaming}>
              <span aria-hidden="true">·</span>
              <span data-gu-live="" />
              <span>{host.t("chip.updating")}</span>
            </Show>
          </span>
        </span>
        <Show when={!closed() && !refused()}>
          <host.ui.Button size="small" variant="neutral" onClick={open}>
            {host.t("chip.open")}
          </host.ui.Button>
        </Show>
      </div>
    </div>
  )
}
