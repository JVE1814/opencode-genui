/**
 * What the app accepts as a plugin's `./gui-experimental` bundle, shared by scripts/check-bundle.ts and the playground's
 * bundle loader (playground/host/loader.ts), so neither passes a bundle the app would refuse.
 *
 * Copied from the app's packages/plugin/src/gui/host.ts (`BundleDefinition` and `evaluatePluginBundle`, @opencode/plugin
 * 2.3.x), which both of its processes run on a bundle's default export before using it. The installed SDK does not
 * export it (`./gui/host` is not in its export map).
 */
import { Cause, Exit, Predicate, Schema } from "effect"

const Setup = Schema.declare(Predicate.isFunction)

export const BundleDefinition = Schema.Struct({
  os: Schema.optional(Schema.Array(Schema.Literals(["macos", "windows", "linux"]))),
  stores: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        scope: Schema.Literals(["global", "session"]),
        schema: Schema.declare(Schema.isSchema),
      }),
    ),
  ),
  // Each icon is an SVG document as text.
  icons: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // A plugin's catalog ships every locale inline, each message a string.
  i18n: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))),
  setup: Schema.optional(Setup),
  main: Schema.optional(Setup),
})

const matches = Schema.is(BundleDefinition)

/**
 * Why the app's loader would refuse this default export of a bundle (in its own words: the decode names the field that
 * does not match), or undefined when it accepts it.
 */
export function bundleDefinitionProblem(plugin: unknown): string | undefined {
  if (!matches(plugin)) {
    const decoded = Schema.decodeUnknownExit(BundleDefinition)(plugin)
    return `the default export is not a \`Plugin.define\` the app supports: ${
      Exit.isFailure(decoded) ? Cause.pretty(decoded.cause) : "it does not match"
    }`
  }
  if (!plugin.setup && !plugin.main) return "the default export has neither a window `setup` nor a `main` setup"
  return undefined
}

/** A CommonJS bundle's default export, as the app reads it: `exports.default`, or `module.exports` itself. */
export const defaultExport = (exports: object): unknown =>
  Predicate.hasProperty(exports, "default") ? exports.default : exports
