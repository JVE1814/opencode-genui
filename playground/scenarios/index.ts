import { canvasScenario } from "./canvas.ts"
import { formScenario } from "./form.ts"
import { galleryScenario } from "./gallery.ts"
import { historyScenario } from "./history.ts"
import { invalidScenario } from "./invalid.ts"
import type { Scenario } from "./types.ts"
import { untrustedScenario } from "./untrusted.ts"

export type { Scenario, Step } from "./types.ts"

const emptyScenario: Scenario = {
  name: "empty",
  title: "Empty session",
  description: "No messages; type in the composer or use the test hooks.",
  steps: [],
}

export const scenarios: readonly Scenario[] = [
  emptyScenario,
  formScenario,
  canvasScenario,
  invalidScenario,
  galleryScenario,
  historyScenario,
  untrustedScenario,
]

export function findScenario(name: string | null | undefined): Scenario | undefined {
  return scenarios.find((scenario) => scenario.name === name)
}
