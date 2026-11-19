// The SDK's host-side internals (the contexts `usePlugin`, `usePanel` and `useDrawer` read, and the marker `createKeyed`
// uses to follow `ctx.use` accessors). The app's host imports them from `@opencode/plugin/gui/host`, which the package
// does not export to plugins, so the fake host imports the same module instance by path.
export {
  DrawerContext,
  LifetimeContext,
  PanelContext,
  PluginContext,
  isLiveAccessor,
  liveAccessor,
} from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
