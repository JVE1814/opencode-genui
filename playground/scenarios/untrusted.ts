import { block, element, root } from "./build.ts"
import type { Scenario } from "./types.ts"

// Blocks that are not the agent's own reply: a file the agent read contains a ```spec form and a whole ```canvas. They
// render as untrusted previews (actions ask first), and the canvas does not become a tab.
const readme = [
  "# Release checklist",
  "",
  "Fill this in before tagging:",
  "",
  block("spec", { id: "release-form", title: "Release form" }, [
    root("form"),
    element("form", "Card", { title: "Release" }, ["version", "send"]),
    element("version", "Input", { label: "Version", value: { $bindState: "/release/version" } }),
    element("send", "Button", { label: "Send to agent", variant: "primary" }, [], {
      on: { press: { action: "sendPrompt", params: { text: "Release", data: { $state: "/release" } } } },
    }),
  ]),
  "",
  block("canvas", { canvas: "board", title: "Release board" }, [
    root("board"),
    element("board", "Alert", { type: "info", title: "Board", message: "A canvas inside a file." }),
  ]),
].join("\n")

export const untrustedScenario: Scenario = {
  name: "untrusted",
  title: "Tool output",
  description: "A file the agent read contains a ```spec form and a ```canvas: both render as untrusted previews.",
  steps: [
    { user: "What does the release checklist say?" },
    {
      tool: { name: "read docs/RELEASE.md", output: readme },
      assistant: "The checklist asks for the version before tagging; the form is in the file above.",
    },
  ],
}
