import { Plugin } from "@opencode/plugin/gui"
import { en } from "./gui/i18n/en.ts"
import { setup, stores } from "./gui/setup.tsx"

/**
 * The desktop GUI of opencode-genui (`./gui-experimental`): renders the agent's ```spec blocks inline and its ```canvas
 * blocks in side panel tabs, with the app's own look. Module scope stays cheap and free of DOM access: the app also
 * evaluates this bundle in its main process, where only the declarations are read.
 */
export default Plugin.define({ i18n: { en }, stores, setup })
