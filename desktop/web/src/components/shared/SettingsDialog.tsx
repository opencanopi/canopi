import { useEffect, useId, useState } from 'preact/hooks'
import { openAboutCanopiDialog } from '../../app/about/state'
import { CANOPI_VERSION } from '../../app/about/metadata'
import { setBasemapStyle, setSoftenBackground } from '../../app/map-layers/actions'
import { mapLayers } from '../../app/map-layers/state'
import { mutateSettingsProjection, type SettingsPersistMode } from '../../app/settings/projection'
import {
  locale,
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

/** Each language in its own name, so anyone can find theirs. */
const LANGUAGE_ITEMS: DropdownItem<Locale>[] = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'pt', label: 'Português' },
  { value: 'it', label: 'Italiano' },
  { value: 'de', label: 'Deutsch' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'ru', label: 'Русский' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

type SettingsSectionId = 'appearance' | 'map' | 'canvas' | 'new-designs' | 'keyboard' | 'files' | 'about'

const SECTIONS: readonly { readonly id: SettingsSectionId; readonly icon: ControlIconName; readonly labelKey: LocaleKey }[] = [
  { id: 'appearance', icon: 'sun', labelKey: 'settings.appearance' },
  { id: 'map', icon: 'image', labelKey: 'settings.mapAndImagery' },
  { id: 'canvas', icon: 'fit', labelKey: 'settings.canvas' },
  { id: 'new-designs', icon: 'plus', labelKey: 'settings.newDesigns' },
  { id: 'keyboard', icon: 'keyboard', labelKey: 'settings.keyboard' },
  { id: 'files', icon: 'folder-open', labelKey: 'settings.filesAndData' },
  { id: 'about', icon: 'info', labelKey: 'settings.about' },
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

/** File › Settings… (Ctrl ,): device preferences, never stored in a Design. */
export function SettingsDialog({ folders }: { readonly folders?: SettingsFoldersAdapter }) {
  if (!settingsDialogOpen.value) return null
  return <SettingsDialogContent folders={folders} />
}

function SettingsDialogContent({ folders }: { readonly folders?: SettingsFoldersAdapter }) {
  const [active, setActive] = useState<SettingsSectionId>('appearance')
  const id = useId()
  const section = SECTIONS.find((candidate) => candidate.id === active)!
  return (
    <WorkspaceDialog title={t('settings.title')} onClose={closeSettingsDialog} wide>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label={t('settings.sections')}>
          {SECTIONS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={styles.navItem}
              aria-current={candidate.id === active ? 'page' : undefined}
              data-settings-section={candidate.id}
              onClick={() => setActive(candidate.id)}
            >
              <ControlIcon name={candidate.icon} size={18} />
              {t(candidate.labelKey)}
            </button>
          ))}
        </nav>
        <section className={styles.section} aria-labelledby={`${id}-heading`}>
          <h3 className={styles.heading} id={`${id}-heading`}>{t(section.labelKey)}</h3>
          {active === 'appearance' && <AppearanceSection />}
          {active === 'map' && <MapSection />}
          {active === 'canvas' && <CanvasSection />}
          {active === 'new-designs' && <NewDesignsSection />}
          {active === 'keyboard' && <KeyboardSection />}
          {active === 'files' && <FilesSection folders={folders} />}
          {active === 'about' && <AboutSection />}
        </section>
      </div>
    </WorkspaceDialog>
  )
}

