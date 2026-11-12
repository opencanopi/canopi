import { batch } from '@preact/signals'
import type { LastView, SatelliteSource, ScrollWheel } from '../../generated/contracts'
import { readFailureCode, readWithRetry } from '../../failures/store-read'
import { writeStoreHealth } from '../../failures/health'
import { reportFailure } from '../../failures/report'
import { WEB_MERCATOR_MAX_LATITUDE_DEG } from '../../generated/canopi-design-format'
import type { Locale, Settings, Theme } from '../../types/settings'
import { FALLBACK_PLANT_SPACING_INTERVAL_M } from '../../canvas/plant-spacing-interval'
import { clampPlantSymbolScale } from '../../canvas/runtime/plant-display'
import { mapLayers, mapLayersEqual, normalizeMapLayers, type MapLayersState } from '../map-layers/state'
import { snapToGridEnabled } from '../canvas-settings/signals'
import { sidePanelWidth } from '../shell/state'
import {
  DEFAULT_SAVED_STAMPS_FRAME_HEIGHT,
  MIN_FAVORITES_FRAME_HEIGHT,
  googleMapsApiKey,
  lastView,
  locale,
  newDesignDefaults,
  plantSpacingIntervalM,
  satelliteSource,
  savedStampsFrameHeight,
  scrollWheel,
  singleKeyShortcuts,
  theme,
  toolNamesVisible,
  usedCanvasTools,
  type NewDesignDefaults,
} from './state'
import { withFirstRunSettings, type SettingsPlatformAdapter } from './platform-adapter'

export type SettingsPersistMode = 'immediate' | 'queued' | 'none'

export interface SettingsProjectionDraft {
  locale: Locale
  theme: Theme
  googleMapsApiKey: string | null
  satelliteSource: SatelliteSource
  snapToGrid: boolean
  plantSpacingIntervalM: number
  lastView: LastView | null
  sidePanel: { width: number | null }
  savedStamps: { frameHeight: number }
  mapLayers: MapLayersState
  toolRail: {
    usedTools: readonly string[]
    namesVisible: boolean | null
  }
  singleKeyShortcuts: boolean
  scrollWheel: ScrollWheel
  newDesigns: NewDesignDefaults
}

interface MutateSettingsProjectionOptions {
  persist?: SettingsPersistMode
  delayMs?: number
}

export interface SettingsProjectionInstallation {
  readonly ready: Promise<void>
  dispose(): void
}

interface ActiveSettingsProjection {
  readonly adapter: SettingsPlatformAdapter
  disposed: boolean
  retiring: boolean
  durable: Settings | null
  requested: Settings | null
  saving: Settings | null
  queuedPersistTimer: ReturnType<typeof globalThis.setTimeout> | null
  drainPromise: Promise<void> | null
  draining: boolean
  retryBlocked: boolean
  persistenceError: unknown | null
  pendingHydrationPatch: Partial<Settings>
  pendingHydrationPersistence: boolean
  readonly fallback: Settings
  readonly retired: Promise<void>
  readonly resolveRetired: () => void
  ready: Promise<void> | null
  /** The first or a Try again read in flight; a press joins it, so one read lands and applies the session's changes. */
  retrying: Promise<boolean> | null
}

interface PendingHydrationIntent {
  readonly fallback: Settings
  readonly patch: Partial<Settings>
  readonly persist: boolean
}

const DEFAULT_QUEUED_PERSIST_DELAY_MS = 160
const SETTINGS_LOAD_RETRY_DELAYS_MS: readonly number[] = [100, 400] // SET-05: a busy store gets two more reads
const MIN_SIDE_PANEL_WIDTH = 320

let sourceSettings: Settings | null = null
let activeSettingsProjection: ActiveSettingsProjection | null = null
let pendingSettingsRetirement: Promise<void> | null = null
let pendingHydrationIntent: PendingHydrationIntent | null = null

function normalizePositiveMeters(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}

function normalizeSidePanelWidth(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.round(value))
}

