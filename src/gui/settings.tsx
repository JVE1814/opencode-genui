import type { JSX } from "solid-js"
import type { Prefs } from "./host.ts"
import type { GuiEnv } from "./setup.tsx"

type Draft = { -readonly [K in keyof Prefs]: Prefs[K] }

/** Settings › genui: the preferences, how the agent is told about genui, and clearing stored UI state. */
export function SettingsView(props: {
  readonly env: GuiEnv
  readonly prefs: () => Prefs
  readonly update: (mutate: (draft: Draft) => void) => void
}): JSX.Element {
  const { ctx } = props.env
  const ui = ctx.ui
  const t = (key: string) => ctx.t(key)
  const id = (name: string) => `${ctx.id}-${name}`

  const autoOpen = () =>
    (["select", "append", "off"] as const).map((value) => ({ value, label: t(`settings.autoOpen.${value}`) }))
  const confirm = () =>
    (["always", "untrusted", "never"] as const).map((value) => ({ value, label: t(`settings.confirm.${value}`) }))
  const instructions = () =>
    (["session", "always", "off"] as const).map((value) => ({ value, label: t(`settings.instructions.${value}`) }))

  const clear = () => {
    props.env.resetSurfaces()
    ctx.toast.show({ title: t("settings.clear.done"), variant: "success" })
  }

  return (
    <ui.SettingsLayout title={t("settings.title")} description={t("settings.description")}>
      <ui.SettingsSection title={t("settings.section.behavior")}>
        <ui.SettingsRow
          id={id("auto-open")}
          title={t("settings.autoOpen.title")}
          description={t("settings.autoOpen.description")}
        >
          <ui.Select
            label={t("settings.autoOpen.title")}
            options={autoOpen()}
            value={props.prefs().autoOpen}
            onChange={(value) => props.update((draft) => void (draft.autoOpen = value))}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id={id("confirm")}
          title={t("settings.confirm.title")}
          description={t("settings.confirm.description")}
        >
          <ui.Select
            label={t("settings.confirm.title")}
            options={confirm()}
            value={props.prefs().confirmActions}
            onChange={(value) => props.update((draft) => void (draft.confirmActions = value))}
          />
        </ui.SettingsRow>
        <ui.SettingsRow
          id={id("images")}
          title={t("settings.images.title")}
          description={t("settings.images.description")}
        >
          <ui.Switch
            label={t("settings.images.title")}
            hideLabel
            checked={props.prefs().remoteImages}
            onChange={(checked) => props.update((draft) => void (draft.remoteImages = checked))}
          />
        </ui.SettingsRow>
      </ui.SettingsSection>
      <ui.SettingsSection title={t("settings.section.agent")}>
        <ui.SettingsRow
          id={id("instructions")}
          title={t("settings.instructions.title")}
          description={t("settings.instructions.description")}
        >
          {/* Read-only: options come from opencode.json, which the GUI does not write. */}
          <ui.Select
            label={t("settings.instructions.title")}
            options={instructions()}
            value={props.env.options.instructions}
            onChange={() => {}}
            disabled
          />
        </ui.SettingsRow>
      </ui.SettingsSection>
      <ui.SettingsSection title={t("settings.section.data")}>
        <ui.SettingsRow
          id={id("clear")}
          title={t("settings.clear.title")}
          description={t("settings.clear.description")}
        >
          <ui.Button size="small" variant="neutral" onClick={clear}>
            {t("settings.clear.action")}
          </ui.Button>
        </ui.SettingsRow>
      </ui.SettingsSection>
    </ui.SettingsLayout>
  )
}
