// Copy of genui's own chrome: confirmations, the surface frame, the canvas panel, the menu item, commands and the
// settings page. Component copy lives in the per-group files next to this one; en.ts merges them all.
export default {
  // Confirmations of actions a surface runs (src/gui/outward.ts, src/gui/actions.ts)
  "confirm.untrusted": "This UI came from tool output or a file, not from the agent's reply.",
  "confirm.openLink": "Open {{host}}?",
  "confirm.open": "Open",
  "confirm.send": "Send this message to the agent?",
  "confirm.sendLabel": "Send",
  "confirm.insert": "Put this text in your message?",
  "confirm.insertLabel": "Insert",
  "confirm.copy": "Copy this text to the clipboard?",
  "confirm.copyLabel": "Copy",
  "confirm.toast": "Show this notification?",
  "confirm.openCanvas": "Open the canvas {{canvas}}?",
  "confirm.continue": "Continue",
  "confirm.fix": "Send these problems to the agent?",

  // Results of actions
  "action.copied": "Copied to clipboard",
  "action.copyFailed": "Couldn't copy to clipboard",
  "action.sendFailed": "Couldn't send the message",
  "action.noSession": "This UI isn't part of an open session",
  "action.linkBlocked": "This link can't be opened: only web and email links are allowed",
  "action.canvasMissing": "There is no canvas {{canvas}} in this conversation",

  // The surface frame (src/gui/surface.tsx, src/gui/fallback.tsx)
  "surface.error.title": "This UI couldn't be shown",
  "surface.error.crashed": "Something went wrong while showing this UI.",
  "surface.fix": "Ask agent to fix",
  "surface.issues.one": "{{count}} issue",
  "surface.issues.other": "{{count}} issues",
  "surface.untrusted": "From tool output · actions ask before running",
  "surface.untrustedQuiet": "From tool output, not the agent's reply",
  "surface.unknown": "Unknown component {{type}}",
  "surface.line": "Line {{line}}",

  // The chip a canvas block shows in the reply (src/gui/inline.tsx)
  "chip.canvas": "Canvas",
  "chip.update": "Canvas update",
  "chip.open": "Open",
  "chip.updating": "Updating…",
  "chip.closed": "Closed",

  // The canvas panel (src/gui/canvas.tsx)
  "canvas.updating": "Updating…",
  "canvas.live": "Updating",
  "canvas.menu": "Canvas actions",
  "canvas.copySpec": "Copy spec JSON",
  "canvas.copied": "Spec copied to clipboard",
  "canvas.reset": "Reset input",
  "canvas.fix": "Ask agent to fix",
  "canvas.close": "Close",
  "canvas.loading": "Loading canvas…",
  "canvas.empty": "Nothing here yet",
  "canvas.missingBase.title": "Part of this canvas is missing",
  "canvas.missingBase.body":
    "The agent changed this canvas, but its earlier version is in older messages than the app has loaded.",
  "canvas.rescan": "Rescan session",
  "canvas.rescanning": "Rescanning…",
  "canvas.resend": "Ask agent to resend",
  "canvas.removed.title": "The agent closed this canvas",
  "canvas.removed.body": "It is no longer part of this conversation.",
  "canvas.unknown.title": "This canvas is no longer in this conversation",
  "canvas.unknown.body": "It may be in older messages. Rescan the session to look for it.",

  // The "+" menu item and commands (src/gui/setup.tsx)
  "menu.canvas": "Canvas",
  "menu.canvas.count.one": "{{count}} canvas",
  "menu.canvas.count.other": "{{count}} canvases",
  "command.group": "Generated UI",
  "command.open": "Open canvas…",
  "command.rescan": "Rescan session for canvases",
  "command.reset": "Reset generated UI state in this session",
  "pick.title": "Open a canvas",
  "pick.placeholder": "Search canvases",
  "none.title": "No canvases in this session yet",
  "none.description": "Ask the agent to put something in a canvas, such as a dashboard it keeps up to date.",
  "noSession.title": "Open a session first",
  "rescan.done": "Session rescanned",
  "rescan.found.one": "Found {{count}} canvas",
  "rescan.found.other": "Found {{count}} canvases",
  "reset.title": "Reset generated UI state?",
  "reset.description":
    "Everything you typed or picked in this session's generated UI goes back to what the agent wrote.",
  "reset.confirm": "Reset",
  "reset.done": "Generated UI state reset",

  // Telling the agent about genui (src/gui/setup.tsx)
  "activation.failed.title": "Couldn't tell the agent about generated UI",
  "activation.failed.description":
    "The agent may not offer UI in this session. It can still find the genui skill, and you can ask for UI directly.",

  // Settings › genui (src/gui/settings.tsx)
  "settings.title": "genui",
  "settings.description": "Interactive UI the agent shows in your sessions and in canvas tabs.",
  "settings.section.behavior": "Behavior",
  "settings.autoOpen.title": "Open new canvases",
  "settings.autoOpen.description": "What happens when the agent starts a canvas while it replies.",
  "settings.autoOpen.select": "Open and show",
  "settings.autoOpen.append": "Add the tab quietly",
  "settings.autoOpen.off": "Don't open",
  "settings.confirm.title": "Ask before actions",
  "settings.confirm.description":
    "Before generated UI sends a message, fills your message box, opens a link or copies text.",
  "settings.confirm.always": "Always",
  "settings.confirm.untrusted": "Only for tool output",
  "settings.confirm.never": "Never",
  "settings.images.title": "Load remote images",
  "settings.images.description": "Show images from web addresses without a click.",
  "settings.section.agent": "Agent",
  "settings.instructions.title": "Instructions",
  "settings.instructions.description":
    'How the agent learns it can show UI. Change it with "instructions" in the plugin\'s options in opencode.json.',
  "settings.instructions.session": "Per session, in the app",
  "settings.instructions.always": "Every request",
  "settings.instructions.off": "Off",
  "settings.section.data": "Stored state",
  "settings.clear.title": "Clear stored UI state",
  "settings.clear.description":
    "Forget what you typed or picked in generated UI in open sessions. Canvases stay as the agent wrote them.",
  "settings.clear.action": "Clear",
  "settings.clear.done": "Stored UI state cleared",
} satisfies Record<string, string>
