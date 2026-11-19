// Stand-in for "@opencode/plugin/gui" in the playground (vite.config.ts aliases the import here, and the bundle loader
// hands this module to a built bundle's `require`).
//
// The SDK's window runtime (Plugin.define, Store, Registry, the registry tokens, usePlugin, bindPlugin, usePanel,
// createKeyed, createLatest, createVisitState) only needs Solid, so it is re-exported as is: plugin code behaves exactly
// as in the app. What the app adds is the host behind it; that is playground/host. The package's export map hides the
// runtime files, so they are imported by path.
export * from "../../node_modules/@opencode/plugin/dist/gui/index.js"
