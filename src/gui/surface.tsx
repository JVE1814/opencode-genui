import {
  createComputed,
  createSignal,
  ErrorBoundary,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { JSONUIProvider, Renderer } from "@json-render/solid"
import type { CompiledSurface } from "../protocol/compile.ts"
import { secretPaths } from "../protocol/normalize.ts"
import type { LineError } from "../protocol/surface.ts"
import { formatIssuesForAgent, type SurfaceIssue } from "../protocol/validate.ts"
import type { SurfaceRuntime } from "../runtime/surfaces.ts"
import { VALIDATION_FUNCTIONS } from "../protocol/pattern.ts"
import { createHandlers, type ChainLink } from "./actions.ts"
import { ChainBridge } from "./chain.ts"
import { reserveToolbar } from "./components/shared.tsx"
import { ErrorCard, IssuesFooter } from "./fallback.tsx"
import { HostContext, SurfaceInfoContext, type Host, type SurfaceContext } from "./host.ts"
import { allowOutward } from "./outward.ts"
import { getRendering } from "./registry.tsx"

export interface SurfaceViewProps {
  readonly host: Host
  /** The compiled spec; a new object whenever the spec changes (compileSpec/compileBlock memoize by input). */
  readonly compiled: Accessor<CompiledSurface>
  /** Where the surface's UI state lives; a new runtime remounts the renderer. */
  readonly runtime: Accessor<SurfaceRuntime>
  readonly info: SurfaceContext
  /** The spec is still being written (a canvas while the agent streams). */
  readonly streaming?: Accessor<boolean>
  /** Lines of the block that are not patches; shown only once the block is complete. */
  readonly lineErrors?: Accessor<readonly LineError[]>
  /** Whether the surface may ask the agent to fix its problems. Defaults to whenever it can send a prompt. */
  readonly canFix?: Accessor<boolean>
}

const NO_LINES: readonly LineError[] = Object.freeze([])

/**
 * Sends a surface's problems to the agent as the user (the "Ask agent to fix" button), through the outward gate.
 */
export async function askToFix(
  host: Host,
  info: SurfaceContext,
  problems: { readonly issues: readonly SurfaceIssue[]; readonly lineErrors?: readonly LineError[] },
): Promise<void> {
  const send = info.sendPrompt
  if (!send) return
  const message = formatIssuesForAgent({
    issues: problems.issues,
    lineErrors: problems.lineErrors ?? [],
    kind: info.kind,
    id: info.id,
    ...(info.title ? { title: info.title } : {}),
  })
  const ok = await allowOutward(host, info, {
    title: host.t("confirm.fix"),
    detail: message,
    confirmLabel: host.t("confirm.sendLabel"),
  })
  if (!ok) return
  try {
    await send(message)
  } catch {
    host.toast({ title: host.t("action.sendFailed"), variant: "error" })
  }
}

/**
 * One rendered surface (an inline block or a canvas): json-render's provider and renderer over the surface's own state
 * store, with genui's action handlers, inside genui's chrome. A fatal spec shows the error card instead; a spec that
 * renders with problems gets a quiet "N issues" footer once it is complete. Blocks that are not from the agent's reply
 * carry a note that their actions ask first.
 */
export function SurfaceView(props: SurfaceViewProps): JSX.Element {
  return (
    <HostContext.Provider value={props.host}>
      <SurfaceInfoContext.Provider value={props.info}>
        <Frame {...props} />
      </SurfaceInfoContext.Provider>
    </HostContext.Provider>
  )
}

function Frame(props: SurfaceViewProps) {
  const host = props.host
  const streaming = () => props.streaming?.() ?? false
  const issues = () => props.compiled().issues
  const lineErrors = () => (streaming() ? NO_LINES : (props.lineErrors?.() ?? NO_LINES))
  const canFix = () => (props.canFix ? props.canFix() : !!props.info.sendPrompt)
  const fix = () => void askToFix(host, props.info, { issues: issues(), lineErrors: lineErrors() })
  const hasProblems = () => issues().length > 0 || lineErrors().length > 0

  // Inline surfaces keep their last height while they remount (timeline rows unmount off screen), so the transcript
  // does not jump; the reservation ends with the first measurement.
  let root: HTMLDivElement | undefined
  const [reserved, setReserved] = createSignal(
    props.info.kind === "inline" ? untrack(() => props.runtime().height) : undefined,
  )
  onMount(() => {
    // In place of a code block: keep clear of its toolbar.
    if (root && props.info.kind === "inline") reserveToolbar(root)
    if (!root || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? entry?.contentRect.height ?? 0
      if (height <= 0) return
      const runtime = untrack(props.runtime)
      if (untrack(reserved) !== undefined) setReserved(undefined)
      else runtime.height = height
    })
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })

  const untrustedNote = () =>
    host.t(host.prefs().confirmActions === "never" ? "surface.untrustedQuiet" : "surface.untrusted")

  return (
    <div
      ref={root}
      data-genui=""
      data-surface={props.info.kind}
      data-trusted={props.info.trusted ? "" : undefined}
      data-streaming={streaming() ? "" : undefined}
      role={props.info.title ? "group" : undefined}
      aria-label={props.info.title}
      aria-busy={streaming() || undefined}
      style={{ "min-height": reserved() ? `${reserved()}px` : undefined }}
    >
      <Show when={!props.info.trusted}>
        <div data-gu-chrome="untrusted">
          <span data-slot="icon">
            <host.ui.Icon name="shield" size="small" />
          </span>
          <span>{untrustedNote()}</span>
        </div>
      </Show>
      <Show
        when={!props.compiled().fatal}
        fallback={<ErrorCard issues={issues()} lineErrors={lineErrors()} {...(canFix() ? { onFix: fix } : {})} />}
      >
        <Show when={props.runtime()} keyed>
          {(runtime) => (
            <Render
              host={host}
              info={props.info}
              runtime={runtime}
              compiled={props.compiled}
              streaming={streaming}
              canFix={canFix}
            />
          )}
        </Show>
        <Show when={!streaming() && hasProblems()}>
          <IssuesFooter issues={issues()} lineErrors={lineErrors()} {...(canFix() ? { onFix: fix } : {})} />
        </Show>
      </Show>
    </div>
  )
}

