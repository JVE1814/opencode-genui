import { describe, expect, test } from "bun:test"
import { isRemoteImage, MAX_DATA_IMAGE, safeUrl, urlHost } from "../../src/protocol/url.ts"

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("safeUrl for links", () => {
  test.each([
    ["https://example.com", "https://example.com/"],
    ["http://example.com/a?b=c#d", "http://example.com/a?b=c#d"],
    ["  https://example.com/path  ", "https://example.com/path"],
    ["HTTPS://EXAMPLE.com", "https://example.com/"],
    ["https://example.com:8080/x", "https://example.com:8080/x"],
    ["mailto:someone@example.com", "mailto:someone@example.com"],
    ["mailto:someone@example.com?subject=Hi", "mailto:someone@example.com?subject=Hi"],
  ])("allows %j", (url, expected) => {
    expect(safeUrl(url, "link")).toBe(expected)
  })

  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "javascript\u0000:alert(1)",
    "https://example.com/\u0007",
    "https://example.com/\u007f",
    "data:text/html,<script>alert(1)</script>",
    PNG,
    "file:///etc/passwd",
    "ftp://example.com/file",
    "vbscript:msgbox(1)",
    "blob:https://example.com/uuid",
    "/relative/path",
    "./relative",
    "relative.html",
    "//example.com/protocol-relative",
    "#anchor",
    "http://",
    "https:",
    "",
    "   ",
  ])("refuses %j", (url) => {
    expect(safeUrl(url, "link")).toBeUndefined()
  })

  test.each([[undefined], [null], [5], [{}], [["https://example.com"]], [{ href: "https://example.com" }]])(
    "refuses the non-string %j",
    (url) => {
      expect(safeUrl(url, "link")).toBeUndefined()
    },
  )

  test("refuses an address without a scheme before parsing it, without the exception the parser would throw", () => {
    // Each caught exception cost microseconds (more with DevTools open), and a Markdown text can hold 100,000 relative
    // links: 41 s of the render charge with an inspector attached [review9#R8C-1].
    const Parser = globalThis.URL
    let parsed = 0
    globalThis.URL = class extends Parser {
      constructor(url: string | URL, base?: string | URL) {
        parsed++
        super(url, base)
      }
    } as typeof URL
    try {
      for (const url of ["b", "/relative/path", "./relative", "//example.com/x", "#anchor", "1http://x", "-a:b", "é:x"])
        expect(safeUrl(url, "link")).toBeUndefined()
      expect(safeUrl("b", "image")).toBeUndefined()
      expect(parsed).toBe(0)
      expect(safeUrl("HTTPS://example.com", "link")).toBe("https://example.com/")
      expect(safeUrl("a+b.c-d:x", "link")).toBeUndefined()
      expect(parsed).toBe(2)
    } finally {
      globalThis.URL = Parser
    }
  })
})

describe("safeUrl for images", () => {
  test("allows http(s)", () => {
    expect(safeUrl("https://example.com/a.png", "image")).toBe("https://example.com/a.png")
    expect(safeUrl("http://example.com/a.png", "image")).toBe("http://example.com/a.png")
  })

  test.each(["png", "jpeg", "jpg", "gif", "webp", "avif", "PNG"])("allows base64 data:image/%s", (type) => {
    const url = `data:image/${type};base64,AAAA`
    expect(safeUrl(url, "image")).toBe(url)
  })

  // An SVG image is drawn on the window's main thread, and a data: image shows without a click: 1.9 KB of nested <use>
  // elements froze the window for 43 s [review8#R6S2-1]. Base64 SVG used to be allowed (and this list held svg+xml).
  test.each(["svg+xml", "SVG+XML", "svg"])("refuses base64 data:image/%s", (type) => {
    let defs = '<rect id="l0" width="1" height="1"/>'
    for (let level = 1; level <= 18; level++)
      defs += `<g id="l${level}"><use href="#l${level - 1}"/><use href="#l${level - 1}" x="1"/></g>`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs><use href="#l18"/></svg>`
    expect(safeUrl(`data:image/${type};base64,${Buffer.from(svg).toString("base64")}`, "image")).toBeUndefined()
    expect(safeUrl(`data:image/${type};base64,AAAA`, "image")).toBeUndefined()
  })

  test("allows a real base64 png", () => {
    expect(safeUrl(PNG, "image")).toBe(PNG)
  })

  test("trims around a data URL", () => {
    expect(safeUrl(`  ${PNG} `, "image")).toBe(PNG)
  })

  test("allows data URLs up to the size limit and refuses larger ones", () => {
    const prefix = "data:image/png;base64,"
    const fits = prefix + "A".repeat(MAX_DATA_IMAGE - prefix.length)
    expect(safeUrl(fits, "image")).toBe(fits)
    expect(safeUrl(`${fits}A`, "image")).toBeUndefined()
  })

  test.each([
    "data:image/png,rawbytes",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "data:image/svg+xml;utf8,<svg/>",
    "data:image/png;base64,not*base64!",
    "data:image/png;base64,",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/x-icon;base64,AAAA",
    "data:;base64,AAAA",
    "data:image/png;base64,AAAA\nAAAA",
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "file:///tmp/a.png",
    "/a.png",
    "a.png",
  ])("refuses %j", (url) => {
    expect(safeUrl(url, "image")).toBeUndefined()
  })
})

describe("isRemoteImage", () => {
  test.each([
    ["https://example.com/a.png", true],
    ["http://example.com/a.png", true],
    ["HTTPS://example.com/a.png", true],
    [PNG, false],
  ])("%j -> %p", (url, expected) => {
    expect(isRemoteImage(url)).toBe(expected)
  })
})

describe("urlHost", () => {
  test.each([
    ["https://example.com/path", "example.com"],
    ["https://sub.example.com:8443/x", "sub.example.com:8443"],
    ["http://EXAMPLE.com", "example.com"],
    ["mailto:someone@example.com", "someone@example.com"],
    ["not a url", "not a url"],
  ])("%j -> %j", (url, host) => {
    expect(urlHost(url)).toBe(host)
  })
})
