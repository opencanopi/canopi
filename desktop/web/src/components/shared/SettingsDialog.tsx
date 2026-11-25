import type { ComponentChildren } from 'preact'
import { useEffect, useId, useState } from 'preact/hooks'
import { openAboutCanopiDialog } from '../../app/about/state'
import { CANOPI_VERSION } from '../../app/about/metadata'
import { setBasemapStyle, setSoftenBackground } from '../../app/map-layers/actions'
import { mutateSettingsProjection, type SettingsPersistMode, type SettingsProjectionDraft } from '../../app/settings/projection'
import {
  locale,
  mapLayers,
  newDesignDefaults,
  scrollWheel,
  singleKeyShortcuts,
  theme,
  type NewDesignDefaults,
} from '../../app/settings/state'
import {
  closeSettingsDialog,
  openKeyboardShortcutsDialog,
  settingsDialogOpen,
} from '../../app/shell/dialogs'
import { toggleToolNames, toolRailShowsNames } from '../../app/tool-rail/learning'
import { modKeyName } from '../../app/shell-commands/shortcut-text'
import { PLANT_SYMBOL_SCALE_MAX, PLANT_SYMBOL_SCALE_MIN } from '../../canvas/runtime/plant-display'
import type { AppFolder, AppFolderLocations, BasemapStyle, PlantLabels, ScrollWheel } from '../../generated/contracts'
import { SETTINGS_BASEMAP_STYLES } from '../../generated/settings'
import type { Locale, Theme } from '../../types/settings'
import { readFailureCode } from '../../failures/store-read'
import { t } from '../../i18n'
import { ControlIcon, type ControlIconName } from './ControlIcon'
import { Dropdown, type DropdownItem } from './Dropdown'
import { SegmentedControl } from './SegmentedControl'
import { SettingsGoogleKeyField } from './SettingsGoogleKeyField'
import { Switch } from './Switch'
import { Slider } from './Slider'
import { WorkspaceDialog } from './WorkspaceDialog'
import styles from './SettingsDialog.module.css'
import type { LocaleKey } from '../../generated/locale-keys'
import { LOCALE_PICKER_ORDER } from '../../generated/locale-registry'

/** Each language in its own name in picker order (Latin, Cyrillic, CJK; from the L6 locale registry). */
const LANGUAGE_ITEMS: DropdownItem<Locale>[] = LOCALE_PICKER_ORDER.map((entry) => ({
  value: entry.code,
  label: entry.endonym,
}))

type SettingsSectionId = 'appearance' | 'map' | 'canvas' | 'new-designs' | 'keyboard' | 'files' | 'about'

const SECTIONS: readonly (readonly [SettingsSectionId, ControlIconName, LocaleKey])[] = [
  ['appearance', 'sun', 'settings.appearance'],
  ['map', 'image', 'settings.mapAndImagery'],
  ['canvas', 'fit', 'settings.canvas'],
  ['new-designs', 'plus', 'settings.newDesigns'],
  ['keyboard', 'keyboard', 'settings.keyboard'],
  ['files', 'folder-open', 'settings.filesAndData'],
  ['about', 'info', 'settings.about'],
]

/**
 * Where the edition keeps its files, for Settings › Files and data. Desktop
 * names its folders and opens them; Web keeps everything in the browser and
 * passes none. Paths are the user's own and are shown on that screen only.
 */
export interface SettingsFoldersAdapter {
  load(): Promise<AppFolderLocations>
  show(folder: AppFolder): Promise<void>
}

/**
 * File › Settings… (Ctrl ,): device preferences, never stored in a Design. `updates` is the Desktop root's
 * LaunchCheckSwitch, shown in About as given and never tested here, so Web shows no updater (ADR 0030, 2.1-Q201).
 */
export function SettingsDialog({ folders, updates }: { readonly folders?: SettingsFoldersAdapter, readonly updates?: ComponentChildren }) {
  if (!settingsDialogOpen.value) return null
  return <SettingsDialogContent folders={folders} updates={updates} />
}

