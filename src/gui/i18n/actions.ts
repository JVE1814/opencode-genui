/** Copy for the action gate and confirm dialogs (src/gui/actions.ts, src/gui/outward.ts). Keys are unique across fragments. */
export default {
  // The payload of a confirm, last in its description: what is sent, opened or copied, in full.
  "confirm.detail": "{{label}}: {{text}}",
  "confirm.detailLong": "{{label}} ({{count}} characters): {{text}}",
  "confirm.label.message": "Message",
  "confirm.label.text": "Text",
  "confirm.label.address": "Address",
  "confirm.label.notification": "Notification",
  // Stand-ins in a confirm's payload for long runs of whitespace, so nothing hides off screen or between lines.
  "confirm.spaces": "[{{count}} spaces]",
  "confirm.blankLines": "[{{count}} blank lines]",
  // Stand-in for text hidden in invisible Unicode tag characters, decoded so the user sees it.
  "confirm.hiddenText": "[hidden text: {{text}}]",
  // A remote image's click-to-load on a surface whose loads ask first (src/gui/components/data.tsx).
  "confirm.loadImage": "Load an image from {{host}}?",
  "confirm.load": "Load",
  // The toast after copyText with a label: the label names what was copied ("Install command copied").
  "action.copiedNamed": "{{label}} copied",
} satisfies Record<string, string>