function AppearanceSection() {
  const currentLanguage = LANGUAGE_ITEMS.find((item) => item.value === locale.value)
  return <>
    <div className={styles.field}>
      <span className={styles.label}>{t('settings.theme')}</span>
      <SegmentedControl<Theme>
        label={t('settings.theme')}
        value={theme.value}
        options={[
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
        ]}
        onChange={(next) => mutateSettingsProjection((settings) => { settings.theme = next }, { persist: 'immediate' })}
      />
    </div>
    <div className={styles.field}>
      <span className={styles.label}>{t('settings.language')}</span>
      <Dropdown<Locale>
        trigger={currentLanguage?.label ?? locale.value}
        items={LANGUAGE_ITEMS}
        value={locale.value}
        ariaLabel={t('settings.language')}
        preserveOverlays
        floating
        onChange={(next) => mutateSettingsProjection((settings) => { settings.locale = next }, { persist: 'immediate' })}
      />
    </div>
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
    <div className={styles.field}>
      <span className={styles.label}>{t('settings.mapStyle')}</span>
      <Dropdown<BasemapStyle>
        trigger={t(`canvas.basemap.styles.${style}`)}
        items={SETTINGS_BASEMAP_STYLES.map((value) => ({ value, label: t(`canvas.basemap.styles.${value}`) }))}
        value={style}
        ariaLabel={t('settings.mapStyle')}
        preserveOverlays
        floating
        onChange={setBasemapStyle}
      />
    </div>
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
  return <>
    <div className={styles.field}>
      <span className={styles.label}>{t('settings.pointingDevice')}</span>
      <SegmentedControl<ScrollWheel>
        label={t('settings.pointingDevice')}
        value={scrollWheel.value}
        options={[
          { value: 'zoom', label: t('settings.pointingDeviceMouse') },
          { value: 'pan', label: t('settings.pointingDeviceTrackpad') },
        ]}
        onChange={(next) => mutateSettingsProjection((settings) => { settings.scrollWheel = next }, { persist: 'immediate' })}
      />
      <span className={styles.hint}>{t('settings.pointingDeviceHint')}</span>
    </div>
  </>
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
    <div className={styles.field}>
      <span className={styles.label}>{t('speciesKey.labels')}</span>
      <SegmentedControl<PlantLabels>
        label={t('speciesKey.labels')}
        value={defaults.labels}
        options={[
          { value: 'none', label: t('speciesKey.labelsNone') },
          { value: 'codes', label: t('speciesKey.labelsCodes') },
          { value: 'names', label: t('speciesKey.labelsNames') },
        ]}
        onChange={(labels) => setNewDesignDefault({ labels })}
      />
    </div>
  </>
}

function KeyboardSection() {
  return <>
    <Switch
      label={t('settings.singleKeyShortcuts')}
      hint={t('settings.singleKeyShortcutsHint', { mod: modKeyName(t) })}
      checked={singleKeyShortcuts.value}
      onChange={(checked) => mutateSettingsProjection((settings) => { settings.singleKeyShortcuts = checked }, { persist: 'immediate' })}
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

type FolderState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly locations: AppFolderLocations }
  | { readonly status: 'failed' }

function FilesSection({ folders }: { readonly folders?: SettingsFoldersAdapter }) {
  const [state, setState] = useState<FolderState>({ status: 'loading' })
  const [failed, setFailed] = useState<AppFolder | null>(null)

  useEffect(() => {
    if (!folders) return
    let live = true
    folders.load().then(
      (locations) => { if (live) setState({ status: 'ready', locations }) },
      // The reason may name a path; it stays out of logs.
      () => { if (live) setState({ status: 'failed' }) },
    )
    return () => { live = false }
  }, [folders])

  if (!folders) return <p className={styles.intro}>{t('settings.filesWeb')}</p>
  if (state.status === 'loading') return <p className={styles.hint} role="status">{t('settings.filesLoading')}</p>
  if (state.status === 'failed') return <p className={styles.status} role="alert">{t('settings.filesUnavailable')}</p>

  const rows: readonly { readonly folder: AppFolder; readonly label: string; readonly hint: string; readonly path: string }[] = [
    { folder: 'drafts', label: t('drafts.title'), hint: t('settings.draftsHint'), path: state.locations.drafts },
    { folder: 'data_library', label: t('settings.dataLibrary'), hint: t('settings.dataLibraryHint'), path: state.locations.data_library },
  ]
  return <>
    <p className={styles.intro}>{t('settings.filesIntro')}</p>
    {rows.map((row) => (
      <div key={row.folder} className={styles.folder} data-app-folder={row.folder}>
        <div className={styles.folderText}>
          <span className={styles.label}>{row.label}</span>
          <span className={styles.hint}>{row.hint}</span>
          <span className={styles.path}>{row.path}</span>
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            setFailed(null)
            folders.show(row.folder).catch(() => setFailed(row.folder))
          }}
        >
          {t('settings.showInFolder')}
        </button>
      </div>
    ))}
    {failed && <p className={styles.status} role="alert">{t('settings.showFolderFailed')}</p>}
  </>
}

function AboutSection() {
  return <>
    <p className={styles.intro}>{t('settings.aboutVersion', { version: CANOPI_VERSION })}</p>
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
