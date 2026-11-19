import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { AlertOptions, ConfirmOptions, PromptOptions, SelectOptions } from "@opencode/plugin/gui"
import type { App } from "./app.ts"
import { Contribution } from "./contribution.tsx"
import { DialogFrameContext, ui } from "./ui.tsx"

/** The app's question dialogs (`ctx.dialogs.confirm` and friends), in the app's dialog markup. */

export function confirmDialog(options: ConfirmOptions, resolve: (answer: boolean) => void): JSX.Element {
  return (
    <ui.Dialog
      title={options.title}
      description={options.description}
      footer={
        <>
          <ui.Button variant="ghost" autofocus={options.danger} onClick={() => resolve(false)}>
            {options.cancel ?? "Cancel"}
          </ui.Button>
          <ui.Button
            variant={options.danger ? "danger" : "contrast"}
            autofocus={!options.danger}
            onClick={() => resolve(true)}
          >
            {options.confirm ?? "Confirm"}
          </ui.Button>
        </>
      }
    />
  )
}

export function alertDialog(options: AlertOptions, done: () => void): JSX.Element {
  return (
    <ui.Dialog
      title={options.title}
      description={options.description}
      footer={
        <ui.Button variant="contrast" autofocus onClick={done}>
          {options.ok ?? "OK"}
        </ui.Button>
      }
    />
  )
}

export function promptDialog(options: PromptOptions, resolve: (value: string | undefined) => void): JSX.Element {
  const [value, setValue] = createSignal(options.value ?? "")
  const submit = () => {
    if (value() !== "") resolve(value())
  }
  return (
    <ui.Dialog
      title={options.title}
      description={options.description}
      footer={
        <>
          <ui.Button variant="ghost" onClick={() => resolve(undefined)}>
            Cancel
          </ui.Button>
          <ui.Button variant="contrast" disabled={value() === ""} onClick={submit}>
            {options.submit ?? "Submit"}
          </ui.Button>
        </>
      }
    >
      <ui.TextInput
        label={options.title}
        value={value()}
        onInput={setValue}
        onSubmit={submit}
        placeholder={options.placeholder}
        type={options.secret ? "password" : "text"}
        size="large"
        autofocus
      />
    </ui.Dialog>
  )
}

export function selectDialog<T>(options: SelectOptions<T>, resolve: (value: T | undefined) => void): JSX.Element {
  const [query, setQuery] = createSignal("")
  const shown = () =>
    options.options.filter((option) =>
      `${option.title} ${option.description ?? ""}`.toLowerCase().includes(query().toLowerCase()),
    )
  return (
    <ui.Dialog title={options.title}>
      <ui.TextInput
        label={options.placeholder ?? "Search"}
        placeholder={options.placeholder ?? "Search"}
        value={query()}
        onInput={setQuery}
        onSubmit={() => {
          const first = shown()[0]
          if (first) resolve(first.value)
        }}
        autofocus
      />
      <div role="listbox" class="playground-select-list">
        <For each={shown()}>
          {(option) => (
            <div
              role="option"
              data-component="menu-v2-item"
              aria-selected={option.value === options.current}
              onClick={() => resolve(option.value)}
            >
              <span data-slot="menu-v2-item-content">{option.title}</span>
              <Show when={option.description}>
                <span class="playground-muted">{option.description}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </ui.Dialog>
  )
}

/** The dialog stack: a scrim, then each dialog; Escape and a press on the scrim close the top one. */
export function DialogLayer(props: { app: App }) {
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const top = props.app.dialogs.list().at(-1)
      if (!top) return
      event.preventDefault()
      top.dismiss()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })
  return (
    <Show when={props.app.dialogs.list().length > 0}>
      <div
        data-component="dialog-overlay"
        onClick={() => props.app.dialogs.list().at(-1)?.dismiss()}
        data-playground-dialog-overlay
      />
      <For each={props.app.dialogs.list()}>
        {(dialog) => (
          <div data-playground-dialog={dialog.plugin ?? "host"}>
            <DialogFrameContext.Provider value={{ close: () => dialog.dismiss() }}>
              <Show when={dialog.plugin} fallback={dialog.render(dialog.handle)}>
                {(plugin) => (
                  <Contribution app={props.app} plugin={plugin()} where="dialog" failed={() => dialog.handle.close()}>
                    {() => dialog.render(dialog.handle)}
                  </Contribution>
                )}
              </Show>
            </DialogFrameContext.Provider>
          </div>
        )}
      </For>
    </Show>
  )
}
