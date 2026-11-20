import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_PREFS, type Host, type SurfaceContext } from "../../src/gui/host.ts"
import {
  allowOutward,
  asModalFocusMove,
  confirmIntent,
  hasIntent,
  isModalFocusMove,
  isPassiveDispatch,
  MODAL_OPENS_PER_TASK,
  modalRefusal,
  noteAgentState,
  noteModal,
  REOPEN_MS,
  whileAway,
  withIntent,
  withoutIntent,
} from "../../src/gui/outward.ts"

// Regression tests for the sixth review's modal findings ([review6#R2], [review6#R5]). Whether a modal may open is
// decided from a record kept per state store, open path and window (src/gui/outward.ts), so a Dialog the spec remounts
// starts with nothing of its own; and an activation's intent is set aside while its dispatch waits outside the page.

const surface = (trusted = true): SurfaceContext => ({ kind: "inline", id: "s", trusted })
/** A state store, as the modal keys it: any object; a remounted Dialog asks with the same one. */
const store = () => ({})
/** The next task: the modal record's per-task part starts afresh. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

const realNow = Date.now
// Each test runs at its own far-apart time, so a dismissal another test noted is long past.
let clock = 1_000_000_000
const freshClock = () => {
  clock += 10 * REOPEN_MS
  const at = clock
  Date.now = () => at
  return {
    advance: (ms: number) => {
      const now = Date.now() + ms
      Date.now = () => now
    },
  }
}
afterEach(() => {
  Date.now = realNow
})

describe("which modals may open [review6#R2]", () => {
  test("a modal opens once per task at its path: a remounted Dialog (same store and path) is refused too", async () => {
    freshClock()
    await nextTask()
    const one = store()
    expect(modalRefusal(one, "/open", surface())).toBeUndefined()
    noteModal(one, "/open", "opened")
    // A fresh Dialog on the same store and path (the spec hid and re-showed it) asks in the same task.
    expect(modalRefusal(one, "/open", surface())).toBe("again")
    // A close in this task counts the same: focus moves of the close re-open nothing in it.
    const two = store()
    noteModal(two, "/open", "closed")
    expect(modalRefusal(two, "/open", surface())).toBe("again")
    // Another path or another store is another modal.
    expect(modalRefusal(one, "/other", surface())).toBeUndefined()
    expect(modalRefusal(store(), "/open", surface())).toBeUndefined()
    await nextTask()
    expect(modalRefusal(one, "/open", surface())).toBeUndefined()
    expect(modalRefusal(two, "/open", surface())).toBeUndefined()
  })

  test("at most MODAL_OPENS_PER_TASK modals open in one task in the whole window, whatever their paths", async () => {
    freshClock()
    await nextTask()
    const one = store()
    for (let index = 0; index < MODAL_OPENS_PER_TASK; index++) {
      const path = `/o${index}`
      expect(modalRefusal(index % 2 ? one : store(), path, surface()), path).toBeUndefined()
      noteModal(index % 2 ? one : store(), path, "opened")
    }
    expect(modalRefusal(one, "/next", surface())).toBe("many")
    expect(modalRefusal(store(), "/next", surface(false))).toBe("many")
    await nextTask()
    expect(modalRefusal(one, "/next", surface())).toBeUndefined()
  })

  test("a passive dispatch (focus, blur, a slider, a browsed choice) opens no modal, on a trusted surface too", async () => {
    freshClock()
    await nextTask()
    const one = surface()
    let passive: unknown
    let viaActivation: unknown
    await withoutIntent(one, async () => {
      passive = modalRefusal(store(), "/open", one)
      expect(isPassiveDispatch(one)).toBe(true)
    })
    await withIntent(one, async () => {
      viaActivation = modalRefusal(store(), "/open", one)
    })
    expect(passive).toBe("passive")
    expect(viaActivation).toBeUndefined()
    // Outside any dispatch (the agent's state, a watch woken by it) a trusted surface's modal opens.
    expect(modalRefusal(store(), "/open", one)).toBeUndefined()
    expect(isPassiveDispatch(one)).toBe(false)
  })

  test("an untrusted surface's modal opens only from an activation of it", async () => {
    freshClock()
    await nextTask()
    const one = surface(false)
    expect(modalRefusal(store(), "/open", one)).toBe("untrusted")
    let pressed: unknown
    await withIntent(one, async () => {
      pressed = modalRefusal(store(), "/open", one)
    })
    expect(pressed).toBeUndefined()
  })

  test("for REOPEN_MS after the user dismissed a modal, only an activation opens one, on any trusted surface", async () => {
    const clock = freshClock()
    await nextTask()
    const one = store()
    const trusted = surface()
    noteModal(one, "/open", "opened", trusted)
    await nextTask()
    // Escape, the close button or the backdrop: a watch woken by the close may not re-open it, nor another modal.
    noteModal(one, "/open", "dismissed", trusted)
    await nextTask()
    clock.advance(REOPEN_MS - 100)
    expect(modalRefusal(one, "/open", trusted)).toBe("dismissed")
    expect(modalRefusal(store(), "/other", surface())).toBe("dismissed")
    // The user's own press opens it again at once.
    let pressed: unknown
    await withIntent(trusted, async () => {
      pressed = modalRefusal(one, "/open", trusted)
    })
    expect(pressed).toBeUndefined()
    clock.advance(200)
    expect(modalRefusal(one, "/open", trusted)).toBeUndefined()
  })

  test("once the user dismissed a modal of a store, it opens by itself again only after an activation or the agent's next state [R6S1-4]", async () => {
    const clock = freshClock()
    await nextTask()
    const one = store()
    const trusted = surface()
    noteModal(one, "/open", "opened", trusted)
    await nextTask()
    noteModal(one, "/open", "dismissed", trusted)
    await nextTask()
    // A watch woken by the dismissal whose list waited past REOPEN_MS (deferred to later tasks) may not re-open it, nor
    // any other modal of the store; it re-opened the Dialog 3 s after every Escape.
    clock.advance(REOPEN_MS * 4)
    expect(modalRefusal(one, "/open", trusted)).toBe("dismissed")
    expect(modalRefusal(one, "/other", trusted)).toBe("dismissed")
    // Other stores are not held back once REOPEN_MS has passed.
    expect(modalRefusal(store(), "/open", trusted)).toBeUndefined()
    // The user's next activation of the surface, a press of any of its controls, ends it.
    await withIntent(trusted, async () => {})
    expect(modalRefusal(one, "/open", trusted)).toBeUndefined()
    // So does the agent's next version of the state.
    await nextTask()
    noteModal(one, "/open", "dismissed", trusted)
    await nextTask()
    clock.advance(REOPEN_MS * 4)
    expect(modalRefusal(one, "/open", trusted)).toBe("dismissed")
    noteAgentState(trusted)
    expect(modalRefusal(one, "/open", trusted)).toBeUndefined()
  })
})

describe("focus moves a modal makes [review6#R2]", () => {
  test("are genui's while its showModal() or close() runs, also when it throws, and only then", () => {
    expect(isModalFocusMove()).toBe(false)
    const seen: boolean[] = []
    asModalFocusMove(() => {
      // The focus and blur events showModal() fires run inside the call.
      seen.push(isModalFocusMove())
      asModalFocusMove(() => seen.push(isModalFocusMove()))
      seen.push(isModalFocusMove())
    })
    expect(seen).toEqual([true, true, true])
    expect(isModalFocusMove()).toBe(false)
    expect(() =>
      asModalFocusMove(() => {
        throw new Error("InvalidStateError")
      }),
    ).toThrow()
    expect(isModalFocusMove()).toBe(false)
  })
})

describe("an activation waiting outside the page lends its intent to nothing [review6#R5]", () => {
  const fakeHost = (confirm: Host["confirm"]): Host => ({
    ui: {} as Host["ui"],
    t: (key) => key,
    mode: () => "light",
    confirm,
    toast: () => {},
    copy: async () => {},
    openExternal: () => {},
    prefs: () => DEFAULT_PREFS,
  })

  test("while its message is being sent, typing (no dispatch) finds no intent: no untrusted modal, nothing outward", async () => {
    freshClock()
    await nextTask()
    const one = surface(false)
    const host = fakeHost(async () => true)
    let release!: () => void
    const seen: unknown[] = []
    const press = withIntent(one, async () => {
      seen.push(hasIntent(one))
      // sendPrompt's `send`: the host's request, seconds on a slow connection.
      await whileAway(one, () => new Promise<void>((resolve) => (release = resolve)))
      // Back in the dispatch: its own later actions keep the intent.
      seen.push(hasIntent(one), modalRefusal(store(), "/open", one))
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // A keystroke's task: the watch it wakes asks the surface.
    expect(hasIntent(one)).toBe(false)
    expect(modalRefusal(store(), "/open", one)).toBe("untrusted")
    expect(await allowOutward(host, one, { title: "t", detail: "d", requireIntent: true })).toBe(false)
    release()
    await press
    expect(seen).toEqual([true, true, undefined])
  })

  test("while the app's confirm dialog is up, the intent is set aside; accepting brings it back", async () => {
    freshClock()
    await nextTask()
    const one = surface(false)
    let answer!: (ok: boolean) => void
    const host = fakeHost(() => new Promise<boolean>((resolve) => (answer = resolve)))
    let after: unknown
    const press = withIntent(one, async () => {
      await confirmIntent(host, one, { title: "t" })
      after = hasIntent(one)
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The agent's next patch, say, wakes a watch meanwhile.
    expect(hasIntent(one)).toBe(false)
    answer(true)
    await press
    expect(after).toBe(true)
  })
})
