import { block, element, replace, root } from "./build.ts"
import type { Scenario } from "./types.ts"

// Every kind of mistake a model makes: a line that is not JSON, an op that does not exist, an unknown component, a
// child that is never defined, and props of the wrong type.
const broken = [
  "```spec",
  JSON.stringify({ id: "broken-status", title: "Service status" }),
  root("main"),
  element("main", "Card", { title: "Service status" }, ["summary", "chart", "missing-child", "load"]),
  element("summary", "Text", { text: "All systems nominal", variant: "loud" }),
  '{"op":"add","path":"/elements/chart","value":{"type":"Chart","props":{"labels":["a","b"],"series":[{"name":"x","values":[1,2]}]},"children":[]}',
  JSON.stringify({ op: "merge", path: "/elements/summary", value: {} }),
  element("load", "Carousel3D", { items: 3 }),
  element("meter", "Progress", { value: "lots", label: 42 }),
  "```",
].join("\n")

const orphan = block("canvas", { canvas: "ghost", title: "Ghost canvas" }, [replace("/state/count", 3)])

// A root that cannot render at all: the surface shows the error card instead of the UI.
const fatal = block("spec", { id: "release-board", title: "Release board" }, [
  root("board"),
  element("board", "KanbanBoard", { columns: ["Todo", "Doing", "Done"] }, ["todo"]),
  element("todo", "Text", { text: "Ship 1.2" }),
])

export const invalidScenario: Scenario = {
  name: "invalid",
  title: "Invalid blocks",
  description:
    "A ```spec block full of errors (bad JSON, unknown op and component, missing child, wrong props), one whose root cannot render, and a canvas patch without a base.",
  steps: [
    { user: "Show me the service status." },
    {
      assistant: `Here's the status:\n\n${broken}\n\nThe release board:\n\n${fatal}\n\nAnd an update to a canvas that doesn't exist yet:\n\n${orphan}`,
    },
  ],
  reply: () => [
    {
      assistant: `Thanks, I see the problems. Here's a corrected version:\n\n${block(
        "spec",
        { id: "broken-status", title: "Service status" },
        [
          root("main"),
          element("main", "Card", { title: "Service status" }, ["summary"]),
          element("summary", "Text", { text: "All systems nominal" }),
        ],
      )}`,
    },
  ],
}
