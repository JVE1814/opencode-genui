// Copy added by the content components (src/gui/components/content.tsx).
export default {
  // Link text for a Markdown image without alt text (Markdown images show as links, see components/markdown.ts).
  "c.markdown.image": "Image",
  // Under a Markdown text too long to show whole (see shownLength in components/markdown.ts).
  "c.markdown.cut": "Showing the first {{shown}} of {{total}} characters",

  "c.code.copy": "Copy code",
  "c.code.copied": "Copied to clipboard",
  "c.code.copyFailed": "Couldn't copy to clipboard",

  "c.alert.info": "Info",
  "c.alert.success": "Success",
  "c.alert.warning": "Warning",
  "c.alert.error": "Error",

  "c.keybind.label": "Keyboard shortcut: {{keys}}",
  "c.keybind.command": "Command",
  "c.keybind.control": "Control",
  "c.keybind.option": "Option",
  "c.keybind.ctrl": "Ctrl",
  "c.keybind.alt": "Alt",
  "c.keybind.shift": "Shift",
  "c.keybind.meta": "Meta",
  "c.keybind.enter": "Enter",
  "c.keybind.esc": "Esc",
  "c.keybind.tab": "Tab",
  "c.keybind.space": "Space",
  "c.keybind.backspace": "Backspace",
  "c.keybind.delete": "Delete",

  // Under a component that draws only the first items of a long list (see ITEM_LISTS in src/gui/costs.ts), by the
  // list's noun there.
  "c.cut.keys": "Showing {{shown}} of {{total}} keys",
  "c.cut.tabs": "Showing {{shown}} of {{total}} tabs",
  "c.cut.options": "Showing {{shown}} of {{total}} options",
  "c.cut.items": "Showing {{shown}} of {{total}} items",
  "c.cut.buttons": "Showing {{shown}} of {{total}} buttons",
  "c.cut.sections": "Showing {{shown}} of {{total}} sections",
  "c.cut.cards": "Showing {{shown}} of {{total}} cards",
} satisfies Record<string, string>
