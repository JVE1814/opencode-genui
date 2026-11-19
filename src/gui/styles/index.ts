import base from "./base.css?inline"
import chart from "./chart.css?inline"
import chrome from "./chrome.css?inline"
import content from "./content.css?inline"
import data from "./data.css?inline"
import inputs from "./inputs.css?inline"
import layout from "./layout.css?inline"
import overlay from "./overlay.css?inline"

/** Every genui stylesheet, base first, in one string for `ctx.add(Style, css)`. */
export const css: string = [base, layout, content, inputs, data, chart, overlay, chrome].join("\n")
