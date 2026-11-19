import { describe, expect, test } from "bun:test"
import { fenceLanguage, scanFences } from "../../src/protocol/fence.ts"

const only = (text: string) => {
  const blocks = scanFences(text)
  expect(blocks).toHaveLength(1)
  return blocks[0]!
}

describe("scanFences", () => {
  test("finds a closed backtick block", () => {
    expect(scanFences('before\n```spec\n{"a":1}\n```\nafter')).toEqual([
      { language: "spec", body: '{"a":1}', closed: true, ordinal: 0 },
    ])
  })

  test("finds a tilde block", () => {
    expect(only("~~~canvas\nline\n~~~")).toEqual({ language: "canvas", body: "line", closed: true, ordinal: 0 })
  })

  test("text without fences has no blocks", () => {
    expect(scanFences("")).toEqual([])
    expect(scanFences("just `inline` code and ``two``")).toEqual([])
  })

  test("a longer opening fence needs a closing fence at least as long", () => {
    const block = only("````spec\na\n```\nb\n````\nafter")
    expect(block.body).toBe("a\n```\nb")
    expect(block.closed).toBe(true)
  })

  test("a closing fence longer than the opening one closes", () => {
    expect(only("```spec\na\n`````").closed).toBe(true)
  })

  test("a closing fence shorter than the opening one does not close", () => {
    const block = only("~~~~~spec\na\n~~~\n")
    expect(block.closed).toBe(false)
    expect(block.body).toBe("a\n~~~\n")
  })

  test("a fence of the other character does not close and nests as body", () => {
    const backticks = only("```spec\n~~~\ninner\n~~~\n```")
    expect(backticks).toMatchObject({ closed: true, body: "~~~\ninner\n~~~" })
    const tildes = only("~~~spec\n```js\ninner\n```\n~~~")
    expect(tildes).toMatchObject({ closed: true, body: "```js\ninner\n```" })
  })

  test("a closing fence may not carry an info string", () => {
    const block = only("```spec\na\n``` spec\n")
    expect(block.closed).toBe(false)
    expect(block.body).toContain("``` spec")
  })

  test("a closing fence may have trailing spaces", () => {
    expect(only("```spec\na\n```   \n").closed).toBe(true)
  })

  test("four spaces of indentation are not a fence", () => {
    expect(scanFences("    ```spec\n    a\n    ```")).toEqual([])
    // Nor a closing fence: the block runs on.
    const block = only("```spec\na\n    ```\nb")
    expect(block).toMatchObject({ closed: false, body: "a\n    ```\nb" })
  })

  test.each([
    [1, " ```spec\n a\n  b\nc\n ```", "a\n b\nc"],
    [2, "  ```spec\n    a\n b\n  ```", "  a\nb"],
    [3, "   ```spec\n   a\n     b\n   ```", "a\n  b"],
  ])("an opening fence indented %i strips that much from body lines", (_indent, text, body) => {
    expect(only(text)).toMatchObject({ body, closed: true })
  })

  test("a backtick fence's info string cannot contain a backtick", () => {
    expect(scanFences("```spec `x`\nbody\n```")).toHaveLength(1)
    // The first line is not a fence, so the second opens one that never closes.
    expect(only("```spec `x`\nbody\n```")).toMatchObject({ language: "", body: "", closed: false })
  })

  test("a tilde fence's info string may contain backticks", () => {
    expect(only("~~~spec `x`\nbody\n~~~")).toMatchObject({ language: "spec", body: "body", closed: true })
  })

  test("CRLF line endings", () => {
    expect(only("text\r\n```spec\r\na\r\nb\r\n```\r\nafter")).toEqual({
      language: "spec",
      body: "a\nb",
      closed: true,
      ordinal: 0,
    })
  })

  test("an unclosed block runs to the end of the text", () => {
    expect(only('intro\n```canvas\n{"op":"add"')).toEqual({
      language: "canvas",
      body: '{"op":"add"',
      closed: false,
      ordinal: 0,
    })
    expect(only("```spec")).toEqual({ language: "spec", body: "", closed: false, ordinal: 0 })
  })

  test("an empty block", () => {
    expect(only("```spec\n```")).toEqual({ language: "spec", body: "", closed: true, ordinal: 0 })
  })

  test("ordinals count every block in order, including other languages and an unclosed last block", () => {
    const text = ["```ts", "a", "```", "~~~spec", "b", "~~~", "```", "c", "```", "```canvas", "d"].join("\n")
    expect(scanFences(text).map(({ language, ordinal, closed }) => ({ language, ordinal, closed }))).toEqual([
      { language: "ts", ordinal: 0, closed: true },
      { language: "spec", ordinal: 1, closed: true },
      { language: "", ordinal: 2, closed: true },
      { language: "canvas", ordinal: 3, closed: false },
    ])
  })

  test("an incremental scan of a growing text agrees with the full scan", () => {
    const text = 'Here:\n```spec\n{"op":"add","path":"/root","value":"a"}\n```\nAnd ~~~canvas\n~~~canvas\nx\n~~~\n'
    for (let end = 0; end <= text.length; end++) {
      const blocks = scanFences(text.slice(0, end))
      const full = scanFences(text)
      // Every closed block of a prefix is a block of the full text.
      for (const block of blocks.filter((item) => item.closed)) expect(full[block.ordinal]).toEqual(block)
    }
  })
})

describe("fenceLanguage", () => {
  test.each([
    ["spec", "spec"],
    ["Spec title=x", "spec"],
    ["  CANVAS  ", "canvas"],
    ["c++", "c++"],
    ["c#", "c#"],
    ["objective-c", "objective-c"],
    ["file.ts", "file.ts"],
    ["{lang}", "lang"],
    ["", ""],
    ["   ", ""],
  ])("%j -> %j", (info, language) => {
    expect(fenceLanguage(info)).toBe(language)
  })

  test("is applied to the info string of scanned blocks", () => {
    expect(only("```Spec title=x\na\n```").language).toBe("spec")
    expect(only("```c++\na\n```").language).toBe("c++")
  })
})