function normalizeSavedStampsFrameHeight(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return DEFAULT_SAVED_STAMPS_FRAME_HEIGHT
  return Math.max(MIN_FAVORITES_FRAME_HEIGHT, Math.round(value))
}

function normalizeTheme(value: Theme): Theme {
  return value === 'dark' ? 'dark' : 'light'
}

function createDraftFromProjection(): SettingsProjectionDraft {
  return {
    locale: locale.value,
    theme: theme.value,
    googleMapsApiKey: googleMapsApiKey.value,
    satelliteSource: satelliteSource.value,
    snapToGrid: snapToGridEnabled.value,
    plantSpacingIntervalM: plantSpacingIntervalM.value,
    lastView: lastView.value,
    sidePanel: {
      width: sidePanelWidth.value,
    },
    savedStamps: {
      frameHeight: savedStampsFrameHeight.value,
    },
    mapLayers: mapLayers.value,
    toolRail: {
      usedTools: usedCanvasTools.value,
      namesVisible: toolNamesVisible.value,
    },
    singleKeyShortcuts: singleKeyShortcuts.value,
    scrollWheel: scrollWheel.value,
    newDesigns: newDesignDefaults.value,
  }
}

/**
 * The key as persisted: trimmed, and empty means absent.
 *
 * Trimming happens on the explicit save path only, so an in-progress edit
 * is never rewritten while the user is still typing it.
 */
function trimmedKey(value: string | null): string | null {
  const key = value?.trim()
  return key ? key : null
}

function normalizeDraft(draft: SettingsProjectionDraft): SettingsProjectionDraft {
  return {
    locale: draft.locale,
    theme: normalizeTheme(draft.theme),
    // The key is stored exactly as typed; the explicit save action is what
    // trims it, so partial editing never silently rewrites the credential.
    googleMapsApiKey: draft.googleMapsApiKey,
    satelliteSource: draft.satelliteSource === 'google_key' ? 'google_key' : 'free',
    snapToGrid: draft.snapToGrid,
    plantSpacingIntervalM: normalizePositiveMeters(
      draft.plantSpacingIntervalM,
      FALLBACK_PLANT_SPACING_INTERVAL_M,
    ),
    lastView: normalizeLastView(draft.lastView),
    sidePanel: {
      width: normalizeSidePanelWidth(draft.sidePanel.width),
    },
    savedStamps: {
      frameHeight: normalizeSavedStampsFrameHeight(draft.savedStamps.frameHeight),
    },
    mapLayers: normalizeMapLayers(draft.mapLayers),
    toolRail: {
      usedTools: [...new Set(draft.toolRail.usedTools)],
      namesVisible: draft.toolRail.namesVisible,
    },
    singleKeyShortcuts: draft.singleKeyShortcuts,
    scrollWheel: draft.scrollWheel === 'pan' ? 'pan' : 'zoom',
    newDesigns: {
      satellite: draft.newDesigns.satellite,
      symbolScale: clampPlantSymbolScale(draft.newDesigns.symbolScale),
      labels: draft.newDesigns.labels,
    },
  }
}

function applyDraftToProjection(draft: SettingsProjectionDraft): void {
  batch(() => {
    locale.value = draft.locale
    theme.value = draft.theme
    googleMapsApiKey.value = draft.googleMapsApiKey
    satelliteSource.value = draft.satelliteSource
    snapToGridEnabled.value = draft.snapToGrid
    plantSpacingIntervalM.value = draft.plantSpacingIntervalM
    if (!sameLastView(lastView.value, draft.lastView)) lastView.value = draft.lastView
    sidePanelWidth.value = draft.sidePanel.width
    savedStampsFrameHeight.value = draft.savedStamps.frameHeight
    if (!mapLayersEqual(mapLayers.value, draft.mapLayers)) mapLayers.value = draft.mapLayers
    if (!sameStrings(usedCanvasTools.value, draft.toolRail.usedTools)) usedCanvasTools.value = draft.toolRail.usedTools
    toolNamesVisible.value = draft.toolRail.namesVisible
    singleKeyShortcuts.value = draft.singleKeyShortcuts
    scrollWheel.value = draft.scrollWheel
    if (!sameNewDesignDefaults(newDesignDefaults.value, draft.newDesigns)) newDesignDefaults.value = draft.newDesigns
  })
}

