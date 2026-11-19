import { resolveThemeVariant, themeToCss } from "@opencode/ui/theme/resolve"
import { resolveThemeVariantV2, themeV2ToCss } from "@opencode/ui/theme/v2/resolve"
import type { DesktopTheme } from "@opencode/ui/theme/types"
import defaultTheme from "../../node_modules/@opencode/ui/src/theme/themes/oc-2.json"

/**
 * Applies the app's default theme the way the app does (packages/ui/src/theme/context.tsx `applyThemeCss`): the theme's
 * generated tokens on `:root`, `color-scheme`, and `data-color-scheme` on `<html>`, which @opencode/ui's token
 * stylesheet keys its explicit light/dark values on.
 */
export function applyTheme(mode: "light" | "dark") {
  const isDark = mode === "dark"
  const theme = defaultTheme as unknown as DesktopTheme
  const variant = isDark ? theme.dark : theme.light
  const css = themeToCss(resolveThemeVariant(variant, isDark))
  const v2 = themeV2ToCss(resolveThemeVariantV2(variant, isDark))
  let element = document.getElementById("oc-theme") as HTMLStyleElement | null
  if (!element) {
    element = document.createElement("style")
    element.id = "oc-theme"
    document.head.appendChild(element)
  }
  element.textContent = `:root {\n  color-scheme: ${mode};\n  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};\n  ${css}\n  ${v2}\n}`
  document.documentElement.dataset.theme = theme.id
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"
}