function Render(props: {
  readonly host: Host
  readonly info: SurfaceContext
  readonly runtime: SurfaceRuntime
  readonly compiled: Accessor<CompiledSurface>
  readonly streaming: Accessor<boolean>
  readonly canFix: Accessor<boolean>
}) {
  const store = props.runtime.store
  // What password Inputs are bound to is never persisted (the secret root never is either).
  createComputed(() => store.setSecrets(secretPaths(props.compiled().spec)))
  // The agent's state is the store's base; the user's edits stay on top of it as the spec streams and changes.
  createComputed(() => store.setBase(props.compiled().spec?.state))
  // json-render reads its handlers once, so they are bound to this surface for the provider's lifetime.
  // onSuccess/onError handlers run through json-render's own execute, connected by ChainBridge inside the provider.
  const link: ChainLink = {}
  const handlers = createHandlers(props.host, props.info, { read: (path) => store.get(path), link })
  const { registry, fallback, directives } = getRendering()

  return (
    <ErrorBoundary
      fallback={(error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const crash: SurfaceIssue[] = [{ severity: "error", code: "render_error", message: message.slice(0, 300) }]
        return (
          <ErrorCard
            detail={props.host.t("surface.error.crashed")}
            issues={crash}
            {...(props.canFix() ? { onFix: () => void askToFix(props.host, props.info, { issues: crash }) } : {})}
          />
        )
      }}
    >
      <JSONUIProvider
        registry={registry}
        store={store}
        handlers={handlers}
        directives={directives}
        validationFunctions={VALIDATION_FUNCTIONS}
      >
        <ChainBridge link={link} />
        <Renderer spec={props.compiled().spec} registry={registry} loading={props.streaming()} fallback={fallback} />
      </JSONUIProvider>
    </ErrorBoundary>
  )
}
