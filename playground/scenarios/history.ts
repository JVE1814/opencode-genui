import { block, element, replace, root, state } from "./build.ts"
import type { Scenario, Step } from "./types.ts"

// A canvas created early in a long session, then enough chatter that its base block falls outside the ~20 messages the
// client's store holds, then a patch: the plugin must find the base (snapshot or backfill) to apply it.
const checklist = block("canvas", { canvas: "migration", title: "Migration checklist" }, [
  root("list"),
  element("list", "Card", { title: "Postgres 16 migration" }, ["items"]),
  element("items", "Table", { columns: ["Task", "Done"], rows: { $state: "/tasks" } }),
  state("/tasks", [
    ["Snapshot the database", "no"],
    ["Upgrade staging", "no"],
    ["Upgrade production", "no"],
  ]),
])

const chatter: Step[] = Array.from({ length: 12 }, (_, index) => [
  { user: `Status check ${index + 1}?` },
  { assistant: `Still working on step ${index + 1}. Nothing to report yet.` },
]).flat()

export const historyScenario: Scenario = {
  name: "history",
  title: "Long history",
  description:
    "A stored session whose canvas base block is older than the ~20 messages the client's store holds, then a live patch.",
  history: [
    { user: "Keep a checklist for the Postgres migration in a canvas." },
    { assistant: `Here's the checklist:\n\n${checklist}` },
    ...chatter,
  ],
  steps: [
    { user: "Is staging done?" },
    {
      assistant: `Staging is upgraded.\n\n${block("canvas", { canvas: "migration" }, [
        replace("/state/tasks/0/1", "yes"),
        replace("/state/tasks/1/1", "yes"),
      ])}`,
    },
  ],
}
