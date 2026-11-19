import { createSignal, onCleanup } from "solid-js"
import { Schema } from "effect"
import {
  CodeBlock,
  Command,
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  Store,
  Style,
  usePanel,
  usePlugin,
  type PanelTab,
} from "@opencode/plugin/gui"

/**
 * A tiny plugin for testing the playground host itself (`?plugin=stub`, and built into the stub bundle for
 * `?bundle=stub`). It claims ```stubtest blocks, adds a panel, a menu item, a command, a settings page and a style.
 * Counters on `globalThis.__stub` let tests see mounts and unmounts.
 */

interface Counters {
  renders: number
  disposals: number
  panelRenders: number
  panelDisposals: number
  setups: number
}

const counters: Counters = ((globalThis as { __stub?: Counters }).__stub ??= {
  renders: 0,
  disposals: 0,
  panelRenders: 0,
  panelDisposals: 0,
  setups: 0,
})

const Prefs = Schema.Struct({ clicks: Schema.Number })

export default Plugin.define({
  stores: { prefs: Store.global(Prefs, { clicks: 0 }) },
  i18n: {
    en: {
      "panel.title": "Stub panel",
      "command.open": "Open the stub panel",
      "menu.open": "Stub panel",
      "settings.title": "Stub",
      "clicks.one": "{{count}} click",
      "clicks.other": "{{count}} clicks",
    },
  },
  setup(ctx) {
    counters.setups++
    ctx.add(Style, "[data-stub-block] { border: 1px dashed var(--v2-border-border-base, gray); padding: 8px; }")

    ctx.add(CodeBlock, {
      languages: ["stubtest"],
      render: (props) => {
        counters.renders++
        onCleanup(() => counters.disposals++)
        const plugin = usePlugin()
        return (
          <div data-stub-block data-language={props.language} data-plugin-id={plugin.id}>
            {props.code}
          </div>
        )
      },
    })

    // Blocks the host must fall back to code for: a render that throws, and one that declines.
    ctx.add(CodeBlock, {
      languages: ["stubthrow"],
      render: () => {
        throw new Error("stub render failed")
      },
    })
    ctx.add(CodeBlock, { languages: ["stubnull"], render: () => undefined })

    ctx.add(Command, {
      id: "confirm",
      title: "Ask the stub to confirm",
      run: async () => {
        const answer = await ctx.dialogs.confirm({ title: "Proceed?", description: "The stub asks.", confirm: "Yes" })
        ctx.toast.show({ title: answer ? "Confirmed" : "Cancelled", variant: answer ? "success" : "default" })
      },
    })

    const tab: PanelTab = {
      id: "main",
      get title() {
        return ctx.t("panel.title")
      },
      closable: "compact",
    }
    ctx.add(Panel, {
      id: "main",
      region: "side",
      list: (input) => (input.open.includes("main") ? [tab] : []),
      render: (props) => {
        counters.panelRenders++
        onCleanup(() => counters.panelDisposals++)
        const frame = usePanel()
        const [local, setLocal] = createSignal(0)
        return (
          <div data-stub-panel data-visible={frame.visible() ? "" : undefined}>
            <span data-stub-panel-title>{props.tab.title}</span>
            <span data-stub-panel-session>{props.session.id}</span>
            <ctx.ui.Button
              onClick={() => {
                setLocal(local() + 1)
                ctx.stores.prefs.update((draft) => {
                  draft.clicks++
                })
              }}
            >
              {ctx.plural("clicks", ctx.stores.prefs.value.clicks)}
            </ctx.ui.Button>
          </div>
        )
      },
    })

    const open = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:main`, session)
    }
    ctx.add(Command, {
      id: "open",
      get title() {
        return ctx.t("command.open")
      },
      bind: "mod+shift+u",
      run: open,
    })
    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current()
      return {
        menu: "session.panel",
        id: "open",
        title: ctx.t("menu.open"),
        icon: "layout-right",
        keybind: `${ctx.id}.open`,
        opened: !!session && ctx.layout.state(`${ctx.id}:main`, session) !== "closed",
        run: open,
      }
    })
    ctx.add(SettingsPage, {
      id: "stub",
      get title() {
        return ctx.t("settings.title")
      },
      render: () => (
        <ctx.ui.SettingsLayout title={ctx.t("settings.title")}>
          <ctx.ui.SettingsSection title="Stub">
            <ctx.ui.SettingsRow title="Clicks">{String(ctx.stores.prefs.value.clicks)}</ctx.ui.SettingsRow>
          </ctx.ui.SettingsSection>
        </ctx.ui.SettingsLayout>
      ),
    })
  },
})
