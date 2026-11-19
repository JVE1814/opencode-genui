import { createEffect, createMemo, on, untrack, type Accessor } from "solid-js"
import { Panel, type PanelProps, type PanelTab, type Panel as PanelItem } from "@opencode/plugin/gui"
import type { App } from "./app.ts"
import { useItems } from "./registry.ts"

/** A tab of the side strip: which plugin's panel lists it, under which host key. */
export interface RegionEntry {
  readonly key: string
  readonly plugin: string
  readonly panel: PanelItem
  readonly tab: PanelTab
}

export interface Region {
  /** The routed session's listed tabs: pinned first, then in strip order. */
  readonly entries: Accessor<readonly RegionEntry[]>
  /** The tab the pane shows: the stored selection if listed, else the first `fallback` tab, else a pinned one. */
  readonly selected: Accessor<RegionEntry | undefined>
  /** This plugin's tab ids stored in the session's strip. */
  stored(plugin: string, sessionKey: string): readonly string[]
  props(entry: () => RegionEntry): PanelProps
}

export function createRegion(app: App): Region {
  const panels = useItems(app.contributions, Panel)

  const stored = (plugin: string, sessionKey: string) => {
    const prefix = `${plugin}:`
    return app.layout
      .strip(sessionKey)
      .keys.filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  }

  const entries = createMemo(
    () => {
      const session = app.sessions.current()
      const strip = app.layout.strip(session.key)
      const found: RegionEntry[] = []
      for (const item of panels()) {
        if (item.value.region !== "side") continue
        let tabs: readonly PanelTab[] = []
        try {
          tabs = item.value.list({
            get session() {
              return app.sessions.current()
            },
            screen: app.sessions.screen,
            open: stored(item.plugin, session.key),
          })
        } catch (error) {
          untrack(() => app.fail(item.plugin, `Panel ${item.value.id} list`, error))
        }
        if (!Array.isArray(tabs)) continue
        for (const tab of tabs) {
          if (!tab || typeof tab.id !== "string") continue
          const key = `${item.plugin}:${tab.id}`
          if (!tab.pinned && !strip.keys.includes(key)) continue
          if (found.some((entry) => entry.key === key)) continue
          found.push({ key, plugin: item.plugin, panel: item.value, tab })
        }
      }
      const rank = (entry: RegionEntry) => (entry.tab.pinned ? -1 : strip.keys.indexOf(entry.key))
      return found.toSorted((a, b) => rank(a) - rank(b))
    },
    [],
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every(
          (entry, index) =>
            entry.key === b[index]!.key && entry.tab === b[index]!.tab && entry.panel === b[index]!.panel,
        ),
    },
  )

  const selected = createMemo(() => {
    const list = entries()
    const active = app.layout.strip(app.sessions.current().key).active
    return (
      list.find((entry) => entry.key === active) ??
      list.find((entry) => entry.tab.fallback && !entry.tab.pinned) ??
      list.find((entry) => entry.tab.pinned)
    )
  })

  const props = (entry: () => RegionEntry): PanelProps => ({
    get tab() {
      return entry().tab
    },
    get session() {
      return app.sessions.current()
    },
    screen: app.sessions.screen,
  })

  // Panel.focus runs when a tab becomes selected; `restored` for the selection the region mounts with.
  let first = true
  createEffect(
    on(
      () => selected()?.key,
      (key) => {
        const entry = untrack(selected)
        const restored = first
        first = false
        if (!key || !entry?.panel.focus) return
        try {
          entry.panel.focus({ ...propsSnapshot(entry), restored })
        } catch (error) {
          app.fail(entry.plugin, `Panel ${entry.panel.id} focus`, error)
        }
      },
    ),
  )

  function propsSnapshot(entry: RegionEntry): PanelProps {
    return {
      tab: entry.tab,
      get session() {
        return app.sessions.current()
      },
      screen: app.sessions.screen,
    }
  }

  return { entries, selected, stored, props }
}
