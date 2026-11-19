import { block, element, root, state } from "./build.ts"
import type { Scenario } from "./types.ts"

const form = block("spec", { id: "deploy-form", title: "Deploy settings" }, [
  root("card"),
  element("card", "Card", { title: "Deploy", description: "acme-api · main @ 4f2c9e1" }, ["fields", "actions"]),
  element("fields", "Stack", { gap: "md" }, ["service", "env", "replicas", "migrate", "notify"]),
  element("service", "Input", {
    label: "Service",
    placeholder: "e.g. api",
    value: { $bindState: "/form/service" },
    checks: [{ type: "required", message: "Name the service to deploy" }],
  }),
  element("env", "Select", {
    label: "Environment",
    options: [
      { label: "Staging", value: "staging" },
      { label: "Production", value: "production" },
    ],
    value: { $bindState: "/form/env" },
  }),
  element("replicas", "Slider", {
    label: "Replicas",
    min: 1,
    max: 10,
    step: 1,
    value: { $bindState: "/form/replicas" },
  }),
  element("migrate", "Switch", {
    label: "Run database migrations",
    description: "Applies 2 pending migrations before traffic switches.",
    checked: { $bindState: "/form/migrate" },
  }),
  element("notify", "Checkbox", { label: "Post to #deploys", checked: { $bindState: "/form/notify" } }),
  element("actions", "Stack", { direction: "horizontal", gap: "sm", justify: "end" }, ["adjust", "deploy"]),
  element("adjust", "Button", { label: "Edit in message", variant: "ghost" }, [], {
    on: { press: { action: "insertPrompt", params: { text: "Before deploying, change " } } },
  }),
  element("deploy", "Button", { label: "Deploy", variant: "primary", icon: "arrow-up" }, [], {
    on: {
      press: { action: "sendPrompt", params: { text: "Deploy with these settings", data: { $state: "/form" } } },
    },
  }),
  state("/form", { service: "api", env: "staging", replicas: 3, migrate: true, notify: false }),
])

export const formScenario: Scenario = {
  name: "form",
  title: "Inline form",
  description: "An inline ```spec form whose Deploy button sends the values back with sendPrompt.",
  steps: [
    { user: "I need to deploy the API. Can you give me a form for the settings?" },
    {
      assistant: `Sure. Pick the settings and press **Deploy** when you're ready:\n\n${form}\n\nI'll start the rollout as soon as you submit.`,
    },
  ],
  reply: (prompt) =>
    prompt.startsWith("Deploy with these settings")
      ? [
          {
            assistant:
              "Got it, starting the rollout with those settings. I'll post progress here and let you know when traffic has switched.",
          },
        ]
      : [{ assistant: "Noted. Tell me when you want to deploy." }],
}