function SettingsDialogContent({ folders, updates }: { readonly folders?: SettingsFoldersAdapter, readonly updates?: ComponentChildren }) {
  const [active, setActive] = useState<SettingsSectionId>('appearance')
  const id = useId()
  const section = SECTIONS.find(([sid]) => sid === active)!
  return (
    <WorkspaceDialog title={t('settings.title')} onClose={closeSettingsDialog} wide>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label={t('settings.sections')}>
          {SECTIONS.map(([sid, icon, labelKey]) => (
            <button
              key={sid}
              type="button"
              className={styles.navItem}
              aria-current={sid === active ? 'page' : undefined}
              data-settings-section={sid}
              onClick={() => setActive(sid)}
            >
              <ControlIcon name={icon} size={18} />
              {t(labelKey)}
            </button>
          ))}
        </nav>
        <section className={styles.section} aria-labelledby={`${id}-heading`}>
          <h3 className={styles.heading} id={`${id}-heading`}>{t(section[2])}</h3>
          {active === 'appearance' && <AppearanceSection />}
          {active === 'map' && <MapSection />}
          {active === 'canvas' && <CanvasSection />}
          {active === 'new-designs' && <NewDesignsSection />}
          {active === 'keyboard' && <KeyboardSection />}
          {active === 'files' && <FilesSection folders={folders} />}
          {active === 'about' && <AboutSection updates={updates} />}
        </section>
      </div>
    </WorkspaceDialog>
  )
}

const setSetting = <K extends keyof SettingsProjectionDraft>(key: K, value: SettingsProjectionDraft[K]): void => {
  mutateSettingsProjection((settings) => { settings[key] = value })
}
const opt = <T extends string>(value: T, labelKey: LocaleKey) => ({ value, label: t(labelKey) })

function SettingField({ label, hint, children }: { readonly label: LocaleKey, readonly hint?: LocaleKey, readonly children: ComponentChildren }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{t(label)}</span>
      {children}
      {hint && <span className={styles.hint}>{t(hint)}</span>}
    </div>
  )
}

function AppearanceSection() {
  const currentLanguage = LANGUAGE_ITEMS.find((item) => item.value === locale.value)
  return <>
    <SettingField label="settings.theme">
      <SegmentedControl<Theme>
        label={t('settings.theme')}
        value={theme.value}
        options={[opt('light', 'theme.light'), opt('dark', 'theme.dark')]}
        onChange={(next) => setSetting('theme', next)}
      />
    </SettingField>
    <SettingField label="settings.language">
      <Dropdown<Locale>
        trigger={currentLanguage?.label ?? locale.value}
        items={LANGUAGE_ITEMS}
        value={locale.value}
        ariaLabel={t('settings.language')}
        preserveOverlays
        floating
        onChange={(next) => setSetting('locale', next)}
      />
    </SettingField>
    <Switch
      label={t('settings.toolNames')}
      hint={t('settings.toolNamesHint')}
      checked={toolRailShowsNames.value}
      onChange={(checked) => { if (checked !== toolRailShowsNames.peek()) toggleToolNames() }}
    />
  </>
}

function MapSection() {
  const style = mapLayers.value.basemap.style
  return <>
    <SettingsGoogleKeyField />
    <div className={styles.rule} />
    <SettingField label="settings.mapStyle">
      <Dropdown<BasemapStyle>
        trigger={t(`canvas.basemap.styles.${style}`)}
        items={SETTINGS_BASEMAP_STYLES.map((value) => ({ value, label: t(`canvas.basemap.styles.${value}`) }))}
        value={style}
        ariaLabel={t('settings.mapStyle')}
        preserveOverlays
        floating
        onChange={setBasemapStyle}
      />
    </SettingField>
    <Switch
      label={t('speciesKey.softenBackground')}
      hint={t('speciesKey.softenBackgroundHint')}
      checked={mapLayers.value.softenBackground}
      onChange={setSoftenBackground}
    />
    <span className={styles.hint}>{t('settings.mapNewDesignsHint')}</span>
  </>
}