function settingsFromDraft(draft: SettingsProjectionDraft): Settings {
  return {
    locale: draft.locale,
    theme: draft.theme,
    snap_to_grid: draft.snapToGrid,
    plant_spacing_interval_m: draft.plantSpacingIntervalM,
    last_view: draft.lastView,
    side_panel_width: draft.sidePanel.width,
    saved_stamps_frame_height: draft.savedStamps.frameHeight,
    basemap_style: draft.mapLayers.basemap.style,
    basemap_visible: draft.mapLayers.basemap.visible,
    basemap_opacity: draft.mapLayers.basemap.opacity,
    satellite_visible: draft.mapLayers.satellite.visible,
    satellite_opacity: draft.mapLayers.satellite.opacity,
    google_maps_api_key: trimmedKey(draft.googleMapsApiKey),
    satellite_source: draft.satelliteSource,
    contour_visible: draft.mapLayers.contours.visible,
    contour_opacity: draft.mapLayers.contours.opacity,
    contour_interval: draft.mapLayers.contours.intervalMeters,
    hillshade_visible: draft.mapLayers.hillshade.visible,
    hillshade_opacity: draft.mapLayers.hillshade.opacity,
    soften_background: draft.mapLayers.softenBackground,
    used_canvas_tools: [...draft.toolRail.usedTools],
    tool_names_visible: draft.toolRail.namesVisible,
    single_key_shortcuts: draft.singleKeyShortcuts,
    scroll_wheel: draft.scrollWheel,
    new_design_satellite: draft.newDesigns.satellite,
    new_design_symbol_scale: draft.newDesigns.symbolScale,
    new_design_labels: draft.newDesigns.labels,
  }
}

function sameNewDesignDefaults(left: NewDesignDefaults, right: NewDesignDefaults): boolean {
  return left.satellite === right.satellite
    && left.symbolScale === right.symbolScale
    && left.labels === right.labels
}

function normalizeLastView(view: LastView | null): LastView | null {
  if (!view) return null
  const { lon, lat, zoom } = view
  if (![lon, lat, zoom].every(Number.isFinite)) return null
  if (lon < -180 || lon > 180 || Math.abs(lat) > WEB_MERCATOR_MAX_LATITUDE_DEG) return null
  return { lon, lat, zoom }
}

function sameLastView(left: LastView | null | undefined, right: LastView | null | undefined): boolean {
  if (!left || !right) return !left && !right
  return left.lon === right.lon && left.lat === right.lat && left.zoom === right.zoom
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function settingsEqual(left: Settings, right: Settings): boolean {
  const leftKeys = Object.keys(left) as Array<keyof Settings>
  if (leftKeys.length !== Object.keys(right).length) return false

  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(right, key)
    && sameSettingValue(key, left, right)
  ))
}

function sameSettingValue(key: keyof Settings, left: Settings, right: Settings): boolean {
  if (key === 'last_view') return sameLastView(left.last_view, right.last_view)
  if (key === 'used_canvas_tools') return sameStrings(left.used_canvas_tools, right.used_canvas_tools)
  return Object.is(left[key], right[key])
}

function currentSettingsSnapshot(): Settings {
  return settingsFromDraft(normalizeDraft(createDraftFromProjection()))
}

