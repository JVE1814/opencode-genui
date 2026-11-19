import { createMemo, For, Show, type JSX } from "solid-js"
import type { ComponentRenderProps } from "@json-render/solid"
import type { LineError } from "../protocol/surface.ts"
import type { SurfaceIssue } from "../protocol/validate.ts"
import { useHost, type Host } from "./host.ts"

/** Issues shown in a card or footer before "and N more". */
const SHOWN_ISSUES = 12

/** Picks `<key>.one` or `<key>.other` (the Host seam has no plural rules; English needs only these two). */
export const plural = (host: Host, key: string, count: number) =>
  host.t(`${key}.${count === 1 ? "one" : "other"}`, { count })

/** What the renderer shows for an element whose type the catalog does not have: a muted note, then its children. */
export function UnknownElement(props: ComponentRenderProps): JSX.Element {
  const host = useHost()
  const type = () => (typeof props.element?.type === "string" ? props.element.type.slice(0, 60) : "?")
  return (
    <div data-gu-chrome="unknown">
      <span data-slot="note">{host.t("surface.unknown", { type: type() })}</span>
      <Show when={props.children}>
        <div data-slot="children">{props.children}</div>
      </Show>
    </div>
  )
}

interface IssueListProps {
  readonly issues: readonly SurfaceIssue[]
  readonly lineErrors?: readonly LineError[]
}

type Row = { readonly key: string; readonly where?: string; readonly message: string; readonly severity: string }

/** The issues as rows, errors first, then lines that are not patches, then warnings. */
function IssueList(props: IssueListProps) {
  const host = useHost()
  const rows = createMemo((): Row[] => {
    const issue = (item: SurfaceIssue, index: number): Row => ({
      key: `i${index}`,
      ...(item.elementKey !== undefined ? { where: item.elementKey } : {}),
      message: item.message,
      severity: item.severity,
    })
    return [
      ...props.issues.filter((item) => item.severity === "error").map(issue),
      ...(props.lineErrors ?? []).map(
        (error, index): Row => ({
          key: `l${index}`,
          where: host.t("surface.line", { line: error.line }),
          message: error.message,
          severity: "error",
        }),
      ),
      ...props.issues.filter((item) => item.severity !== "error").map(issue),
    ]
  })
  const more = () => rows().length - SHOWN_ISSUES
  return (
    <ul data-slot="issues">
      <For each={rows().slice(0, SHOWN_ISSUES)}>
        {(row) => (
          <li data-severity={row.severity}>
            <Show when={row.where}>
              <code data-slot="where">{row.where}</code>
            </Show>
            <span data-slot="message">{row.message}</span>
          </li>
        )}
      </For>
      <Show when={more() > 0}>
        <li data-slot="more">+{more()}</li>
      </Show>
    </ul>
  )
}

export interface ErrorCardProps extends IssueListProps {
  /** The card's headline; defaults to "This UI couldn't be shown". */
  readonly title?: string
  /** A sentence under the headline, e.g. what crashed. */
  readonly detail?: string
  /** Sends the issues to the agent; omit to hide the button (outside a session). */
  readonly onFix?: () => void
}

/** Shown in place of a surface that cannot render: what is wrong, and a button that asks the agent to fix it. */
export function ErrorCard(props: ErrorCardProps): JSX.Element {
  const host = useHost()
  const count = () => props.issues.length + (props.lineErrors?.length ?? 0)
  return (
    <div data-gu-chrome="error" role="group" aria-label={props.title ?? host.t("surface.error.title")}>
      <div data-slot="head">
        <span data-slot="icon">
          <host.ui.Icon name="circle-exclamation" size="small" />
        </span>
        <span data-slot="title">{props.title ?? host.t("surface.error.title")}</span>
      </div>
      <Show when={props.detail}>
        <p data-slot="detail">{props.detail}</p>
      </Show>
      <Show when={count() > 0}>
        <IssueList issues={props.issues} lineErrors={props.lineErrors ?? []} />
      </Show>
      <Show when={props.onFix}>
        {(fix) => (
          <div data-slot="actions">
            <host.ui.Button size="small" variant="neutral" icon="speech-bubble" onClick={() => fix()()}>
              {host.t("surface.fix")}
            </host.ui.Button>
          </div>
        )}
      </Show>
    </div>
  )
}

/** A quiet disclosure under a surface that rendered with problems: "3 issues", the list, and the fix button. */
export function IssuesFooter(props: IssueListProps & { readonly onFix?: () => void }): JSX.Element {
  const host = useHost()
  const count = () => props.issues.length + (props.lineErrors?.length ?? 0)
  const errors = () => (props.lineErrors?.length ?? 0) > 0 || props.issues.some((issue) => issue.severity === "error")
  return (
    <details data-gu-chrome="issues" data-severity={errors() ? "error" : "warning"}>
      <summary>
        <span data-slot="icon">
          <host.ui.Icon name="warning" size="small" />
        </span>
        <span>{plural(host, "surface.issues", count())}</span>
      </summary>
      <div data-slot="body">
        <IssueList issues={props.issues} lineErrors={props.lineErrors ?? []} />
        <Show when={props.onFix}>
          {(fix) => (
            <div data-slot="actions">
              <host.ui.Button size="small" variant="ghost" icon="speech-bubble" onClick={() => fix()()}>
                {host.t("surface.fix")}
              </host.ui.Button>
            </div>
          )}
        </Show>
      </div>
    </details>
  )
}