/**
 * Settings › Canvas: the pointing device, stored as the scroll-wheel choice. Mouse (`zoom`): a plain wheel zooms about
 * the pointer. Trackpad (`pan`): two fingers pan and a pinch zooms. The Select tool card follows it.
 */
function CanvasSection() {
  return (
    <SettingField label="settings.pointingDevice" hint="settings.pointingDeviceHint">
      <SegmentedControl<ScrollWheel>
        label={t('settings.pointingDevice')}
        value={scrollWheel.value}
        options={[opt('zoom', 'settings.pointingDeviceMouse'), opt('pan', 'settings.pointingDeviceTrackpad')]}
        onChange={(next) => setSetting('scrollWheel', next)}
      />
    </SettingField>
  )
}

function setNewDesignDefault(change: Partial<NewDesignDefaults>, persist: SettingsPersistMode = 'immediate'): void {
  mutateSettingsProjection((settings) => {
    settings.newDesigns = { ...settings.newDesigns, ...change }
  }, { persist })
}

function NewDesignsSection() {
  const defaults = newDesignDefaults.value
  const sizePercent = Math.round(defaults.symbolScale * 100)
  return <>
    <p className={styles.intro}>{t('settings.newDesignsIntro')}</p>
    <Switch
      label={t('settings.openOnSatellite')}
      hint={t('settings.openOnSatelliteHint')}
      checked={defaults.satellite}
      onChange={(satellite) => setNewDesignDefault({ satellite })}
    />
    <Slider
      label={t('speciesKey.symbolSize')}
      min={PLANT_SYMBOL_SCALE_MIN * 100}
      max={PLANT_SYMBOL_SCALE_MAX * 100}
      step={10}
      value={sizePercent}
      format={(percent) => new Intl.NumberFormat(locale.value, { style: 'percent' }).format(percent / 100)}
      // Slider-driven, so persistence is queued rather than written per step.
      onInput={(percent) => setNewDesignDefault({ symbolScale: percent / 100 }, 'queued')}
    />
    <SettingField label="speciesKey.labels">
      <SegmentedControl<PlantLabels>
        label={t('speciesKey.labels')}
        value={defaults.labels}
        options={[opt('none', 'speciesKey.labelsNone'), opt('codes', 'speciesKey.labelsCodes'), opt('names', 'speciesKey.labelsNames')]}
        onChange={(labels) => setNewDesignDefault({ labels })}
      />
    </SettingField>
  </>
}

function KeyboardSection() {
  return <>
    <Switch
      label={t('settings.singleKeyShortcuts')}
      hint={t('settings.singleKeyShortcutsHint', { mod: modKeyName(t) })}
      checked={singleKeyShortcuts.value}
      onChange={(checked) => setSetting('singleKeyShortcuts', checked)}
    />
    <p className={styles.hint}>{t('settings.remapLater')}</p>
    <div>
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          closeSettingsDialog()
          openKeyboardShortcutsDialog()
        }}
      >
        {t('settings.allShortcuts')}
      </button>
    </div>
  </>
}

/**
 * Favourites belong to this computer or this browser, never to a Design (2.1-Q312), so the note shows whatever the
 * folders do; export and import wait for a second request (canopi-13lh).
 */
function FilesSection({ folders }: { readonly folders?: SettingsFoldersAdapter }) {
  return <>
    {folders ? <AppFolders folders={folders} /> : <p className={styles.intro}>{t('settings.filesWeb')}</p>}
    <p className={styles.hint} data-favourites-note>
      {t(folders ? 'settings.favouritesDesktop' : 'settings.favouritesWeb')}
    </p>
  </>
}