function projectSettingsToSignals(settings: Settings): Settings {
  const draft = normalizeDraft({
    locale: settings.locale,
    theme: settings.theme,
    googleMapsApiKey: settings.google_maps_api_key ?? null,
    // A record from before the choice existed uses a saved key.
    satelliteSource: settings.satellite_source ?? (trimmedKey(settings.google_maps_api_key ?? null) ? 'google_key' : 'free'),
    snapToGrid: settings.snap_to_grid,
    plantSpacingIntervalM: settings.plant_spacing_interval_m,
    lastView: settings.last_view ?? null,
    sidePanel: {
      width: settings.side_panel_width,
    },
    savedStamps: {
      frameHeight: normalizeSavedStampsFrameHeight(settings.saved_stamps_frame_height),
    },
    mapLayers: {
      basemap: {
        style: settings.basemap_style,
        visible: settings.basemap_visible,
        opacity: settings.basemap_opacity,
      },
      satellite: {
        visible: settings.satellite_visible,
        opacity: settings.satellite_opacity,
      },
      contours: {
        visible: settings.contour_visible,
        opacity: settings.contour_opacity,
        intervalMeters: settings.contour_interval,
      },
      hillshade: {
        visible: settings.hillshade_visible,
        opacity: settings.hillshade_opacity,
      },
      softenBackground: settings.soften_background,
    },
    toolRail: {
      usedTools: settings.used_canvas_tools,
      namesVisible: settings.tool_names_visible ?? null,
    },
    singleKeyShortcuts: settings.single_key_shortcuts,
    scrollWheel: settings.scroll_wheel,
    newDesigns: {
      satellite: settings.new_design_satellite,
      symbolScale: settings.new_design_symbol_scale,
      labels: settings.new_design_labels,
    },
  })
  applyDraftToProjection(draft)
  return settingsFromDraft(draft)
}

function clearQueuedPersist(projection: ActiveSettingsProjection | null): void {
  if (!projection || projection.queuedPersistTimer === null) return
  globalThis.clearTimeout(projection.queuedPersistTimer)
  projection.queuedPersistTimer = null
}

async function drainPersistence(projection: ActiveSettingsProjection): Promise<void> {
  while (!projection.disposed && projection.requested) {
    const next = projection.requested
    projection.requested = null
    projection.saving = next

    try {
      await projection.adapter.save(next)
    } catch (error) {
      projection.saving = null
      if (!projection.requested) projection.requested = next
      projection.retryBlocked = true
      projection.persistenceError = error
      console.error('Failed to persist settings:', error)
      return
    }

    if (projection.disposed) return
    projection.durable = next
    projection.saving = null
    if (projection.requested && settingsEqual(projection.requested, next)) {
      projection.requested = null
    }
  }
}

function ensurePersistenceDrain(projection: ActiveSettingsProjection): void {
  if (
    projection.disposed
    || projection.retryBlocked
    || projection.draining
    || !projection.requested
  ) return

  projection.draining = true
  const drainPromise = drainPersistence(projection)
  projection.drainPromise = drainPromise
  const finishDrain = () => {
    if (projection.drainPromise !== drainPromise) return
    projection.drainPromise = null
    projection.draining = false
    if (projection.requested && !projection.retryBlocked) {
      ensurePersistenceDrain(projection)
    }
  }
  void drainPromise.then(finishDrain, finishDrain)
}

function admitPersistenceSnapshot(
  projection: ActiveSettingsProjection,
  settings: Settings,
): void {
  // A record that could not be read is never written over (SET-05, 2.1-Q67): only a read record admits a write.
  if (projection.disposed || projection.retiring || !projection.durable) return
  projection.retryBlocked = false
  projection.persistenceError = null

  if (
    !projection.saving
    && projection.durable
    && settingsEqual(settings, projection.durable)
  ) {
    projection.requested = null
    return
  }

  projection.requested = settings
  ensurePersistenceDrain(projection)
}

async function waitForPersistence(projection: ActiveSettingsProjection): Promise<void> {
  while (projection.draining) {
    const drainPromise = projection.drainPromise
    if (drainPromise) {
      await drainPromise
    } else {
      await Promise.resolve()
    }
  }

  if (projection.retryBlocked) {
    throw projection.persistenceError ?? new Error('Failed to persist settings')
  }
}

