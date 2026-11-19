import { afterEach, describe, expect, test } from "bun:test"
import { ACTION_NAMES, CONFIRM_PARAM } from "../../src/catalog/actions.ts"
import {
  ActionRefused,
  createHandlers,
  isRefusal,
  readConfirm,
  takeConfirm,
  TOAST_BURST,
} from "../../src/gui/actions.ts"
import { DEFAULT_PREFS, type Host, type Prefs, type SurfaceContext } from "../../src/gui/host.ts"

type ConfirmCall = Parameters<Host["confirm"]>[0]
type ToastCall = Parameters<Host["toast"]>[0]

function fakeHost(options: { prefs?: Partial<Prefs>; answer?: boolean; copyFails?: boolean } = {}) {
  const calls = {
    confirms: [] as ConfirmCall[],
    toasts: [] as ToastCall[],
    copies: [] as string[],
    opened: [] as string[],
  }
  const host: Host = {
    ui: {} as Host["ui"],
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    mode: () => "light",
    confirm: async (input) => {
      calls.confirms.push(input)
      return options.answer ?? true
    },
    toast: (input) => void calls.toasts.push(input),
    copy: async (text) => {
      if (options.copyFails) throw new Error("denied")
      calls.copies.push(text)
    },
    openExternal: (url) => void calls.opened.push(url),
    prefs: () => ({ ...DEFAULT_PREFS, ...options.prefs }),
  }
  return { host, calls }
}

function fakeSurface(overrides: Partial<SurfaceContext> = {}) {
  const sent: string[] = []
  const inserted: string[] = []
  const canvases: string[] = []
  const surface: SurfaceContext = {
    kind: "inline",
    id: "form",
    trusted: true,
    sendPrompt: async (text) => void sent.push(text),
    insertPrompt: (text) => void inserted.push(text),
    openCanvas: (id) => void canvases.push(id),
    ...overrides,
  }
  return { surface, sent, inserted, canvases }
}

const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    (error: unknown) => isRefusal(error),
  )

// navigator.userActivation stands in for a real user gesture; tests without it count as one (see hasUserGesture).
const setGesture = (active: boolean | undefined) => {
  const nav = globalThis.navigator as unknown as { userActivation?: { isActive: boolean } }
  if (active === undefined) delete nav.userActivation
  else Object.defineProperty(nav, "userActivation", { value: { isActive: active }, configurable: true })
}

afterEach(() => setGesture(undefined))

describe("readConfirm", () => {
  test("reads json-render's ActionConfirm object", () => {
    expect(
      readConfirm({
        title: "Deploy?",
        message: "Goes live",
        confirmLabel: "Ship",
        cancelLabel: "No",
        variant: "danger",
      }),
    ).toEqual({ title: "Deploy?", message: "Goes live", confirmLabel: "Ship", cancelLabel: "No", danger: true })
  })

  test("accepts a string, true, and ignores false and junk", () => {
    expect(readConfirm("Are you sure?")).toEqual({ message: "Are you sure?" })
    expect(readConfirm(true)).toEqual({})
    expect(readConfirm(false)).toBeUndefined()
    expect(readConfirm(null)).toBeUndefined()
    expect(readConfirm(42)).toBeUndefined()
    expect(readConfirm({ title: 3, message: ["x"] })).toEqual({})
  })

  test("fills ${path} placeholders from state, as json-render does", () => {
    const read = (path: string) => ({ "/form/env": "production", "/n": 3 })[path]
    expect(readConfirm({ title: "Deploy to ${/form/env}?", message: "${/n} replicas, ${/missing}." }, read)).toEqual({
      title: "Deploy to production?",
      message: "3 replicas, .",
    })
  })
})

describe("takeConfirm", () => {
  test("strips the reserved param from the action's params", () => {
    const result = takeConfirm({ text: "Go", [CONFIRM_PARAM]: { title: "Sure?" } })
    expect(result.params).toEqual({ text: "Go" })
    expect(CONFIRM_PARAM in result.params).toBe(false)
    expect(result.confirm).toEqual({ title: "Sure?" })
  })

  test("passes params without a confirm through", () => {
    const params = { text: "Go" }
    expect(takeConfirm(params)).toEqual({ params, confirm: undefined })
    expect(takeConfirm(undefined)).toEqual({ params: {}, confirm: undefined })
  })
})

