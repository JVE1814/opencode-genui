import { urlHost } from "../protocol/url.ts"
import type { Host, SurfaceContext } from "./host.ts"

/** A confirm the spec asked for on an action binding (`confirm`), as src/gui/actions.ts reads it. */
export interface RequestedConfirm {
  readonly title?: string
  readonly message?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly danger?: boolean
}

/** Minimum time between two outward actions of one surface, so a spec cannot flood the session. */
export const OUTWARD_INTERVAL_MS = 1000

const lastAction = new WeakMap<SurfaceContext, number>()

/** Whether the current event is a real user gesture (click, key press), not script or a mount. */
export function hasUserGesture(): boolean {
  const activation = (globalThis.navigator as Navigator & { userActivation?: { isActive: boolean } })?.userActivation
  // Without the API (older engines, tests) fall back to allowing; the rate limit still applies.
  return activation ? activation.isActive : true
}

/**
 * Gate for actions that leave the surface (send a message, fill the composer, open a link, copy). Refuses without a
 * user gesture or within OUTWARD_INTERVAL_MS of the surface's last one, then asks the user to confirm when the
 * settings call for it (always, or only for untrusted surfaces) or when the spec asked for a confirm.
 *
 * @returns Whether to proceed.
 */
export async function allowOutward(
  host: Host,
  surface: SurfaceContext | undefined,
  input: {
    /** The confirm title, e.g. "Send this message to the agent?". */
    readonly title: string
    /** Exactly what will happen, shown to the user (the message text, the URL). */
    readonly detail: string
    /** A confirm the spec itself asked for (a binding's `confirm`). */
    readonly requested?: RequestedConfirm
    readonly confirmLabel?: string
  },
): Promise<boolean> {
  if (!hasUserGesture()) return false

  const key = surface ?? (host as unknown as SurfaceContext)
  const now = Date.now()
  if (now - (lastAction.get(key) ?? 0) < OUTWARD_INTERVAL_MS) return false
  lastAction.set(key, now)

  const policy = host.prefs().confirmActions
  const untrusted = !surface?.trusted
  const ask = !!input.requested || policy === "always" || (policy === "untrusted" && untrusted)
  if (!ask) return true

  const notes = [
    input.requested?.message,
    untrusted ? host.t("confirm.untrusted") : undefined,
    input.detail.length > 600 ? `${input.detail.slice(0, 600)}…` : input.detail,
  ].filter(Boolean)
  return host.confirm({
    title: input.requested?.title || input.title,
    description: notes.join("\n\n"),
    confirm: input.requested?.confirmLabel || input.confirmLabel,
    ...(input.requested?.cancelLabel ? { cancel: input.requested.cancelLabel } : {}),
    danger: input.requested?.danger,
  })
}

/**
 * Opens a link from a surface, after the outward gate. The URL must already have passed `safeUrl`.
 *
 * @returns Whether the link was opened.
 */
export async function openLink(
  host: Host,
  surface: SurfaceContext | undefined,
  url: string,
  requested?: RequestedConfirm,
): Promise<boolean> {
  const ok = await allowOutward(host, surface, {
    title: host.t("confirm.openLink", { host: urlHost(url) }),
    detail: url,
    confirmLabel: host.t("confirm.open"),
    ...(requested ? { requested } : {}),
  })
  if (ok) host.openExternal(url)
  return ok
}