function persistProjection(mode: SettingsPersistMode, delayMs = DEFAULT_QUEUED_PERSIST_DELAY_MS): void {
  if (mode === 'none' || !sourceSettings) return
  const projection = activeSettingsProjection
  if (!projection || projection.disposed || !projection.durable) return

  const updated = snapshotSettingsProjection()
  if (
    !projection.saving
    && !projection.requested
    && settingsEqual(updated, projection.durable)
  ) {
    clearQueuedPersist(projection)
    return
  }

  if (mode === 'immediate') {
    clearQueuedPersist(projection)
    admitPersistenceSnapshot(projection, updated)
    return
  }

  clearQueuedPersist(projection)
  projection.queuedPersistTimer = globalThis.setTimeout(() => {
    projection.queuedPersistTimer = null
    if (
      projection !== activeSettingsProjection
      || projection.disposed
      || !sourceSettings
      || !projection.durable
    ) return

    const queued = snapshotSettingsProjection()
    admitPersistenceSnapshot(projection, queued)
  }, delayMs)
}

function preservePendingHydrationIntent(projection: ActiveSettingsProjection): void {
  if (projection.durable || !projection.pendingHydrationPersistence) return
  pendingHydrationIntent = {
    fallback: projection.fallback,
    patch: { ...projection.pendingHydrationPatch },
    persist: true,
  }
}

function handOffFailedRetirement(projection: ActiveSettingsProjection): void {
  const desired = projection.requested ?? projection.saving
  if (!desired) return

  const successor = activeSettingsProjection
  if (successor && successor !== projection && !successor.disposed && !successor.retiring) {
    if (!successor.durable) {
      successor.pendingHydrationPatch = {
        ...desired,
        ...successor.pendingHydrationPatch,
      }
      successor.pendingHydrationPersistence = true
      return
    }

    admitPersistenceSnapshot(successor, currentSettingsSnapshot())
    return
  }

  const pending = pendingHydrationIntent
  pendingHydrationIntent = {
    fallback: pending?.fallback ?? desired,
    patch: {
      ...desired,
      ...pending?.patch,
    },
    persist: true,
  }
}

function trackSettingsRetirement(retirement: Promise<void>): void {
  const previous = pendingSettingsRetirement
  const tracked = previous
    ? Promise.all([previous, retirement]).then(() => undefined)
    : retirement
  pendingSettingsRetirement = tracked
  void tracked.then(() => {
    if (pendingSettingsRetirement === tracked) pendingSettingsRetirement = null
  })
}

function retireSettingsProjection(projection: ActiveSettingsProjection): void {
  if (projection.disposed || projection.retiring) return

  preservePendingHydrationIntent(projection)
  clearQueuedPersist(projection)
  if (activeSettingsProjection === projection && projection.durable && sourceSettings) {
    admitPersistenceSnapshot(projection, currentSettingsSnapshot())
  }
  projection.retiring = true
  projection.resolveRetired()
  if (activeSettingsProjection === projection) {
    activeSettingsProjection = null
    sourceSettings = null
  }

  const finishRetirement = () => {
    projection.disposed = true
    projection.requested = null
    projection.saving = null
  }
  if (!projection.draining) {
    finishRetirement()
    return
  }

  const retirement = waitForPersistence(projection)
    .catch(() => handOffFailedRetirement(projection))
    .then(finishRetirement)
  trackSettingsRetirement(retirement)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as PromiseLike<unknown>).then === 'function'
}

function applyLoadedSettings(
  projection: ActiveSettingsProjection,
  settings: Settings,
): void {
  if (activeSettingsProjection !== projection || projection.retiring || projection.disposed) return

  clearQueuedPersist(projection)
  const durable = projectSettingsToSignals(settings)
  sourceSettings = durable
  projection.durable = durable
  projection.requested = null
  projection.retryBlocked = false
  projection.persistenceError = null

  const pendingPatch = projection.pendingHydrationPatch
  const shouldPersist = projection.pendingHydrationPersistence
  projection.pendingHydrationPatch = {}
  projection.pendingHydrationPersistence = false
  if (Object.keys(pendingPatch).length === 0) return

  const desired = projectSettingsToSignals({ ...durable, ...pendingPatch })
  sourceSettings = durable
  if (shouldPersist && !settingsEqual(desired, durable)) {
    admitPersistenceSnapshot(projection, desired)
  }
}

