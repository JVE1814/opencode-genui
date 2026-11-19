import { describe, expect, test } from "bun:test"
import {
  blockKind,
  canvasIdOf,
  hashText,
  isMeaningful,
  parseBlock,
  sanitizeId,
  specToPatches,
  type SurfaceHeader,
} from "../../src/protocol/surface.ts"

const ROOT = '{"op":"add","path":"/root","value":"main"}'
const MAIN = '{"op":"add","path":"/elements/main","value":{"type":"Text","props":{"text":"hi"}}}'

describe("parseBlock", () => {
  test("one patch per line", () => {
    const block = parseBlock([ROOT, MAIN].join("\n"))
    expect(block.patches).toEqual([
      { op: "add", path: "/root", value: "main" },
      { op: "add", path: "/elements/main", value: { type: "Text", props: { text: "hi" } } },
    ])
    expect(block.errors).toEqual([])
    expect(block.header).toEqual({})
    expect(block.hasRoot).toBe(true)
  })

  test("keeps only the fields of a patch", () => {
    const block = parseBlock('{"op":"move","from":"/a","path":"/b","extra":1}\n{"op":"remove","path":"/c","from":5}')
    expect(block.patches).toEqual([
      { op: "move", from: "/a", path: "/b" },
      { op: "remove", path: "/c" },
    ])
  })

  test("a value of null is kept", () => {
    expect(parseBlock('{"op":"replace","path":"/state/x","value":null}').patches).toEqual([
      { op: "replace", path: "/state/x", value: null },
    ])
  })

  test("a header line before the first patch", () => {
    const block = parseBlock(['{"canvas":"Deploy","title":"Deploy dashboard"}', ROOT].join("\n"))
    expect(block.header).toEqual({ canvas: "deploy", title: "Deploy dashboard" })
    expect(block.patches).toHaveLength(1)
    expect(block.errors).toEqual([])
  })

  test("a header after blank lines and comments still counts", () => {
    const block = parseBlock(["", "// a comment", '{"title":"T"}', ROOT].join("\n"))
    expect(block.header).toEqual({ title: "T" })
  })

  test("an object without op after the first patch is an error, not a header", () => {
    const block = parseBlock([ROOT, '{"title":"Late"}'].join("\n"))
    expect(block.header).toEqual({})
    expect(block.errors).toEqual([{ line: 2, text: '{"title":"Late"}', message: "Not a JSON patch" }])
  })

  test("only the first header counts", () => {
    const block = parseBlock(['{"title":"One"}', '{"title":"Two"}', ROOT].join("\n"))
    expect(block.header).toEqual({ title: "One" })
    expect(block.errors).toHaveLength(1)
    expect(block.errors[0]!.line).toBe(2)
  })

  test.each([
    [{ canvas: "  My Canvas!! " }, { canvas: "my-canvas" }],
    [{ canvas: "!!!" }, { canvas: "main" }],
    [{ canvas: 5 }, { canvas: "main" }],
    [{ canvas: null }, { canvas: "main" }],
    [{ title: "  spaced  " }, { title: "spaced" }],
    [{ title: "   " }, {}],
    [{ title: 7 }, {}],
    [{ title: "x".repeat(200) }, { title: "x".repeat(120) }],
    [{ id: "Signup Form" }, { id: "signup-form" }],
    [{ id: "***" }, {}],
    [{ mode: "replace" }, { mode: "replace" }],
    [{ mode: "patch" }, { mode: "patch" }],
    [{ mode: "merge" }, {}],
    [{ close: true }, { close: true }],
    [{ close: "true" }, {}],
    [{ close: false }, {}],
    [{ unknown: 1 }, {}],
  ] as [Record<string, unknown>, SurfaceHeader][])("header %j -> %j", (header, expected) => {
    const block = parseBlock(`${JSON.stringify(header)}\n${ROOT}`)
    expect(block.header).toEqual(expected)
  })

  test("a header with __proto__ does not pollute", () => {
    const block = parseBlock(`{"__proto__":{"polluted":true},"title":"x"}\n${ROOT}`)
    expect(block.header).toEqual({ title: "x" })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("invalid lines are reported with their 1-based line number", () => {
    const block = parseBlock([ROOT, "", "{not json", '{"op":"set","path":"/x"}', '"text"', MAIN].join("\n"))
    expect(block.patches).toHaveLength(2)
    expect(block.errors.map((error) => error.line)).toEqual([3, 4, 5])
    expect(block.errors[1]!.message).toBe("Not a JSON patch")
    expect(block.errors[2]!.message).toBe("Not a JSON patch")
  })

  test("long invalid lines are truncated in errors", () => {
    const block = parseBlock(`{${"x".repeat(500)}`)
    expect(block.errors[0]!.text).toHaveLength(200)
  })

  test("a patch without a string path is not a patch", () => {
    expect(parseBlock('{"op":"add","path":5,"value":1}').errors).toHaveLength(1)
  })

  describe("partial", () => {
    const body = [ROOT, '{"op":"add","path":"/elements/main","value":{"type":'].join("\n")

    test("ignores an unparsable last line only when partial", () => {
      expect(parseBlock(body, { partial: true })).toMatchObject({ errors: [], patches: [{ path: "/root" }] })
      expect(parseBlock(body).errors).toHaveLength(1)
      expect(parseBlock(body).errors[0]!.line).toBe(2)
    })

    test("the last line is the last non-blank one", () => {
      expect(parseBlock(`${body}\n\n`, { partial: true }).errors).toEqual([])
    })

    test("earlier bad lines are still errors", () => {
      const block = parseBlock(["{bad", ROOT, "{also"].join("\n"), { partial: true })
      expect(block.errors.map((error) => error.line)).toEqual([1])
    })
  })

  describe("whole spec documents", () => {
    const spec = {
      root: "main",
      elements: { main: { type: "Stack", props: {}, children: ["t"] }, "a/b": { type: "Text", props: {} } },
      state: { x: 1 },
    }

    test("on one line", () => {
      const block = parseBlock(JSON.stringify(spec))
      expect(block.errors).toEqual([])
      expect(block.patches).toEqual(specToPatches(spec as never))
      expect(block.hasRoot).toBe(true)
    })

    test("spread over lines", () => {
      const block = parseBlock(JSON.stringify(spec, null, 2))
      expect(block.errors).toEqual([])
      expect(block.patches).toEqual(specToPatches(spec as never))
    })

    test("spread over lines after a header", () => {
      const block = parseBlock(`{"canvas":"deploy","title":"Deploy"}\n${JSON.stringify(spec, null, 2)}`)
      expect(block.errors).toEqual([])
      expect(block.header).toEqual({ canvas: "deploy", title: "Deploy" })
      expect(block.patches).toEqual(specToPatches(spec as never))
    })

    test("specToPatches escapes element keys and adds state last", () => {
      expect(specToPatches(spec as never)).toEqual([
        { op: "add", path: "/root", value: "main" },
        { op: "add", path: "/elements/main", value: spec.elements.main },
        { op: "add", path: "/elements/a~1b", value: spec.elements["a/b"] },
        { op: "add", path: "/state", value: { x: 1 } },
      ])
    })

    test("a broken multi-line document keeps the line errors", () => {
      const text = JSON.stringify(spec, null, 2).slice(0, -1)
      expect(parseBlock(text).errors.length).toBeGreaterThan(0)
      expect(parseBlock(text).patches).toEqual([])
    })
  })

  test("comment lines are skipped", () => {
    const block = parseBlock(["// build the root", ROOT, "  // indented comment", MAIN].join("\n"))
    expect(block.patches).toHaveLength(2)
    expect(block.errors).toEqual([])
  })

  test("CRLF bodies parse", () => {
    expect(parseBlock(`${ROOT}\r\n${MAIN}\r\n`).patches).toHaveLength(2)
  })

  test("hasRoot only for add or replace of /root", () => {
    expect(parseBlock(MAIN).hasRoot).toBe(false)
    expect(parseBlock('{"op":"replace","path":"/root","value":"x"}').hasRoot).toBe(true)
    expect(parseBlock('{"op":"remove","path":"/root"}').hasRoot).toBe(false)
  })

  test("the hash is stable across blank lines and indentation", () => {
    const a = parseBlock([ROOT, MAIN].join("\n"))
    const b = parseBlock(["", `   ${ROOT}  `, "", "", `\t${MAIN}`, ""].join("\n"))
    const c = parseBlock([ROOT, MAIN.replace("hi", "ho")].join("\n"))
    expect(a.hash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("hashText", () => {
  test("is FNV-1a as 8 hex digits", () => {
    expect(hashText("")).toBe("811c9dc5")
    expect(hashText("a")).toBe("e40c292c")
    expect(hashText("foobar")).toBe("bf9cf968")
  })
})

describe("sanitizeId", () => {
  test.each([
    ["main", "main"],
    ["  Deploy Dashboard ", "deploy-dashboard"],
    ["a/b\\c", "a-b-c"],
    ["--x--", "x"],
    ["snake_case-ok", "snake_case-ok"],
    ["ÄÖÜ", undefined],
    ["", undefined],
    ["   ", undefined],
    [5, undefined],
    [null, undefined],
    ["x".repeat(100), "x".repeat(64)],
  ])("%j -> %j", (value, expected) => {
    expect(sanitizeId(value)).toBe(expected)
  })
})

describe("blockKind", () => {
  test.each([
    ["canvas", {}, "canvas"],
    ["spec", {}, "inline"],
    ["spec", { canvas: "x" }, "canvas"],
    ["spec", { title: "x" }, "inline"],
  ] as const)("%s with %j -> %s", (language, header, kind) => {
    expect(blockKind(language, header)).toBe(kind)
  })

  test("canvasIdOf defaults to main", () => {
    expect(canvasIdOf({})).toBe("main")
    expect(canvasIdOf({ canvas: "deploy" })).toBe("deploy")
  })
})

describe("isMeaningful", () => {
  test.each([
    ["", false],
    ["// only a comment", false],
    ['{"title":"only a header"}', false],
    ['{"canvas":"x","close":true}', true],
    [ROOT, true],
    ["{broken", false],
  ])("%j -> %p", (body, expected) => {
    expect(isMeaningful(parseBlock(body))).toBe(expected)
  })
})