function AppFolders({ folders }: { readonly folders: SettingsFoldersAdapter }) {
  const [locations, setLocations] = useState<AppFolderLocations | null | false>(null)
  const [failed, setFailed] = useState<AppFolder | null>(null)

  useEffect(() => {
    let live = true
    folders.load().then(
      (next) => { if (live) setLocations(next) },
      // The reason may name a path; it stays out of logs.
      () => { if (live) setLocations(false) },
    )
    return () => { live = false }
  }, [folders])

  if (locations === null) return <p className={styles.hint} role="status">{t('settings.filesLoading')}</p>
  if (locations === false) return <p className={styles.status} role="alert">{t('settings.filesUnavailable')}</p>

  const rows: readonly (readonly [AppFolder, LocaleKey, LocaleKey])[] = [
    ['drafts', 'drafts.title', 'settings.draftsHint'],
    ['data_library', 'settings.dataLibrary', 'settings.dataLibraryHint'],
  ]
  return <>
    <p className={styles.intro}>{t('settings.filesIntro')}</p>
    {rows.map(([folder, label, hint]) => (
      <div key={folder} className={styles.folder} data-app-folder={folder}>
        <div className={styles.folderText}>
          <span className={styles.label}>{t(label)}</span>
          <span className={styles.hint}>{t(hint)}</span>
          <span className={styles.path}>{locations[folder]}</span>
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            setFailed(null)
            folders.show(folder).catch(() => setFailed(folder))
          }}
        >
          {t('settings.showInFolder')}
        </button>
      </div>
    ))}
    {failed && <p className={styles.status} role="alert">{t('settings.showFolderFailed')}</p>}
  </>
}

function AboutSection({ updates }: { readonly updates?: ComponentChildren }) {
  return <>
    <p className={styles.intro}>{t('settings.aboutVersion', { version: CANOPI_VERSION })}</p>
    {updates}
    <div>
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          closeSettingsDialog()
          openAboutCanopiDialog()
        }}
      >
        {t('settings.aboutCanopi')}
      </button>
    </div>
  </>
}

/** The launch-check setting's own key row, `updater.check_at_launch`, through the host (2.1-M206). */
export interface LaunchCheckPort {
  get(): Promise<boolean>
  /** Resolves once written, or once held for the session under settings a newer Canopi saved; rejects otherwise. */
  set(on: boolean): Promise<void>
}

/**
 * The port over the host's row, holding a write the store refuses under settings a newer Canopi saved (2.1-Q320,
 * M487) until the app closes, so the About tab reads the user's value again when it remounts.
 */
export function createLaunchCheckPort(get: () => Promise<boolean>, set: (on: boolean) => Promise<void>): LaunchCheckPort {
  let session: boolean | null = null
  return {
    get: () => (session === null ? get() : Promise.resolve(session)),
    set: (on) => set(on).then(() => { session = null }, (error: unknown) => {
      if (readFailureCode(error).kind !== 'store_read_only') throw error
      session = on
    }),
  }
}

/**
 * "Check for updates at launch" (2.1-Q164): its own key row, on when the row is missing (the host's default), so the
 * settings record is never touched (M206). Shown once read; hidden when the row cannot be read. While it is read its
 * place is held, invisible and inert, so a late answer moves nothing below it and a press meant for About Canopi…
 * never lands on the switch (canopi-f47t.52.271). A write the port holds for the session keeps the switch as set
 * (createLaunchCheckPort, 2.1-Q320); any failed write puts it back.
 */
export function LaunchCheckSwitch({ port }: { readonly port: LaunchCheckPort }) {
  const [on, setOn] = useState<boolean | 'reading' | 'unreadable'>('reading')
  useEffect(() => {
    let live = true
    port.get().then(
      (value) => { if (live) setOn(value) },
      // The row could not be read: the switch stays hidden rather than show a value it does not know.
      () => { if (live) setOn('unreadable') },
    )
    return () => { live = false }
  }, [port])
  if (on === 'unreadable') return null
  if (on === 'reading') {
    return (
      <div className={styles.launchCheckReading} aria-hidden="true">
        <Switch label={t('update.checkAtLaunch')} checked={false} disabled onChange={() => {}} />
      </div>
    )
  }
  return (
    <div data-launch-check="">
      <Switch
        label={t('update.checkAtLaunch')}
        checked={on}
        onChange={(next) => {
          setOn(next)
          port.set(next).catch(() => setOn(!next))
        }}
      />
    </div>
  )
}