function isCurrentProjection(projection: ActiveSettingsProjection): boolean {
  return activeSettingsProjection === projection && !projection.retiring && !projection.disposed
}

function admitLoadedSettings(projection: ActiveSettingsProjection, settings: Settings): void {
  applyLoadedSettings(projection, settings)
  if (isCurrentProjection(projection)) writeStoreHealth('settings', { status: { kind: 'ready' }, notice: null })
}

/**
 * Reads the record, again after each pause of `delays` (SET-05, 2.1-Q67, 2.1-Q295); after the last the session runs on
 * the defaults and the platform's first run (2.1-Q309) with `durable` null, so every change stays in memory, never
 * written over the record (2.1-M473), and the health model says `settings` is unavailable, told once with Try again.
 */
function readSettings(projection: ActiveSettingsProjection, first: Promise<Settings>, delays: readonly number[]) {
  const current = () => isCurrentProjection(projection)
  return readWithRetry(first, () => projection.adapter.load(), delays, current).then(
    (settings) => admitLoadedSettings(projection, settings),
    (error: unknown) => {
      if (current()) {
        const firstRun = withFirstRunSettings(projection.adapter, currentSettingsSnapshot(), projection.pendingHydrationPatch)
        if (firstRun) projectSettingsToSignals(firstRun)
        sourceSettings = projection.fallback
        const code = readFailureCode(error)
        reportFailure(error, { shown: 'none', source: 'settings.load', code })
        writeStoreHealth('settings', { status: { kind: 'unavailable', code }, notice: null })
      }
      throw error
    },
  )
}

/** The first read answers synchronously when the adapter does, so hydration can be immediate. */
function loadSettingsProjection(projection: ActiveSettingsProjection): void | Promise<void> {
  if (!isCurrentProjection(projection)) return
  let loaded: Settings | Promise<Settings>
  try { loaded = projection.adapter.load() } catch (error) { loaded = Promise.reject(error) }
  if (!isPromiseLike(loaded)) return admitLoadedSettings(projection, loaded)
  return readSettings(projection, Promise.resolve(loaded), SETTINGS_LOAD_RETRY_DELAYS_MS)
}

/** Try again (2.1-Q295): once read, the session's changes are applied over the record and saved; resolves false when the read failed again. */
export function retrySettingsLoad(): Promise<boolean> {
  const projection = activeSettingsProjection
  if (!projection || projection.durable || !isCurrentProjection(projection)) return Promise.resolve(true)
  if (projection.retrying) return projection.retrying
  const retrying = readSettings(projection, Promise.resolve().then(() => projection.adapter.load()), [])
    .then(() => true, () => false)
    .finally(() => { projection.retrying = null })
  projection.retrying = retrying
  return retrying
}

export function installSettingsProjection(
  adapter: SettingsPlatformAdapter,
): SettingsProjectionInstallation {
  if (activeSettingsProjection) retireSettingsProjection(activeSettingsProjection)

  const inheritedIntent = pendingHydrationIntent
  pendingHydrationIntent = null
  const fallback = inheritedIntent?.fallback ?? { ...currentSettingsSnapshot(), ...adapter.firstRunSettings?.() }
  let resolveRetired!: () => void
  const retired = new Promise<void>((resolve) => { resolveRetired = resolve })

  const projection: ActiveSettingsProjection = {
    adapter,
    disposed: false,
    retiring: false,
    durable: null,
    requested: null,
    saving: null,
    queuedPersistTimer: null,
    drainPromise: null,
    draining: false,
    retryBlocked: false,
    persistenceError: null,
    pendingHydrationPatch: { ...inheritedIntent?.patch },
    pendingHydrationPersistence: inheritedIntent?.persist ?? false,
    fallback,
    retired,
    resolveRetired,
    ready: null,
    retrying: null,
  }
  activeSettingsProjection = projection
  sourceSettings = null

  const retirement = pendingSettingsRetirement
  const loaded = retirement
    ? retirement.then(() => loadSettingsProjection(projection))
    : loadSettingsProjection(projection)
  const ready = isPromiseLike(loaded) ? Promise.resolve(loaded).then(() => undefined) : Promise.resolve()
  projection.ready = ready
  if (isPromiseLike(loaded)) projection.retrying = ready.then(() => true, () => false).finally(() => (projection.retrying = null))

  return {
    ready,
    dispose: () => retireSettingsProjection(projection),
  }
}

