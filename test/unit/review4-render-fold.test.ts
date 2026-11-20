import { describe, expect, test } from "bun:test"
import { foldCanvases, type CanvasBlock } from "../../src/protocol/fold.ts"
import { canvasIdOf, parseBlock } from "../../src/protocol/surface.ts"

// A canvas patch block that switches /root to an element the canvas already has keeps the canvas [review4 USE#2].

const json = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n")
const add = (path: string, value: unknown) => ({ op: "add", path, value })
const text = (key: string, value: string) => add(`/elements/${key}`, { type: "Text", props: { text: value } })

function block(messageID: string, body: string, closed = true): CanvasBlock {
  const parsed = parseBlock(body, { partial: !closed })
  return {
    ref: { messageID, part: 0, ordinal: 0 },
    canvas: canvasIdOf(parsed.header),
    block: parsed,
    closed,
    complete: closed,
  }
}

const deploy = block(
  "msg_01",
  json(
    { canvas: "deploy", title: "Deploy" },
    add("/root", "running"),
    text("running", "Deploying…"),
    text("done", "Deployed."),
    add("/state", { note: "" }),
  ),
)

describe("canvas root switches [review4 USE#2]", () => {
  test("replacing /root with an element the canvas has switches the view and keeps elements, state and generation", () => {
    const switched = block("msg_02", json({ canvas: "deploy" }, { op: "replace", path: "/root", value: "done" }))
    const state = foldCanvases({}, [deploy, switched]).canvases.get("deploy")!
    // Before, the block counted as a whole new canvas: an empty spec with root "done" and no elements.
    expect(state.spec?.root).toBe("done")
    expect(Object.keys(state.spec?.elements ?? {}).sort()).toEqual(["done", "running"])
    expect(state.spec?.state).toEqual({ note: "" })
    expect(state.generation).toBe(1)
    expect(state.missingBase).toBe(false)

    // Also with an extra element the new root shows, and with `add` instead of `replace`.
    const withExtra = block(
      "msg_02",
      json(
        { canvas: "deploy" },
        text("summary", "3 services"),
        add("/elements/done/children", ["summary"]),
        add("/root", "done"),
      ),
    )
    const extra = foldCanvases({}, [deploy, withExtra]).canvases.get("deploy")!
    expect(extra.generation).toBe(1)
    expect(Object.keys(extra.spec?.elements ?? {}).sort()).toEqual(["done", "running", "summary"])
  })

  test("a block that sets /root and adds that element still replaces the canvas", () => {
    const resend = block("msg_02", json({ canvas: "deploy" }, add("/root", "running"), text("running", "Again")))
    const state = foldCanvases({}, [deploy, resend]).canvases.get("deploy")!
    expect(state.generation).toBe(2)
    expect(Object.keys(state.spec?.elements ?? {})).toEqual(["running"])
    expect(state.spec?.state).toBeUndefined()

    // While it streams, its first line keeps the old canvas in view; the root element makes it a new one.
    const first = block("msg_02", json({ canvas: "deploy" }, add("/root", "running")), false)
    const streaming = foldCanvases({}, [deploy, first]).canvases.get("deploy")!
    expect(streaming.generation).toBe(1)
    expect(Object.keys(streaming.spec?.elements ?? {}).sort()).toEqual(["done", "running"])

    // A root the canvas does not have, and a new canvas, replace as before.
    const unknown = block("msg_02", json({ canvas: "deploy" }, add("/root", "page")))
    expect(foldCanvases({}, [deploy, unknown]).canvases.get("deploy")!.generation).toBe(2)
    expect(foldCanvases({}, [deploy]).canvases.get("deploy")!.generation).toBe(1)

    // The header's mode still decides when given.
    const forced = block("msg_02", json({ canvas: "deploy", mode: "replace" }, add("/root", "done")))
    expect(foldCanvases({}, [deploy, forced]).canvases.get("deploy")!.generation).toBe(2)

    // An `/elements` map that holds the root element is a whole canvas too.
    const map = block(
      "msg_02",
      json(
        { canvas: "deploy" },
        add("/root", "done"),
        add("/elements", { done: { type: "Text", props: { text: "x" } } }),
      ),
    )
    expect(foldCanvases({}, [deploy, map]).canvases.get("deploy")!.generation).toBe(2)
  })

  test("switching /root and rewriting that element with `replace` patches the canvas, in either order [recheck#5]", () => {
    // RFC 6902 `replace` only updates a member that exists: the agent rewrites the view it switches to.
    const rewritten = { type: "Card", props: { title: "Deployed v2" }, children: ["running"] }
    for (const lines of [
      [
        { op: "replace", path: "/root", value: "done" },
        { op: "replace", path: "/elements/done", value: rewritten },
      ],
      [
        { op: "replace", path: "/elements/done", value: rewritten },
        { op: "replace", path: "/root", value: "done" },
      ],
    ]) {
      const state = foldCanvases({}, [deploy, block("msg_02", json({ canvas: "deploy" }, ...lines))]).canvases.get(
        "deploy",
      )!
      // Before, it counted as a whole new canvas: only "done", whose child was gone, and no state.
      expect(state.generation).toBe(1)
      expect(state.spec?.root).toBe("done")
      expect(Object.keys(state.spec?.elements ?? {}).sort()).toEqual(["done", "running"])
      expect(state.spec?.elements?.done).toEqual(rewritten)
      expect(state.spec?.state).toEqual({ note: "" })
    }
  })

  test("a copy or move of one of the canvas's elements to the root patches it [review5#F5]", () => {
    // Before, it counted as the block adding its own root, so the block replayed onto an empty spec where the copy
    // had no source: an empty canvas, its state and the user's edits gone.
    for (const [lines, shown] of [
      [
        [
          { op: "copy", from: "/elements/running", path: "/elements/done" },
          { op: "replace", path: "/root", value: "done" },
        ],
        "Deploying…",
      ],
      [
        [
          { op: "move", from: "/elements/done", path: "/elements/done2" },
          { op: "replace", path: "/root", value: "done2" },
        ],
        "Deployed.",
      ],
    ] as const) {
      const state = foldCanvases({}, [deploy, block("msg_02", json({ canvas: "deploy" }, ...lines))]).canvases.get(
        "deploy",
      )!
      expect(state.generation).toBe(1)
      expect(state.spec?.elements?.[state.spec.root]).toEqual({ type: "Text", props: { text: shown } })
      expect(state.spec?.state).toEqual({ note: "" })
    }
    // A copy of an element the block added itself is still a whole new canvas.
    const own = block(
      "msg_02",
      json(
        { canvas: "deploy" },
        text("draft", "New"),
        { op: "copy", from: "/elements/draft", path: "/elements/page" },
        add("/root", "page"),
      ),
    )
    const state = foldCanvases({}, [deploy, own]).canvases.get("deploy")!
    expect(state.generation).toBe(2)
    expect(Object.keys(state.spec?.elements ?? {}).sort()).toEqual(["draft", "page"])
  })

  test("a root switch while the canvas's base is unknown patches, so the base is looked for [review5#F2]", () => {
    // The creation is in messages not loaded and no snapshot is stored. Before, the switch counted as a whole new
    // canvas: an empty spec with root "done", settled and saved, and nothing looked for the older messages.
    const switched = block("msg_08", json({ canvas: "deploy" }, { op: "replace", path: "/root", value: "done" }))
    const unknown = foldCanvases({}, [switched]).canvases.get("deploy")!
    expect(unknown.missingBase).toBe(true)
    expect(unknown.settled).toBeUndefined()
    // With the base loaded, the switch applies to it.
    const found = foldCanvases({}, [deploy, switched]).canvases.get("deploy")!
    expect(found.missingBase).toBe(false)
    expect(Object.keys(found.spec?.elements ?? {}).sort()).toEqual(["done", "running"])
    expect(found.settled?.spec).toBe(found.spec!)
    // `add /root` with no element is still a new canvas whose elements may come later, and so is a switch while it
    // streams (the first line of a whole canvas).
    expect(
      foldCanvases({}, [block("msg_08", json({ canvas: "deploy" }, add("/root", "done")))]).canvases.get("deploy")!
        .missingBase,
    ).toBe(false)
    const streaming = block(
      "msg_08",
      json({ canvas: "deploy" }, { op: "replace", path: "/root", value: "done" }),
      false,
    )
    expect(foldCanvases({}, [streaming]).canvases.get("deploy")!.missingBase).toBe(false)
  })
})