describe("createHandlers", () => {
  test("has a handler for every catalog action", () => {
    const { host } = fakeHost()
    expect(Object.keys(createHandlers(host, fakeSurface().surface)).toSorted()).toEqual([...ACTION_NAMES].toSorted())
  })

  test("sendPrompt sends the formatted message on a trusted surface without asking", async () => {
    const { host, calls } = fakeHost()
    const { surface, sent } = fakeSurface()
    await createHandlers(host, surface).sendPrompt({ text: "Deploy", data: { env: "prod" } })
    expect(sent).toEqual(['Deploy\n\n```json\n{\n  "env": "prod"\n}\n```'])
    expect(calls.confirms).toHaveLength(0)
  })

  test("sendPrompt asks first on an untrusted surface and stops when declined", async () => {
    const { host, calls } = fakeHost({ answer: false })
    const { surface, sent } = fakeSurface({ trusted: false })
    expect(await refused(createHandlers(host, surface).sendPrompt({ text: "Deploy" }))).toBe(true)
    expect(calls.confirms).toHaveLength(1)
    expect(calls.confirms[0]!.title).toBe("confirm.send")
    expect(calls.confirms[0]!.description).toContain("confirm.untrusted")
    expect(calls.confirms[0]!.description).toContain("Deploy")
    expect(sent).toHaveLength(0)
  })

  test("a requested confirm asks even on a trusted surface, with its own wording, and never leaks into the message", async () => {
    const { host, calls } = fakeHost()
    const { surface, sent } = fakeSurface()
    await createHandlers(host, surface, { read: () => "prod" }).sendPrompt({
      text: "Deploy",
      [CONFIRM_PARAM]: { title: "Deploy to ${/env}?", message: "This goes live.", variant: "danger" },
    })
    expect(calls.confirms[0]).toMatchObject({ title: "Deploy to prod?", danger: true })
    expect(calls.confirms[0]!.description).toContain("This goes live.")
    expect(sent).toEqual(["Deploy"])
  })

  test("prefs: always asks everywhere, never asks nowhere (unless requested)", async () => {
    const always = fakeHost({ prefs: { confirmActions: "always" } })
    await createHandlers(always.host, fakeSurface().surface).sendPrompt({ text: "a" })
    expect(always.calls.confirms).toHaveLength(1)

    const never = fakeHost({ prefs: { confirmActions: "never" } })
    await createHandlers(never.host, fakeSurface({ trusted: false }).surface).sendPrompt({ text: "a" })
    expect(never.calls.confirms).toHaveLength(0)
    await createHandlers(never.host, fakeSurface().surface).sendPrompt({ text: "a", [CONFIRM_PARAM]: "Sure?" })
    expect(never.calls.confirms).toHaveLength(1)
  })

  test("outward actions are limited to one per second per surface", async () => {
    const { host } = fakeHost()
    const { surface, sent } = fakeSurface()
    const handlers = createHandlers(host, surface)
    await handlers.sendPrompt({ text: "one" })
    expect(await refused(handlers.sendPrompt({ text: "two" }))).toBe(true)
    expect(await refused(handlers.copyText({ text: "three" }))).toBe(true)
    expect(sent).toEqual(["one"])
  })

  test("outward actions need a user gesture", async () => {
    const { host } = fakeHost()
    const { surface, sent } = fakeSurface()
    setGesture(false)
    expect(await refused(createHandlers(host, surface).sendPrompt({ text: "x" }))).toBe(true)
    expect(sent).toHaveLength(0)
  })

  test("sendPrompt without a session refuses with a toast; a failed send toasts and rethrows", async () => {
    const { host, calls } = fakeHost()
    const { surface } = fakeSurface({ sendPrompt: undefined })
    expect(await refused(createHandlers(host, surface).sendPrompt({ text: "x" }))).toBe(true)
    expect(calls.toasts.at(-1)).toMatchObject({ title: "action.noSession", variant: "error" })

    const failing = fakeSurface({
      sendPrompt: async () => {
        throw new Error("offline")
      },
    })
    const error = await createHandlers(host, failing.surface)
      .sendPrompt({ text: "x" })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(isRefusal(error)).toBe(false)
    expect(calls.toasts.at(-1)).toMatchObject({ title: "action.sendFailed", description: "offline", variant: "error" })
  })

  test("insertPrompt fills the composer and refuses empty text", async () => {
    const { host } = fakeHost()
    const first = fakeSurface()
    await createHandlers(host, first.surface).insertPrompt({ text: "Change the env to " })
    expect(first.inserted).toEqual(["Change the env to "])
    const second = fakeSurface()
    expect(await refused(createHandlers(host, second.surface).insertPrompt({ text: "  " }))).toBe(true)
    expect(second.inserted).toHaveLength(0)
  })

  test("openLink opens safe URLs only, through the gate", async () => {
    const { host, calls } = fakeHost()
    await createHandlers(host, fakeSurface().surface).openLink({ url: "https://example.com/docs" })
    expect(calls.opened).toEqual(["https://example.com/docs"])

    expect(await refused(createHandlers(host, fakeSurface().surface).openLink({ url: "javascript:alert(1)" }))).toBe(
      true,
    )
    expect(calls.toasts.at(-1)).toMatchObject({ title: "action.linkBlocked", variant: "error" })
    expect(calls.opened).toHaveLength(1)
  })

  test("openLink honors a requested confirm", async () => {
    const { host, calls } = fakeHost({ answer: false })
    const result = createHandlers(host, fakeSurface().surface).openLink({
      url: "https://example.com",
      [CONFIRM_PARAM]: { title: "Leave the app?" },
    })
    expect(await refused(result)).toBe(true)
    expect(calls.confirms[0]!.title).toBe("Leave the app?")
    expect(calls.opened).toHaveLength(0)
  })

  test("copyText copies and confirms with a toast", async () => {
    const { host, calls } = fakeHost()
    await createHandlers(host, fakeSurface().surface).copyText({ text: "npm i", label: "the command" })
    expect(calls.copies).toEqual(["npm i"])
    expect(calls.toasts.at(-1)).toMatchObject({
      title: 'action.copiedLabel {"label":"the command"}',
      variant: "success",
    })

    const failing = fakeHost({ copyFails: true })
    await createHandlers(failing.host, fakeSurface().surface)
      .copyText({ text: "x" })
      .catch(() => {})
    expect(failing.calls.toasts.at(-1)).toMatchObject({ title: "action.copyFailed", variant: "error" })
  })

  test("showToast shows, is rate limited, and asks first only when requested", async () => {
    const { host, calls } = fakeHost()
    const handlers = createHandlers(host, fakeSurface().surface)
    for (let index = 0; index < TOAST_BURST; index++)
      await handlers.showToast({ title: `t${index}`, variant: "success" })
    expect(await refused(handlers.showToast({ title: "flood" }))).toBe(true)
    expect(calls.toasts.map((toast) => toast.title)).toEqual(["t0", "t1", "t2"])
    expect(calls.toasts[0]).toMatchObject({ variant: "success" })
    expect(calls.confirms).toHaveLength(0)

    const asked = fakeHost({ answer: false })
    expect(
      await refused(
        createHandlers(asked.host, fakeSurface().surface).showToast({
          title: "Hi",
          [CONFIRM_PARAM]: { title: "Show?" },
        }),
      ),
    ).toBe(true)
    expect(asked.calls.confirms[0]!.title).toBe("Show?")
    expect(asked.calls.toasts).toHaveLength(0)
  })

  test("showToast with an unknown variant falls back to default; without a title it does nothing", async () => {
    const { host, calls } = fakeHost()
    const handlers = createHandlers(host, fakeSurface().surface)
    await handlers.showToast({ title: "Saved", variant: "loud", description: "ok" })
    expect(calls.toasts[0]).toEqual({ title: "Saved", description: "ok", variant: "default" })
    expect(await refused(handlers.showToast({ title: "" }))).toBe(true)
  })

  test("openCanvas sanitizes the id, is rate limited, and honors a requested confirm", async () => {
    const { host } = fakeHost()
    const { surface, canvases } = fakeSurface()
    const handlers = createHandlers(host, surface)
    await handlers.openCanvas({ canvas: "Deploy Dashboard" })
    expect(canvases).toEqual(["deploy-dashboard"])
    expect(await refused(handlers.openCanvas({ canvas: "other" }))).toBe(true)
    expect(await refused(createHandlers(host, fakeSurface().surface).openCanvas({ canvas: "  " }))).toBe(true)

    const declined = fakeHost({ answer: false })
    const target = fakeSurface()
    expect(
      await refused(
        createHandlers(declined.host, target.surface).openCanvas({ canvas: "main", [CONFIRM_PARAM]: true }),
      ),
    ).toBe(true)
    expect(declined.calls.confirms).toHaveLength(1)
    expect(target.canvases).toHaveLength(0)
  })

  test("a requested confirm on a non-outward action needs a user gesture", async () => {
    const { host, calls } = fakeHost()
    setGesture(false)
    expect(
      await refused(
        createHandlers(host, fakeSurface().surface).showToast({ title: "Hi", [CONFIRM_PARAM]: { title: "Show?" } }),
      ),
    ).toBe(true)
    expect(calls.confirms).toHaveLength(0)
  })

  test("ActionRefused is recognizable by name", () => {
    expect(isRefusal(new ActionRefused("x"))).toBe(true)
    expect(isRefusal(new Error("x"))).toBe(false)
    expect(isRefusal("x")).toBe(false)
  })
})