/** @testonly */ export function hydrateSettingsProjectionForTests(settings: Settings): void {
  const projection = activeSettingsProjection
  clearQueuedPersist(projection)
  const normalizedSettings = projectSettingsToSignals(settings)
  sourceSettings = normalizedSettings
  if (projection && !projection.disposed) {
    projection.durable = normalizedSettings
    projection.requested = null
    projection.retryBlocked = false
    projection.persistenceError = null
    projection.pendingHydrationPatch = {}
    projection.pendingHydrationPersistence = false
  }
}

export function primeThemeProjectionFromFirstPaintCache(cachedTheme: Theme): void {
  theme.value = normalizeTheme(cachedTheme)
}

export function snapshotSettingsProjection(): Settings {
  if (!sourceSettings) {
    throw new Error('Cannot snapshot settings before settings bootstrap')
  }
  return currentSettingsSnapshot()
}

export function mutateSettingsProjection(
  mutate: (draft: SettingsProjectionDraft) => void,
  options: MutateSettingsProjectionOptions = {},
): void {
  const draft = createDraftFromProjection()
  const before = settingsFromDraft(normalizeDraft(draft))
  mutate(draft)
  const normalized = normalizeDraft(draft)
  applyDraftToProjection(normalized)
  const persistMode = options.persist ?? 'immediate'
  const projection = activeSettingsProjection
  if (projection && !projection.durable && persistMode !== 'none') {
    const updated = settingsFromDraft(normalized)
    let changed = false
    for (const key of Object.keys(updated) as Array<keyof Settings>) {
      if (!sameSettingValue(key, before, updated)) {
        ;(projection.pendingHydrationPatch as Record<string, unknown>)[key] = updated[key]
        changed = true
      }
    }
    if (changed) projection.pendingHydrationPersistence = true
    return
  }

  persistProjection(persistMode, options.delayMs)
}

export async function flushSettingsProjection(): Promise<void> {
  while (activeSettingsProjection) {
    const projection = activeSettingsProjection
    if (!projection.durable || !sourceSettings) {
      if (!projection.ready) return
      await Promise.race([
        projection.ready.catch(() => undefined),
        projection.retired,
      ])
      if (activeSettingsProjection !== projection) continue
      if (!projection.durable || !sourceSettings) return
    }

    clearQueuedPersist(projection)
    admitPersistenceSnapshot(projection, currentSettingsSnapshot())
    try {
      await waitForPersistence(projection)
    } catch (error) {
      if (activeSettingsProjection && activeSettingsProjection !== projection) continue
      throw error
    }
    if (activeSettingsProjection !== projection) continue
    const latest = currentSettingsSnapshot()
    if (
      projection.queuedPersistTimer !== null
      || projection.saving !== null
      || projection.requested !== null
      || !projection.durable
      || !settingsEqual(latest, projection.durable)
    ) continue
    return
  }
}

/** @testonly */ export function resetSettingsProjectionForTests(): void {
  if (activeSettingsProjection) {
    activeSettingsProjection.disposed = true
    activeSettingsProjection.resolveRetired()
    clearQueuedPersist(activeSettingsProjection)
    activeSettingsProjection.requested = null
  }
  activeSettingsProjection = null
  sourceSettings = null
  pendingSettingsRetirement = null
  pendingHydrationIntent = null
}
