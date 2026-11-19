import actions from "./actions.ts"
import chrome from "./chrome.ts"
import content from "./content.ts"
import data from "./data.ts"
import inputs from "./inputs.ts"
import layout from "./layout.ts"
import overlay from "./overlay.ts"

/** Every English message the GUI shows: genui's chrome plus each component group's copy. */
export const en: Readonly<Record<string, string>> = {
  ...chrome,
  ...layout,
  ...content,
  ...inputs,
  ...data,
  ...overlay,
  ...actions,
}

export default en
