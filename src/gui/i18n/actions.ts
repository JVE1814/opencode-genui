/** Copy for the action gate and confirm dialogs (src/gui/actions.ts, src/gui/outward.ts). Keys are unique across fragments. */
export default {
  // Shown on untrusted surfaces after genui's note and the payload: the spec's own confirm text, quoted.
  "confirm.specSays": "The UI says: {{text}}",
  // Stand-ins in a confirm's payload for long runs of whitespace, so nothing hides off screen or between lines.
  "confirm.spaces": "[{{count}} spaces]",
  "confirm.blankLines": "[{{count}} blank lines]",
  // Stand-in for text hidden in invisible Unicode tag characters, decoded so the user sees it.
  "confirm.hiddenText": "[hidden text: {{text}}]",
} satisfies Record<string, string>
