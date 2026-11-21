import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Accessor,
  type JSX,
  useContext,
} from "solid-js"
import { JSONUIProvider, Renderer } from "@json-render/solid"
import type { CompiledSurface } from "../protocol/compile.ts"
import { secretPaths } from "../protocol/normalize.ts"
import type { LineError } from "../protocol/surface.ts"
import { formatIssuesForAgent, type SurfaceIssue } from "../protocol/validate.ts"
import { itemKeys } from "../runtime/item-keys.ts"
import type { SurfaceRuntime } from "../runtime/surfaces.ts"
import { VALIDATION_FUNCTIONS } from "../protocol/pattern.ts"
import { createHandlers, type ChainLink } from "./actions.ts"
import { ChainBridge } from "./chain.ts"
import { CutsContext, reserveToolbar, SurfaceMemoryContext } from "./components/shared.tsx"
import { joinInlinePool, windowPool } from "../runtime/budget.ts"
import {
  EDITS_UNMATCHED,
  MAX_CUT_ISSUES,
  moreCuts,
  poolKind,
  renderFailed,
  SKIPPED_WORK,
  tooDeep,
  tooLarge,
} from "./issues.ts"
import { createRenderBudget, RenderBudgetContext, SpecElementsContext } from "./element.ts"
import { ErrorCard, IssuesFooter } from "./fallback.tsx"
import { HostContext, QuietWriteContext, SurfaceInfoContext, type Host, type SurfaceContext } from "./host.ts"
import { allowOutward, lendActivation, noteAgentState } from "./outward.ts"
import { EvaluationLend, getRendering, RenderErrors } from "./registry.tsx"

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
  /** An older copy of an inline UI the agent sent again with the same id (see POOL_SURFACES). */
  readonly superseded?: Accessor<boolean>
}

const NO_LINES: readonly LineError[] = Object.freeze([])

/** How long a remounted inline surface keeps its last height at most while its content settles. */
export const HEIGHT_RESERVE_MS = 1000

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

const heightListeners = new WeakMap<Element, (height: number) => void>()
let heightObserver: ResizeObserver | undefined

/**
 * Tells `listener` the content height of a surface's box whenever it changes: its observed size, or, while it holds a
 * reserved `min-height`, its height without it. One observer serves every surface, so the boxes are read together:
 * an observer per surface measured right after the previous surface's writes, a layout per surface, and 900 small
 * blocks in one tool output froze the window for a second. Returns the function that stops it.
 */
function observeHeight(element: HTMLElement, listener: (height: number) => void): () => void {
  heightObserver ??= new ResizeObserver((entries) => {
    const sizes = entries.map((entry) => entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height)
    // Boxes that hold a reserved height: all of them without it at once, then read (one layout), then back.
    const held = entries.map((entry) => (entry.target as HTMLElement).style.minHeight)
    if (held.some(Boolean)) {
      entries.forEach((entry, index) => {
        if (held[index]) (entry.target as HTMLElement).style.minHeight = ""
      })
      entries.forEach((entry, index) => {
        if (held[index]) sizes[index] = entry.target.getBoundingClientRect().height
      })
      entries.forEach((entry, index) => {
        if (held[index]) (entry.target as HTMLElement).style.minHeight = held[index]!
      })
    }
    entries.forEach((entry, index) => heightListeners.get(entry.target)?.(sizes[index]!))
  })
  heightListeners.set(element, listener)
  heightObserver.observe(element)
  return () => {
    heightListeners.delete(element)
    heightObserver?.unobserve(element)
  }
}

/**
 * What a surface's components leave out (see CutsContext in src/gui/components/shared.tsx): each distinct issue once,
 * however many rows of a repeat report it, and at most MAX_CUT_ISSUES of them, the rest counted in one. Reports
 * change the issues at most once per microtask, so a thousand cut lists mounting in one task rebuild them once.
 */
function createCuts() {
  const reports = new Map<string, { readonly issue: SurfaceIssue; count: number }>()
  const [version, setVersion] = createSignal(undefined, { equals: false })
  let queued = false
  const changed = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      setVersion(undefined)
    })
  }
  const issues = createMemo((): readonly SurfaceIssue[] => {
    version()
    const out: SurfaceIssue[] = []
    for (const { issue } of reports.values()) {
      if (out.length === MAX_CUT_ISSUES) break
      out.push(issue)
    }
    return reports.size > MAX_CUT_ISSUES ? [...out, moreCuts(reports.size - MAX_CUT_ISSUES)] : out
  })
  const report = (issue: SurfaceIssue) => {
    const key = `${issue.elementKey ?? ""}\u0000${issue.message}`
    let entry = reports.get(key)
    if (!entry) {
      entry = { issue, count: 0 }
      reports.set(key, entry)
      changed()
    }
    entry.count++
    const held = entry
    let withdrawn = false
    return () => {
      if (withdrawn) return
      withdrawn = true
      if (--held.count > 0 || reports.get(key) !== held) return
      reports.delete(key)
      changed()
    }
  }
  return { issues, report }
}

