import { createMemo, createSignal, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  Composer,
  ComposerFile,
  ComposerModel,
  ComposerNote,
  ComposerQuote,
  MountedSession,
  SessionRef,
  SessionScreen,
} from "@opencode/plugin/gui"
import type { FakeServer } from "./server.ts"
import { unimplemented } from "./stub.ts"

export interface PlaygroundSession {
  readonly ref: SessionRef
  readonly title: string
}

export interface Sessions {
  readonly all: readonly PlaygroundSession[]
  /** The routed session: a new frozen object each time a session is routed. */
  readonly current: Accessor<MountedSession>
  readonly screen: SessionScreen
  route(key: string): void
  find(key: string): PlaygroundSession | undefined
  /** What the composer holds and did, for the composer UI and tests. */
  readonly composer: {
    text(sessionKey: string): string
    setText(sessionKey: string, text: string): void
    readonly attached: (ComposerFile | ComposerNote | ComposerQuote)[]
    focusRequests: number
  }
}

const DIRECTORY = "/workspace/acme-app"

export function createSessions(server: FakeServer, input: { readonly ids: readonly string[] }): Sessions {
  const all = input.ids.map((id, index): PlaygroundSession => {
    server.ensure(id)
    return {
      title: `Session ${String.fromCharCode(65 + index)}`,
      ref: Object.freeze({
        key: `${server.ref.id}\n${id}`,
        id,
        tab: `tab-${index + 1}`,
        server: server.ref,
        pending: false,
        location: { directory: DIRECTORY },
      }),
    }
  })
  const [routed, setRouted] = createSignal(all[0]!.ref.key)
  const [drafts, setDrafts] = createStore<Record<string, string>>({})
  const [model, setModel] = createSignal<ComposerModel>({ providerID: "playground", modelID: "playground-model" })

  const project = {
    id: "prj_playground",
    worktree: DIRECTORY,
    worktrees: [],
    name: "acme-app",
  }

  // One frozen object per routing visit, as the app's MountedSession.
  const current = createMemo(() => {
    const session = all.find((item) => item.ref.key === routed()) ?? all[0]!
    const mounted: MountedSession = Object.freeze({
      ...session.ref,
      visit: {},
      get project() {
        return project as unknown as MountedSession["project"]
      },
      get listedProject() {
        return { worktree: DIRECTORY, name: "acme-app" }
      },
      directory: DIRECTORY,
      get local() {
        return true
      },
      get background() {
        return []
      },
    })
    return mounted
  })

  const attached: (ComposerFile | ComposerNote | ComposerQuote)[] = []
  const composerState = {
    text: (key: string) => drafts[key] ?? "",
    setText: (key: string, text: string) => setDrafts(key, text),
    attached,
    focusRequests: 0,
  }

  const composer: Composer = {
    text: () => composerState.text(routed()),
    insert(text) {
      if (!text) return
      const key = routed()
      const before = composerState.text(key)
      composerState.setText(
        key,
        before && !before.endsWith(" ") && !before.endsWith("\n") ? `${before} ${text}` : before + text,
      )
    },
    setText: (text) => composerState.setText(routed(), text),
    model: () => model(),
    setModel(next) {
      setModel({ ...next })
      return true
    },
    setVariant(variant) {
      setModel((current) => ({ ...current, variant }))
      return true
    },
    attach: (part) => void attached.push(structuredClone(part)),
    quotable: () => true,
    focus() {
      composerState.focusRequests++
      document.querySelector<HTMLTextAreaElement>("[data-playground-composer] textarea")?.focus()
    },
    update(id, patch) {
      const part = attached.find((item) => "commentID" in item && item.commentID === id)
      if (part && patch.comment !== undefined) (part as { comment?: string }).comment = patch.comment
    },
    detach(id) {
      const index = attached.findIndex((item) => "commentID" in item && item.commentID === id)
      if (index >= 0) attached.splice(index, 1)
    },
    focused: () => !!document.activeElement?.closest("[data-playground-composer]"),
  }

  const screen: SessionScreen = {
    file: unimplemented(
      { root: DIRECTORY, ready: () => true, resolve: (path: string) => path },
      "screen.file",
    ) as never,
    comment: unimplemented({ list: () => [] }, "screen.comment") as never,
    composer,
  }

  return {
    all,
    current,
    screen,
    route: (key) => setRouted(key),
    find: (key) => all.find((item) => item.ref.key === key),
    composer: composerState,
  }
}
