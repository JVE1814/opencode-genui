import { block, element, replace, root, state, add } from "./build.ts"
import type { Scenario } from "./types.ts"

const dashboard = block("canvas", { canvas: "deploy", title: "Deploy dashboard" }, [
  root("main"),
  element("main", "Stack", { gap: "md" }, ["header", "stats", "rollout", "steps"]),
  element("header", "Stack", { direction: "horizontal", gap: "sm", align: "center", justify: "between" }, [
    "title",
    "status",
  ]),
  element("title", "Heading", { text: "acme-api → production", level: "h3" }),
  element("status", "Badge", { text: { $state: "/status" }, variant: "info" }),
  element("stats", "Grid", { columns: 3, gap: "sm" }, ["latency", "errors", "pods"]),
  element("latency", "Stat", { label: "p95 latency", value: { $state: "/stats/latency" }, trend: "neutral" }),
  element("errors", "Stat", { label: "Error rate", value: { $state: "/stats/errors" }, trend: "down" }),
  element("pods", "Stat", { label: "Ready pods", value: { $state: "/stats/pods" } }),
  element("rollout", "Progress", { label: "Rollout", value: { $state: "/progress" }, showValue: true }),
  element("steps", "Table", { columns: ["Step", "Status"], rows: { $state: "/steps" } }),
  state("/status", "building"),
  state("/stats", { latency: "182 ms", errors: "0.02%", pods: "0 / 3" }),
  state("/progress", 15),
  state("/steps", []),
  state("/steps/0", ["Build image", "running"]),
  state("/steps/1", ["Run migrations", "pending"]),
  state("/steps/2", ["Switch traffic", "pending"]),
  state("/steps/3", ["Smoke tests", "pending"]),
])

const progress = block("canvas", { canvas: "deploy" }, [
  replace("/state/status", "switching traffic"),
  replace("/state/progress", 70),
  replace("/state/steps/0/1", "done"),
  replace("/state/steps/1/1", "done"),
  replace("/state/steps/2/1", "running"),
  replace("/state/stats/pods", "2 / 3"),
])

const done = block("canvas", { canvas: "deploy" }, [
  replace("/state/status", "live"),
  replace("/elements/status/props/variant", "success"),
  replace("/state/progress", 100),
  replace("/state/steps/2/1", "done"),
  replace("/state/steps/3/1", "done"),
  replace("/state/stats/pods", "3 / 3"),
  add("/elements/main/children/-", "result"),
  element("result", "Alert", {
    type: "success",
    title: "Deployed",
    message: "acme-api 4f2c9e1 is live in production.",
  }),
])

export const canvasScenario: Scenario = {
  name: "canvas",
  title: "Streaming canvas",
  description: "A ```canvas dashboard that renders while it streams, then later blocks that patch it.",
  steps: [
    { user: "Deploy the API to production and keep a dashboard open while it runs." },
    {
      assistant: `Starting the deploy. I'll keep this dashboard up to date:\n\n${dashboard}\n\nBuilding the image now.`,
    },
    { pause: 1500 },
    { assistant: `The image is built and the migrations ran. Switching traffic:\n\n${progress}` },
    { pause: 1500 },
    { assistant: `All done, the smoke tests passed.\n\n${done}` },
  ],
}