function Frame(props: SurfaceViewProps) {
  const host = props.host
  const streaming = () => props.streaming?.() ?? false
  // Charged by every element: the surface's own budget, its kind's window-wide pool, and the window's task slices. An
  // element a press shows that the slice defers mounts with that press's activation (a Dialog it opened).
  const kind = createMemo(() => poolKind(props.info, props.superseded?.() ?? false))
  // The agent's newest inline UI keeps room of its own in their pool (see joinInlinePool).
  const membership = createMemo(() => {
    if (kind() !== "inline") return undefined
    const member = joinInlinePool()
    onCleanup(member.leave)
    return member
  })
  const budget = createRenderBudget({
    pool: () => membership()?.meters() ?? windowPool(kind()),
    sliced: true,
    lend: () => lendActivation(props.info),
  })
  // Whether json-render skipped part of what a change of the state set off (until the agent's next state), and whether
  // the agent's last state left edits of list items unmatched.
  const [skippedWork, setSkippedWork] = createSignal(false)
  const [unmatched, setUnmatched] = createSignal(false)
  createEffect(() => {
    const store = props.runtime().store
    const update = () => {
      setSkippedWork(store.skippedWork())
      setUnmatched(store.editsUnmatched())
    }
    update()
    onCleanup(store.onSkippedWork(update))
  })
  const cuts = createCuts()
  const issues = () => {
    const compiled = props.compiled().issues
    const skipped = budget.skipped()
    const shown = skipped > 0 ? [...compiled, tooLarge(kind(), budget.pooled() === skipped)] : compiled
    const cut = cuts.issues()
    const deep = budget.tooDeep()
    const failed = budget.failed()
    const all = [
      ...shown,
      ...cut,
      ...(deep > 0 ? [tooDeep(deep)] : []),
      ...(failed.length > 0 ? [renderFailed(failed)] : []),
      ...(unmatched() ? [EDITS_UNMATCHED] : []),
    ]
    return skippedWork() ? [...all, SKIPPED_WORK] : all
  }
  const lineErrors = () => (streaming() ? NO_LINES : (props.lineErrors?.() ?? NO_LINES))
  const canFix = () => (props.canFix ? props.canFix() : !!props.info.sendPrompt)
  const fix = () => void askToFix(host, props.info, { issues: issues(), lineErrors: lineErrors() })
  const hasProblems = () => issues().length > 0 || lineErrors().length > 0

  // Inline surfaces keep their last height while they remount (timeline rows unmount off screen), so the transcript
  // does not jump while content that lays out late (charts, images, Markdown) settles. The reservation ends once the
  // content is as tall again, when the user interacts with the surface, or after HEIGHT_RESERVE_MS.
  let root: HTMLDivElement | undefined
  const [reserved, setReserved] = createSignal(
    props.info.kind === "inline" ? untrack(() => props.runtime().height) : undefined,
  )
  onMount(() => {
    const element = root
    // In place of a code block: keep clear of its toolbar.
    if (element && props.info.kind === "inline") reserveToolbar(element)
    if (!element || typeof ResizeObserver === "undefined") return void setReserved(undefined)
    const release = () => {
      if (untrack(reserved) !== undefined) setReserved(undefined)
    }
    if (untrack(reserved) !== undefined) {
      const timer = setTimeout(release, HEIGHT_RESERVE_MS)
      element.addEventListener("pointerdown", release, { capture: true })
      element.addEventListener("keydown", release, { capture: true })
      onCleanup(() => {
        clearTimeout(timer)
        element.removeEventListener("pointerdown", release, { capture: true })
        element.removeEventListener("keydown", release, { capture: true })
      })
    }
    onCleanup(
      observeHeight(element, (height) => {
        if (height <= 0) return
        const target = untrack(reserved)
        if (target !== undefined) {
          if (height < target - 0.5) return
          setReserved(undefined)
        }
        untrack(props.runtime).height = height
      }),
    )
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
            <SurfaceMemoryContext.Provider value={runtime.memory}>
              <RenderBudgetContext.Provider value={budget}>
                <CutsContext.Provider value={cuts.report}>
                  <Render
                    host={host}
                    info={props.info}
                    runtime={runtime}
                    compiled={props.compiled}
                    streaming={streaming}
                    canFix={canFix}
                  />
                </CutsContext.Provider>
              </RenderBudgetContext.Provider>
            </SurfaceMemoryContext.Provider>
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
  const budget = useContext(RenderBudgetContext)
  // An element that could not render shows nothing; the surface lists its error while it is mounted.
  const failed = (error: unknown) => {
    if (!budget) return
    const message = String((error as Error | undefined)?.message ?? error).slice(0, 200)
    budget.setFailed((errors) => [...errors, message])
    onCleanup(() =>
      budget.setFailed((errors) => {
        const at = errors.indexOf(message)
        return at < 0 ? errors : errors.toSpliced(at, 1)
      }),
    )
  }
  let agentState: unknown
  createComputed(() => {
    const spec = props.compiled().spec
    // What password Inputs are bound to is never persisted (the secret root never is either).
    store.setSecrets(secretPaths(spec))
    // Edits of list items follow their item by its repeat.key.
    store.setItemKeys(itemKeys(spec))
    // The agent's state is the store's base; the user's edits stay on top of it as the spec streams and changes.
    store.setBase(spec?.state)
    // A modal the user dismissed may open again by itself from the agent's next version of its state.
    if (spec?.state !== agentState) {
      agentState = spec?.state
      noteAgentState(props.info)
    }
  })
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
        <QuietWriteContext.Provider value={(path, value) => store.set(path, value)}>
          <EvaluationLend lend={() => lendActivation(props.info)}>
            <RenderErrors report={failed}>
              <SpecElementsContext.Provider value={() => props.compiled().spec?.elements}>
                <Renderer
                  spec={props.compiled().spec}
                  registry={registry}
                  loading={props.streaming()}
                  fallback={fallback}
                />
              </SpecElementsContext.Provider>
            </RenderErrors>
          </EvaluationLend>
        </QuietWriteContext.Provider>
      </JSONUIProvider>
    </ErrorBoundary>
  )
}
