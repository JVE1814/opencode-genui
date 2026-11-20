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
})
