import { createMemo, For, Show, type Accessor } from "solid-js"
import { Command, MenuItem, type PanelFrame, type SessionPanelMenuItem } from "@opencode/plugin/gui"
import { PanelContext } from "../fake-sdk/internal.ts"
import type { App } from "./app.ts"
import { keysOf } from "./context.ts"
import { Contribution } from "./contribution.tsx"
import type { Region, RegionEntry } from "./region.ts"
import { useItems } from "./registry.ts"
import { Icon, MenuButton, ui } from "./ui.tsx"

/**
 * The session's side region: the "+" menu, the strip of plugin tabs (from each `Panel.list`), and the selected tab's
 * content. As in the app (packages/app/src/runtime/plugin/panels.tsx `RegionContent`), tabs that share a `group` share
 * one render that stays mounted while any member is listed and receives the selected member as `props.tab`; other tabs
 * mount while selected. Content unmounts while the region is closed.
 */
export function SideRegion(props: { readonly app: App; readonly region: Region }) {
  const app = props.app
  const session = () => app.sessions.current()
  const strip = () => app.layout.strip(session().key)
  const menuItems = useItems(app.contributions, MenuItem)
  const commands = useItems(app.contributions, Command)
  const launchers = createMemo(() =>
    menuItems()
      .map((item) => ({ plugin: item.plugin, value: item.value }))
      .filter((item): item is { plugin: string; value: SessionPanelMenuItem } => item.value.menu === "session.panel")
      .toSorted((a, b) => (a.value.order ?? 0) - (b.value.order ?? 0)),
  )
  const primary = () => launchers().find((item) => item.value.primary)
  const shortcut = (command: string | undefined) => {
    const bind = command
      ? commands().find((item) => `${item.plugin}.${item.value.id}` === command)?.value.bind
      : undefined
    return bind ? keysOf(bind) : undefined
  }

  const run = (item: { plugin: string; value: SessionPanelMenuItem }) => {
    try {
      item.value.run()
    } catch (error) {
      app.fail(item.plugin, `MenuItem ${item.value.id}`, error)
    }
  }

  return (
    <Show when={strip().open}>
      <aside data-playground-side aria-label="Side panel">
        <div data-playground-side-strip>
          <Show
            when={primary()}
            fallback={
              <MenuButton label="New tab" icon="plus" placement="bottom-start">
                <For each={launchers()} fallback={<div data-playground-menu-empty>No launchers</div>}>
                  {(item) => (
                    <ui.MenuItem
                      label={item.value.title}
                      icon={item.value.icon}
                      keys={shortcut(item.value.keybind)}
                      onSelect={() => run(item)}
                    />
                  )}
                </For>
              </MenuButton>
            }
          >
            {(item) => <ui.IconButton icon="plus" label={item().value.title} onClick={() => run(item())} />}
          </Show>
          <div role="tablist" data-playground-tabs>
            <For each={props.region.entries().filter((entry) => !entry.tab.hidden)}>
              {(entry) => <Trigger app={app} region={props.region} entry={entry} />}
            </For>
          </div>
          <ui.IconButton
            icon="sidebar"
            label="Close side panel"
            onClick={() => app.layout.setOpen(session().key, false)}
          />
        </div>
        <div data-playground-side-content>
          <Content app={app} region={props.region} />
          <Show when={!props.region.selected()}>
            <div data-playground-new-tab>
              <h3>New tab</h3>
              <For
                each={launchers().filter((item) => !item.value.primary && !item.value.opened)}
                fallback={<p class="playground-muted">Nothing to open.</p>}
              >
                {(item) => (
                  <button type="button" data-playground-launcher={item.value.id} onClick={() => run(item)}>
                    <Show when={item.value.icon}>{(icon) => <Icon name={icon()} />}</Show>
                    <span>{item.value.title}</span>
                    <Show when={item.value.description}>
                      <span class="playground-muted">{item.value.description}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}

function Trigger(props: { readonly app: App; readonly region: Region; readonly entry: RegionEntry }) {
  const app = props.app
  const session = () => app.sessions.current()
  const strip = () => app.layout.strip(session().key)
  const active = () => props.region.selected()?.key === props.entry.key
  const preview = () => strip().preview === props.entry.key
  const closable = () => !props.entry.tab.pinned && props.entry.tab.closable !== false
  const label = props.entry.tab.label
  return (
    <div
      role="tab"
      tabIndex={active() ? 0 : -1}
      aria-selected={active()}
      aria-label={props.entry.tab.title}
      data-playground-tab={props.entry.key}
      data-active={active() ? "" : undefined}
      data-preview={preview() ? "" : undefined}
      data-missing={props.entry.tab.missing ? "" : undefined}
      onClick={() => app.layout.select(session().key, props.entry.key)}
      onDblClick={() => app.layout.keep(session().key, props.entry.key)}
    >
      <span data-playground-tab-label>
        <Show when={label} fallback={props.entry.tab.title}>
          {(render) => (
            <Contribution app={app} plugin={props.entry.plugin} where={`tab ${props.entry.key} label`}>
              {() =>
                render()({
                  get active() {
                    return active()
                  },
                  get preview() {
                    return preview()
                  },
                  get session() {
                    return session()
                  },
                })
              }
            </Contribution>
          )}
        </Show>
      </span>
      <Show when={closable()}>
        <button
          type="button"
          data-playground-tab-close
          aria-label={`Close ${props.entry.tab.title}`}
          onClick={(event) => {
            event.stopPropagation()
            app.contexts()[props.entry.plugin]?.layout.close(props.entry.key, session())
          }}
        >
          <Icon name="close" size="small" />
        </button>
      </Show>
    </div>
  )
}

const groupKey = (entry: RegionEntry) => `${entry.plugin}/${entry.tab.group ?? entry.key}`

function Content(props: { readonly app: App; readonly region: Region }) {
  const app = props.app
  const groups = createMemo(() =>
    Array.from(new Set(props.region.entries().flatMap((entry) => (entry.tab.group ? [groupKey(entry)] : [])))),
  )
  const single = createMemo(() => {
    const entry = props.region.selected()
    return entry && !entry.tab.group ? entry.key : undefined
  })

  const frame = (plugin: string, visible: Accessor<boolean>): PanelFrame => ({
    visible,
    present: visible,
    placement: () => "side",
    reserve: () => true,
    animate: () => true,
    sidebar: {
      opened: () => true,
      width: () => 240,
      transition: () => true,
      resize: () => {},
      toggle: () => {},
    },
    open: () => props.region.stored(plugin, app.sessions.current().key),
  })

  return (
    <>
      <For each={groups()}>
        {(group) => {
          const active = () => {
            const entry = props.region.selected()
            return !!entry && groupKey(entry) === group
          }
          // The selected member, else the last selected one, keeps rendering while the group is hidden.
          const member = createMemo<RegionEntry | undefined>((previous) => {
            const members = props.region.entries().filter((entry) => groupKey(entry) === group)
            const selected = props.region.selected()
            if (selected && groupKey(selected) === group) return selected
            return members.find((entry) => entry.key === previous?.key) ?? members[0]
          })
          return (
            <Show when={member()?.plugin} keyed>
              {(plugin) => (
                <div
                  role="tabpanel"
                  data-slot="tabs-content"
                  data-playground-panel={group}
                  hidden={!active()}
                  inert={!active() || undefined}
                >
                  <PanelContext.Provider value={frame(plugin, active)}>
                    <Contribution app={app} plugin={plugin} where={`Panel ${member()!.panel.id} render`}>
                      {() => member()!.panel.render(props.region.props(() => member()!))}
                    </Contribution>
                  </PanelContext.Provider>
                </div>
              )}
            </Show>
          )
        }}
      </For>
      <Show when={single()} keyed>
        {(key) => {
          const entry = createMemo(() => props.region.entries().find((item) => item.key === key))
          return (
            <Show when={entry()?.plugin} keyed>
              {(plugin) => (
                <div role="tabpanel" data-slot="tabs-content" data-playground-panel={key}>
                  <PanelContext.Provider value={frame(plugin, () => true)}>
                    <Contribution app={app} plugin={plugin} where={`Panel ${entry()!.panel.id} render`}>
                      {() => entry()!.panel.render(props.region.props(() => entry()!))}
                    </Contribution>
                  </PanelContext.Provider>
                </div>
              )}
            </Show>
          )
        }}
      </Show>
    </>
  )
}
