import { describe, expect, test } from "bun:test"
import {
  compareRefs,
  createCanvasFolder,
  foldCanvases,
  jsonEqual,
  type CanvasBlock,
  type CanvasSnapshot,
  type CanvasState,
} from "../../src/protocol/fold.ts"
import { canvasIdOf, parseBlock } from "../../src/protocol/surface.ts"

const json = (...items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n")
const root = (key = "main") => ({ op: "add", path: "/root", value: key })
const element = (key: string, text: string) => ({
  op: "add",
  path: `/elements/${key}`,
  value: { type: "Text", props: { text } },
})

function block(
  messageID: string,
  body: string,
  options: { part?: number; ordinal?: number; closed?: boolean; complete?: boolean } = {},
): CanvasBlock {
  const closed = options.closed ?? true
  const parsed = parseBlock(body, { partial: !closed })
  return {
    ref: { messageID, part: options.part ?? 0, ordinal: options.ordinal ?? 0 },
    canvas: canvasIdOf(parsed.header),
    block: parsed,
    closed,
    complete: options.complete ?? true,
  }
}

const only = (result: { canvases: ReadonlyMap<string, CanvasState> }, id = "main") => {
  const state = result.canvases.get(id)
  if (!state) throw new Error(`no canvas ${id}`)
  return state
}

describe("compareRefs", () => {
  test("orders by message, then part, then ordinal", () => {
    const refs = [
      { messageID: "msg_02", part: 0, ordinal: 0 },
      { messageID: "msg_01", part: 2, ordinal: 0 },
      { messageID: "msg_01", part: 1, ordinal: 3 },
      { messageID: "msg_01", part: 1, ordinal: 1 },
    ]
    expect(refs.toSorted(compareRefs).map((ref) => `${ref.messageID}:${ref.part}:${ref.ordinal}`)).toEqual([
      "msg_01:1:1",
      "msg_01:1:3",
      "msg_01:2:0",
      "msg_02:0:0",
    ])
    expect(compareRefs(refs[0]!, { ...refs[0]! })).toBe(0)
  })
})

describe("foldCanvases", () => {
  test("a block with /root starts a canvas and a later block patches it", () => {
    const result = foldCanvases({}, [
      block("msg_01", json({ canvas: "main", title: "Deploy" }, root(), element("main", "one"))),
      block("msg_02", json(element("other", "two"))),
    ])
    const state = only(result)
    expect(state.title).toBe("Deploy")
    expect(state.generation).toBe(1)
    expect(state.spec?.root).toBe("main")
    expect(Object.keys(state.spec!.elements)).toEqual(["main", "other"])
    expect(state.missingBase).toBe(false)
    expect(state.streaming).toBe(false)
    expect(state.first).toEqual({ messageID: "msg_01", part: 0, ordinal: 0 })
    expect(state.last).toEqual({ messageID: "msg_02", part: 0, ordinal: 0 })
    expect(state.settled?.after).toEqual(state.last)
    expect(state.settled?.spec).toBe(state.spec!)
    expect(state.settled?.title).toBe("Deploy")
    expect(result.removed.size).toBe(0)
  })

  test("a new /root starts over and bumps the generation", () => {
    const state = only(
      foldCanvases({}, [
        block("msg_01", json(root(), element("main", "one"), element("extra", "x"))),
        block("msg_02", json(root("next"), element("next", "two"))),
      ]),
    )
    expect(state.generation).toBe(2)
    expect(state.spec).toEqual({ root: "next", elements: { next: { type: "Text", props: { text: "two" } } } } as never)
  })

  test("header mode overrides the /root inference", () => {
    const patched = only(
      foldCanvases({}, [
        block("msg_01", json(root(), element("main", "one"))),
        block("msg_02", json({ canvas: "main", mode: "patch" }, root("main2"), element("main2", "two"))),
      ]),
    )
    expect(patched.generation).toBe(1)
    expect(Object.keys(patched.spec!.elements)).toEqual(["main", "main2"])

    const replaced = only(
      foldCanvases({}, [
        block("msg_01", json(root(), element("main", "one"))),
        block("msg_02", json({ canvas: "main", mode: "replace" }, element("solo", "two"))),
      ]),
    )
    expect(replaced.generation).toBe(2)
    expect(replaced.spec).toEqual({ root: "", elements: { solo: { type: "Text", props: { text: "two" } } } } as never)
  })

  test("a patch with no base sets missingBase, still renders, and never settles", () => {
    const state = only(foldCanvases({}, [block("msg_05", json(element("main", "late")))]))
    expect(state.missingBase).toBe(true)
    expect(state.spec?.elements.main).toEqual({ type: "Text", props: { text: "late" } } as never)
    expect(state.generation).toBe(0)
    expect(state.settled).toBeUndefined()

    const fixed = only(
      foldCanvases({}, [block("msg_04", json(root())), block("msg_05", json(element("main", "late")))]),
    )
    expect(fixed.missingBase).toBe(false)
    expect(fixed.settled).toBeDefined()
  })

  test("a new canvas started with a `replace` of /root renders once its root element arrives, and settles once the history is searched [review6#R9, review7#R6F3-1]", () => {
    const switched = { op: "replace", path: "/root", value: "main" }
    const first = block("msg_05", json({ canvas: "main" }, switched, { op: "add", path: "/state/x", value: 1 }))
    // Alone, the switch may belong to a canvas in messages not loaded: its base is looked for.
    expect(only(foldCanvases({}, [first])).missingBase).toBe(true)
    expect(only(foldCanvases({}, [first])).baseUnknown).toBe(true)
    // Once the spec holds its root element, nothing is missing: it renders. Before review6#R9, it waited for a base
    // that does not exist, behind "Part of this canvas is missing", for good.
    const blocks = [first, block("msg_06", json(element("main", "hi")))]
    const state = only(foldCanvases({}, blocks))
    expect(state.missingBase).toBe(false)
    expect(state.spec).toEqual({
      root: "main",
      elements: { main: { type: "Text", props: { text: "hi" } } },
      state: { x: 1 },
    } as never)
    // It may still be an old canvas's view switch whose base is in messages not loaded (review7#R6F3-1): the base is
    // looked for, and nothing is saved, until the whole history is loaded without finding one. (This test asserted
    // that it settled right away, which saved such a canvas without its title and state.)
    expect(state.baseUnknown).toBe(true)
    expect(state.settled).toBeUndefined()
    const searched = only(foldCanvases({}, blocks, { searched: true }))
    expect(searched.baseUnknown).toBe(false)
    expect(searched.settled?.spec).toBe(searched.spec!)
    // A root element whose children are not all there still waits for its base.
    const partial = only(
      foldCanvases({}, [
        first,
        block(
          "msg_06",
          json({ op: "add", path: "/elements/main", value: { type: "Card", props: {}, children: ["body"] } }),
        ),
      ]),
    )
    expect(partial.missingBase).toBe(true)
    expect(partial.settled).toBeUndefined()
    const whole = only(
      foldCanvases({}, [
        first,
        block(
          "msg_06",
          json(
            { op: "add", path: "/elements/main", value: { type: "Card", props: {}, children: ["body"] } },
            element("body", "text"),
          ),
        ),
      ]),
    )
    expect(whole.missingBase).toBe(false)
    expect(whole.settled).toBeUndefined()
  })

  test("a root switch with a prop edit on an unknown base keeps looking for the base [R6F1-3]", () => {
    // The edit makes an element of that prop alone (no type): not the root element the switch points at.
    const state = only(
      foldCanvases({}, [
        block(
          "msg_08",
          json(
            { canvas: "main" },
            { op: "replace", path: "/root", value: "done" },
            { op: "replace", path: "/elements/done/props/text", value: "done v3" },
          ),
        ),
      ]),
    )
    expect(state.missingBase).toBe(true)
    expect(state.settled).toBeUndefined()
    // An element without props is not whole either; one with a type and props is.
    const typeOnly = only(
      foldCanvases({}, [
        block("msg_08", json({ canvas: "main" }, { op: "replace", path: "/root", value: "done" })),
        block("msg_09", json({ op: "add", path: "/elements/done", value: { type: "Text" } })),
      ]),
    )
    expect(typeOnly.missingBase).toBe(true)
    const typed = only(
      foldCanvases({}, [
        block("msg_08", json({ canvas: "main" }, { op: "replace", path: "/root", value: "done" })),
        block("msg_09", json({ op: "add", path: "/elements/done", value: { type: "Text", props: {} } })),
      ]),
    )
    expect(typed.missingBase).toBe(false)
  })

  test("starts from a snapshot and skips blocks up to its position", () => {
    const snapshot: CanvasSnapshot = {
      title: "Saved",
      spec: { root: "main", elements: { main: { type: "Text", props: { text: "saved" }, children: [] } } },
      after: { messageID: "msg_03", part: 1, ordinal: 0 },
      generation: 4,
      first: { messageID: "msg_01", part: 0, ordinal: 0 },
    }
    const result = foldCanvases({ main: snapshot }, [
      block("msg_02", json(root("old"), element("old", "old"))),
      block("msg_03", json(element("skipped", "x")), { part: 1 }),
      block("msg_04", json(element("added", "new"))),
    ])
    const state = only(result)
    expect(state.title).toBe("Saved")
    expect(state.generation).toBe(4)
    expect(state.spec?.root).toBe("main")
    expect(Object.keys(state.spec!.elements)).toEqual(["main", "added"])
    expect(state.first).toEqual(snapshot.first!)
    expect(state.spec!.elements.main).toBe(snapshot.spec.elements.main!)
  })

  test("a snapshot alone is a canvas whose settled state is the snapshot itself", () => {
    const snapshot: CanvasSnapshot = {
      spec: { root: "a", elements: {} },
      after: { messageID: "msg_03", part: 0, ordinal: 0 },
      generation: 1,
    }
    const state = only(foldCanvases({ main: snapshot }, []))
    expect(state.settled).toBe(snapshot)
    expect(state.spec).toBe(snapshot.spec)
    expect(state.first).toBe(snapshot.after)
  })

  test("the latest header title wins", () => {
    const state = only(
      foldCanvases({}, [
        block("msg_01", json({ canvas: "main", title: "One" }, root())),
        block("msg_02", json(element("main", "x"))),
        block("msg_03", json({ canvas: "main", title: "Three" }, element("main", "y"))),
      ]),
    )
    expect(state.title).toBe("Three")
  })

  test("close removes a canvas and a later block recreates it from scratch", () => {
    const snapshot: CanvasSnapshot = {
      spec: { root: "main", elements: { main: { type: "Text", props: {}, children: [] } } },
      after: { messageID: "msg_01", part: 0, ordinal: 0 },
      generation: 3,
    }
    const closed = foldCanvases({ main: snapshot }, [block("msg_02", json({ canvas: "main", close: true }))])
    expect(closed.canvases.has("main")).toBe(false)
    expect([...closed.removed]).toEqual(["main"])

    const recreated = foldCanvases({ main: snapshot }, [
      block("msg_02", json({ canvas: "main", close: true })),
      block("msg_03", json(element("x", "patch without base"))),
    ])
    const state = only(recreated)
    expect(recreated.removed.size).toBe(0)
    expect(state.missingBase).toBe(true)
    expect(Object.keys(state.spec!.elements)).toEqual(["x"])

    const restarted = only(
      foldCanvases({ main: snapshot }, [
        block("msg_02", json({ canvas: "main", close: true })),
        block("msg_03", json(root("y"), element("y", "fresh"))),
      ]),
    )
    expect(restarted.generation).toBe(4)
    expect(restarted.first.messageID).toBe("msg_03")
  })

  test("closing an unknown canvas reports it removed", () => {
    const result = foldCanvases({}, [block("msg_01", json({ canvas: "ghost", close: true }))])
    expect(result.canvases.size).toBe(0)
    expect([...result.removed]).toEqual(["ghost"])
  })

  test("a block still streaming marks the canvas streaming and does not settle", () => {
    const done = block("msg_01", json(root(), element("main", "one")))
    const open = block("msg_02", `${json(element("main", "two"))}\n{"op":"add","path":"/elements/b`, {
      closed: false,
      complete: false,
    })
    const state = only(foldCanvases({}, [done, open]))
    expect(state.streaming).toBe(true)
    expect(state.spec?.elements.main).toEqual({ type: "Text", props: { text: "two" } } as never)
    expect(state.settled?.after).toEqual(done.ref)
    expect(state.lineErrors).toEqual([])
  })

  test("a block cut off in a completed message is not streaming", () => {
    const state = only(foldCanvases({}, [block("msg_01", json(root()), { closed: false, complete: true })]))
    expect(state.streaming).toBe(false)
    expect(state.settled).toBeUndefined()
  })

  test("closed blocks of a message still streaming do not settle", () => {
    const state = only(foldCanvases({}, [block("msg_01", json(root()), { complete: false })]))
    expect(state.streaming).toBe(false)
    expect(state.settled).toBeUndefined()
  })

  test("line errors come from the latest block", () => {
    const state = only(
      foldCanvases({}, [block("msg_01", `${json(root())}\nnot json`), block("msg_02", json(element("a", "b")))]),
    )
    expect(state.lineErrors).toEqual([])
    const broken = only(foldCanvases({}, [block("msg_01", `${json(root())}\nnot json`)]))
    expect(broken.lineErrors).toHaveLength(1)
    expect(broken.lineErrors[0]!.line).toBe(2)
  })

  test("canvases are ordered by first appearance and folded independently", () => {
    const result = foldCanvases({}, [
      block("msg_01", json({ canvas: "b" }, root())),
      block("msg_02", json({ canvas: "a" }, root())),
      block("msg_03", json({ canvas: "b" }, element("x", "y"))),
    ])
    expect([...result.canvases.keys()]).toEqual(["b", "a"])
    expect(Object.keys(result.canvases.get("b")!.spec!.elements)).toEqual(["x"])
    expect(Object.keys(result.canvases.get("a")!.spec!.elements)).toEqual([])
  })

  test("canvas ids that are Object.prototype keys are plain ids", () => {
    const result = foldCanvases({}, [
      block("msg_01", json({ canvas: "constructor" }, root())),
      block("msg_02", json({ canvas: "__proto__" }, root())),
    ])
    expect(result.canvases.get("constructor")?.missingBase).toBe(false)
    expect(result.canvases.get("__proto__")?.generation).toBe(1)
  })
})

describe("createCanvasFolder", () => {
  test("unchanged inputs return the same canvas states", () => {
    const fold = createCanvasFolder()
    const blocks = [
      block("msg_01", json({ canvas: "a" }, root(), element("main", "a"))),
      block("msg_02", json({ canvas: "b" }, root(), element("main", "b"))),
    ]
    const first = fold({}, blocks)
    const second = fold({}, [...blocks])
    expect(second.canvases.get("a")).toBe(first.canvases.get("a")!)
    expect(second.canvases.get("b")).toBe(first.canvases.get("b")!)
  })

  test("a streaming block re-applies only itself and keeps what it did not touch", () => {
    const fold = createCanvasFolder()
    const other = block("msg_01", json({ canvas: "other" }, root(), element("main", "o")))
    const head = `${json({ canvas: "main" }, root(), element("main", "one"))}`
    const v1 = block("msg_02", `${head}\n{"op":"add","path":"/elements/tw`, { closed: false, complete: false })
    const r1 = fold({}, [other, v1])
    const s1 = only(r1)
    expect(Object.keys(s1.spec!.elements)).toEqual(["main"])

    const v2 = block("msg_02", `${head}\n${json(element("two", "2"))}\n{"op":`, { closed: false, complete: false })
    const r2 = fold({}, [other, v2])
    const s2 = only(r2)
    expect(r2.canvases.get("other")).toBe(r1.canvases.get("other")!)
    expect(s2).not.toBe(s1)
    expect(Object.keys(s2.spec!.elements)).toEqual(["main", "two"])
    // The element written before the delta keeps its identity although the block was parsed again.
    expect(s2.spec!.elements.main).toBe(s1.spec!.elements.main!)

    const v3 = block("msg_02", `${head}\n${json(element("two", "2"))}`, { closed: true, complete: false })
    const s3 = only(fold({}, [other, v3]))
    expect(s3.spec).toBe(s2.spec)
    expect(s3.streaming).toBe(false)

    const v4 = { ...v3, complete: true }
    const s4 = only(fold({}, [other, v4]))
    expect(s4.spec).toBe(s2.spec)
    expect(s4.settled?.spec).toBe(s2.spec!)
  })

  test("a snapshot it produced resumes from the same state", () => {
    const fold = createCanvasFolder()
    const blocks = [block("msg_01", json(root(), element("main", "a"))), block("msg_02", json(element("b", "b")))]
    const before = only(fold({}, blocks))
    const settled = before.settled!
    const after = fold({ main: settled }, blocks)
    expect(only(after)).toBe(before)

    const more = [...blocks, block("msg_03", json(element("c", "c")))]
    const extended = only(fold({ main: settled }, more))
    expect(extended.spec!.elements.b).toBe(before.spec!.elements.b!)
    expect(extended.first).toBe(before.first)
  })

  test("a JSON round trip of a snapshot folds to an equal state", () => {
    const blocks = [block("msg_01", json(root(), element("main", "a"))), block("msg_02", json(element("b", "b")))]
    const settled = only(foldCanvases({}, blocks)).settled!
    const copy = JSON.parse(JSON.stringify(settled)) as CanvasSnapshot
    const from = only(foldCanvases({ main: copy }, [...blocks, block("msg_03", json(element("c", "c")))]))
    const full = only(foldCanvases({}, [...blocks, block("msg_03", json(element("c", "c")))]))
    expect(from.spec).toEqual(full.spec!)
    expect(from.generation).toBe(full.generation)
    expect(from.first).toEqual(full.first)
  })

  test("the memoized fold equals a fresh fold at every step of a stream", () => {
    const fold = createCanvasFolder()
    const lines = [
      JSON.stringify({ canvas: "main", title: "T" }),
      JSON.stringify(root()),
      JSON.stringify(element("main", "one")),
      JSON.stringify({ op: "add", path: "/state", value: { count: 1 } }),
      JSON.stringify({ op: "replace", path: "/state/count", value: 2 }),
      JSON.stringify({ op: "remove", path: "/elements/main" }),
    ]
    const text = lines.join("\n")
    for (let end = 1; end <= text.length; end += 7) {
      const body = text.slice(0, end)
      const blocks = [
        block("msg_01", json({ canvas: "side" }, root())),
        block("msg_02", body, { closed: false, complete: false }),
      ]
      expect(JSON.stringify([...fold({}, blocks).canvases])).toBe(
        JSON.stringify([...foldCanvases({}, blocks).canvases]),
      )
    }
  })
})

describe("jsonEqual", () => {
  test("compares plain JSON by content and other objects by identity", () => {
    expect(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(jsonEqual([1, 2], { 0: 1, 1: 2 })).toBe(false)
    expect(jsonEqual(new Date(1), new Date(2))).toBe(false)
  })
})
