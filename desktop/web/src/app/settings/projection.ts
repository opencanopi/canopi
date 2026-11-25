import { batch } from '@preact/signals'
import type { LastView, SatelliteSource, ScrollWheel } from '../../generated/contracts'
import type { UnitSystem } from '../../generated/quantity-table'
import { readFailureCode, readWithRetry } from '../../failures/store-read'
import { storeHealth, writeStoreHealth } from '../../failures/health'
import { reportFailure } from '../../failures/report'
import type { Locale, Settings, Theme } from '../../types/settings'
import {
  withFirstRunSettings,
  type SettingsPlatformAdapter,
} from '../../platform/settings'
import {
  DEFAULT_SAVED_STAMPS_FRAME_HEIGHT,
  DEFAULT_SETTINGS_VALUES,
  MAX_PLANT_SYMBOL_SCALE,
  MIN_FAVORITES_FRAME_HEIGHT,
  MIN_PLANT_SYMBOL_SCALE,
  MIN_SIDE_PANEL_WIDTH,
  type SettingsValues,
} from './field-table'
import {
  buildSettingsReportSummary,
  decodeSettingsRecord,
  diffSettingsPatch,
  normalizeSettingsValues,
  settingsValuesEqual,
} from './interpreter'
import {
  googleMapsApiKey,
  lastOpenHome,
  lastView,
  launchCheck,
  locale,
  mapLayers,
  mapLayersEqual,
  newDesignDefaults,
  normalizeMapLayers,
  plantSpacingIntervalM,
  satelliteSource,
  savedStampsFrameHeight,
  scrollWheel,
  sidePanelWidth,
  singleKeyShortcuts,
  snapToGridEnabled,
  theme,
  toolNamesVisible,
  unitSystem,
  usedCanvasTools,
  type MapLayersState,
  type NewDesignDefaults,
} from './state'

export type SettingsPersistMode = 'immediate' | 'queued' | 'none'

export interface SettingsProjectionDraft {
  locale: Locale
  theme: Theme
  unitSystem: UnitSystem
  googleMapsApiKey: string | null
  satelliteSource: SatelliteSource
  snapToGrid: boolean
  plantSpacingIntervalM: number
  lastView: LastView | null
  lastOpenHome: string | null
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
  launchCheck: boolean
}

interface MutateSettingsProjectionOptions {
  persist?: SettingsPersistMode
  delayMs?: number
}

export interface SettingsProjectionInstallation {
  readonly ready: Promise<void>
  dispose(): void
}

interface NormalizedLoad {
  readonly settings: SettingsValues
  readonly resetFields: readonly string[]
}

interface ActiveSettingsProjection {
  readonly adapter: SettingsPlatformAdapter
  disposed: boolean
  retiring: boolean
  durable: SettingsValues | null
  requested: SettingsValues | null
  saving: SettingsValues | null
  queuedPersistTimer: ReturnType<typeof globalThis.setTimeout> | null
  drainPromise: Promise<void> | null
  draining: boolean
  retryBlocked: boolean
  persistenceError: unknown | null
  /** A save refused as `store_read_only`: changes apply for the session, never written, logged or asked (2.1-Q320). */
  writesRefused: boolean
  pendingHydrationPatch: Partial<SettingsValues>
  pendingHydrationPersistence: boolean
  readonly fallback: SettingsValues
  readonly retired: Promise<void>
  readonly resolveRetired: () => void
  ready: Promise<void> | null
  /** The first or a Try again read in flight; a press joins it, so one read lands and applies the session's changes. */
  retrying: Promise<boolean> | null
  unsubscribeExternal: (() => void) | null
}

interface PendingHydrationIntent {
  readonly fallback: SettingsValues
  readonly patch: Partial<SettingsValues>
  readonly persist: boolean
}

const DEFAULT_QUEUED_PERSIST_DELAY_MS = 160
const SETTINGS_LOAD_RETRY_DELAYS_MS: readonly number[] = [100, 400] // SET-05: a busy store gets two more reads

let sourceSettings: SettingsValues | null = null
let activeSettingsProjection: ActiveSettingsProjection | null = null
let pendingSettingsRetirement: Promise<void> | null = null
let pendingHydrationIntent: PendingHydrationIntent | null = null

function trimmedKey(value: string | null): string | null {
  const key = value?.trim()
  return key ? key : null
}

function normalizeFrameHeight(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return DEFAULT_SAVED_STAMPS_FRAME_HEIGHT
  return Math.max(MIN_FAVORITES_FRAME_HEIGHT, Math.round(value))
}

function normalizeSidePanelWidth(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.round(value))
}

function clampSymbolScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS_VALUES.new_design_symbol_scale
  return Math.min(MAX_PLANT_SYMBOL_SCALE, Math.max(MIN_PLANT_SYMBOL_SCALE, value))
}

function createDraftFromProjection(): SettingsProjectionDraft {
  return {
    locale: locale.value,
    theme: theme.value,
    unitSystem: unitSystem.value,
    googleMapsApiKey: googleMapsApiKey.value,
    satelliteSource: satelliteSource.value,
    snapToGrid: snapToGridEnabled.value,
    plantSpacingIntervalM: plantSpacingIntervalM.value,
    lastView: lastView.value,
    lastOpenHome: lastOpenHome.value,
    sidePanel: { width: sidePanelWidth.value },
    savedStamps: { frameHeight: savedStampsFrameHeight.value },
    mapLayers: mapLayers.value,
    toolRail: { usedTools: usedCanvasTools.value, namesVisible: toolNamesVisible.value },
    singleKeyShortcuts: singleKeyShortcuts.value,
    scrollWheel: scrollWheel.value,
    newDesigns: newDesignDefaults.value,
    launchCheck: launchCheck.value,
  }
}

function valuesFromDraft(draft: SettingsProjectionDraft): SettingsValues {
  return {
    locale: draft.locale,
    theme: draft.theme,
    unit_system: draft.unitSystem,
    snap_to_grid: draft.snapToGrid,
    plant_spacing_interval_m: draft.plantSpacingIntervalM,
    last_view: draft.lastView,
    last_open_home: draft.lastOpenHome,
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
    launch_check: draft.launchCheck,
  }
}

function normalizeDraft(draft: SettingsProjectionDraft): SettingsProjectionDraft {
  const normalizedLayers = normalizeMapLayers(draft.mapLayers)
  // Normalize via the single settings field table, preserving untrimmed in-progress key edits.
  const norm = normalizeSettingsValues({
    ...valuesFromDraft({ ...draft, mapLayers: normalizedLayers }),
    side_panel_width: normalizeSidePanelWidth(draft.sidePanel.width),
    saved_stamps_frame_height: normalizeFrameHeight(draft.savedStamps.frameHeight),
    new_design_symbol_scale: clampSymbolScale(draft.newDesigns.symbolScale),
  })
  return {
    locale: norm.locale,
    theme: norm.theme,
    unitSystem: norm.unit_system,
    googleMapsApiKey: draft.googleMapsApiKey,
    satelliteSource: draft.satelliteSource === 'google_key' ? 'google_key' : 'free',
    snapToGrid: norm.snap_to_grid,
    plantSpacingIntervalM: norm.plant_spacing_interval_m,
    lastView: norm.last_view,
    lastOpenHome: norm.last_open_home,
    sidePanel: { width: norm.side_panel_width },
    savedStamps: { frameHeight: norm.saved_stamps_frame_height ?? DEFAULT_SAVED_STAMPS_FRAME_HEIGHT },
    mapLayers: normalizedLayers,
    toolRail: { usedTools: norm.used_canvas_tools, namesVisible: norm.tool_names_visible },
    singleKeyShortcuts: norm.single_key_shortcuts,
    scrollWheel: norm.scroll_wheel,
    newDesigns: {
      satellite: norm.new_design_satellite,
      symbolScale: norm.new_design_symbol_scale,
      labels: norm.new_design_labels,
    },
    launchCheck: norm.launch_check,
  }
}

function sameNewDesignDefaults(left: NewDesignDefaults, right: NewDesignDefaults): boolean {
  return left.satellite === right.satellite && left.symbolScale === right.symbolScale && left.labels === right.labels
}

function sameLastView(left: LastView | null | undefined, right: LastView | null | undefined): boolean {
  if (!left || !right) return !left && !right
  return left.lon === right.lon && left.lat === right.lat && left.zoom === right.zoom
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function applyDraftToProjection(draft: SettingsProjectionDraft): void {
  batch(() => {
    locale.value = draft.locale
    theme.value = draft.theme
    unitSystem.value = draft.unitSystem
    googleMapsApiKey.value = draft.googleMapsApiKey
    satelliteSource.value = draft.satelliteSource
    snapToGridEnabled.value = draft.snapToGrid
    plantSpacingIntervalM.value = draft.plantSpacingIntervalM
    if (!sameLastView(lastView.value, draft.lastView)) lastView.value = draft.lastView
    lastOpenHome.value = draft.lastOpenHome
    sidePanelWidth.value = draft.sidePanel.width
    savedStampsFrameHeight.value = draft.savedStamps.frameHeight
    if (!mapLayersEqual(mapLayers.value, draft.mapLayers)) mapLayers.value = draft.mapLayers
    if (!sameStrings(usedCanvasTools.value, draft.toolRail.usedTools)) usedCanvasTools.value = draft.toolRail.usedTools
    toolNamesVisible.value = draft.toolRail.namesVisible
    singleKeyShortcuts.value = draft.singleKeyShortcuts
    scrollWheel.value = draft.scrollWheel
    if (!sameNewDesignDefaults(newDesignDefaults.value, draft.newDesigns)) newDesignDefaults.value = draft.newDesigns
    launchCheck.value = draft.launchCheck
  })
}

function currentSettingsSnapshot(): SettingsValues {
  return valuesFromDraft(normalizeDraft(createDraftFromProjection()))
}

function projectSettingsToSignals(settings: Partial<SettingsValues> & Settings): SettingsValues {
  const full = normalizeSettingsValues(settings)
  const draft = normalizeDraft({
    locale: full.locale,
    theme: full.theme,
    unitSystem: full.unit_system,
    googleMapsApiKey: full.google_maps_api_key ?? null,
    // A record from before the choice existed uses a saved key.
    satelliteSource: full.satellite_source ?? (trimmedKey(full.google_maps_api_key ?? null) ? 'google_key' : 'free'),
    snapToGrid: full.snap_to_grid,
    plantSpacingIntervalM: full.plant_spacing_interval_m,
    lastView: full.last_view ?? null,
    lastOpenHome: full.last_open_home,
    sidePanel: { width: full.side_panel_width },
    savedStamps: { frameHeight: normalizeFrameHeight(full.saved_stamps_frame_height) },
    mapLayers: {
      basemap: { style: full.basemap_style, visible: full.basemap_visible, opacity: full.basemap_opacity },
      satellite: { visible: full.satellite_visible, opacity: full.satellite_opacity },
      contours: { visible: full.contour_visible, opacity: full.contour_opacity, intervalMeters: settings.contour_interval },
      hillshade: { visible: full.hillshade_visible, opacity: full.hillshade_opacity },
      softenBackground: full.soften_background,
    },
    toolRail: { usedTools: full.used_canvas_tools, namesVisible: full.tool_names_visible ?? null },
    singleKeyShortcuts: full.single_key_shortcuts,
    scrollWheel: full.scroll_wheel,
    newDesigns: {
      satellite: full.new_design_satellite,
      symbolScale: full.new_design_symbol_scale,
      labels: full.new_design_labels,
    },
    launchCheck: full.launch_check,
  })
  applyDraftToProjection(draft)
  return valuesFromDraft(draft)
}

function unpackLoadOutcome(projection: ActiveSettingsProjection, outcome: Settings): NormalizedLoad {
  const decoded = decodeSettingsRecord({ ...outcome })
  const adapterResets = projection.adapter.takeResetFields?.() ?? []
  const mergedReset = new Set<string>([...adapterResets, ...decoded.resetFields])
  return { settings: decoded.values, resetFields: [...mergedReset] }
}

function clearQueuedPersist(projection: ActiveSettingsProjection | null): void {
  if (!projection || projection.queuedPersistTimer === null) return
  globalThis.clearTimeout(projection.queuedPersistTimer)
  projection.queuedPersistTimer = null
}

async function drainPersistence(projection: ActiveSettingsProjection): Promise<void> {
  while (!projection.disposed && projection.requested) {
    const next = projection.requested
    const patch = projection.durable ? diffSettingsPatch(projection.durable, next) : { ...next }
    projection.requested = null
    projection.saving = next

    try {
      if (projection.adapter.savePatch) {
        await projection.adapter.savePatch(patch, next)
      } else {
        await projection.adapter.save(next)
      }
    } catch (error) {
      projection.saving = null
      if (readFailureCode(error).kind === 'store_read_only') {
        projection.writesRefused = true
        return
      }
      if (!projection.requested) projection.requested = next
      projection.retryBlocked = true
      projection.persistenceError = error
      console.error('Failed to persist settings:', error)
      return
    }

    if (projection.disposed) return
    projection.durable = next
    projection.saving = null
    if (projection.requested && settingsValuesEqual(projection.requested, next)) {
      projection.requested = null
    }
  }
}

function ensurePersistenceDrain(projection: ActiveSettingsProjection): void {
  if (
    projection.disposed
    || projection.retryBlocked
    || projection.writesRefused
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
    ensurePersistenceDrain(projection)
  }
  void drainPromise.then(finishDrain, finishDrain)
}

function admitPersistenceSnapshot(projection: ActiveSettingsProjection, settings: SettingsValues): void {
  // A record that could not be read is never written over (SET-05, 2.1-Q67): only a read record admits a write.
  if (projection.disposed || projection.retiring || !projection.durable || projection.writesRefused) return
  projection.retryBlocked = false
  projection.persistenceError = null

  if (!projection.saving && projection.durable && settingsValuesEqual(settings, projection.durable)) {
    projection.requested = null
    return
  }

  projection.requested = settings
  ensurePersistenceDrain(projection)
}

async function waitForPersistence(projection: ActiveSettingsProjection): Promise<void> {
  while (projection.draining) await (projection.drainPromise ?? Promise.resolve())
  if (projection.retryBlocked) {
    throw projection.persistenceError ?? new Error('Failed to persist settings')
  }
}

function persistProjection(mode: SettingsPersistMode, delayMs = DEFAULT_QUEUED_PERSIST_DELAY_MS): void {
  if (mode === 'none' || !sourceSettings) return
  const projection = activeSettingsProjection
  if (!projection || projection.disposed || !projection.durable) return

  const updated = currentSettingsSnapshot()
  if (!projection.saving && !projection.requested && settingsValuesEqual(updated, projection.durable)) {
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

    admitPersistenceSnapshot(projection, currentSettingsSnapshot())
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
      successor.pendingHydrationPatch = { ...desired, ...successor.pendingHydrationPatch }
      successor.pendingHydrationPersistence = true
      return
    }
    admitPersistenceSnapshot(successor, currentSettingsSnapshot())
    return
  }

  const pending = pendingHydrationIntent
  pendingHydrationIntent = {
    fallback: pending?.fallback ?? desired,
    patch: { ...desired, ...pending?.patch },
    persist: true,
  }
}

function trackSettingsRetirement(retirement: Promise<void>): void {
  const previous = pendingSettingsRetirement
  const tracked = previous ? Promise.all([previous, retirement]).then(() => undefined) : retirement
  pendingSettingsRetirement = tracked
  void tracked.then(() => {
    if (pendingSettingsRetirement === tracked) pendingSettingsRetirement = null
  })
}

function retireSettingsProjection(projection: ActiveSettingsProjection): void {
  if (projection.disposed || projection.retiring) return

  projection.unsubscribeExternal?.()
  projection.unsubscribeExternal = null
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

function isCurrentProjection(projection: ActiveSettingsProjection): boolean {
  return activeSettingsProjection === projection && !projection.retiring && !projection.disposed
}

function applyLoadedSettings(projection: ActiveSettingsProjection, settings: SettingsValues): void {
  if (!isCurrentProjection(projection)) return

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
  if (shouldPersist && !settingsValuesEqual(desired, durable)) admitPersistenceSnapshot(projection, desired)
}

// A settled read makes settings ready, raising `fields_reset` when any field had to be reset (2.1-Q54),
// never overwriting a `newer_read_only` status the adapter reported (2.1-Q320).
function admitLoadedSettings(projection: ActiveSettingsProjection, outcome: Settings): void {
  const { settings, resetFields } = unpackLoadOutcome(projection, outcome)
  applyLoadedSettings(projection, settings)
  if (!isCurrentProjection(projection) || storeHealth.peek().settings?.status.kind === 'newer_read_only') return
  writeStoreHealth('settings', {
    status: { kind: 'ready' },
    notice: resetFields.length > 0 ? 'fields_reset' : null,
  })
}

function readSettings(
  projection: ActiveSettingsProjection,
  first: Promise<Settings>,
  delays: readonly number[],
) {
  const current = () => isCurrentProjection(projection)
  return readWithRetry(first, () => projection.adapter.load(), delays, current).then(
    (outcome) => admitLoadedSettings(projection, outcome),
    (error: unknown) => {
      if (current()) {
        const firstRun = withFirstRunSettings(
          projection.adapter,
          currentSettingsSnapshot() as unknown as Record<string, unknown>,
          projection.pendingHydrationPatch as Readonly<Record<string, unknown>>,
        )
        if (firstRun) projectSettingsToSignals(firstRun as unknown as SettingsValues)
        sourceSettings = projection.fallback
        const code = readFailureCode(error)
        reportFailure(error, { shown: 'none', source: 'settings.load', code })
        writeStoreHealth('settings', { status: { kind: 'unavailable', code }, notice: null })
      }
      throw error
    },
  )
}

function loadSettingsProjection(projection: ActiveSettingsProjection): void | Promise<void> {
  if (!isCurrentProjection(projection)) return
  let loaded: Settings | Promise<Settings>
  try { loaded = projection.adapter.load() } catch (error) { loaded = Promise.reject(error) }
  if (!isPromiseLike(loaded)) return admitLoadedSettings(projection, loaded)
  return readSettings(projection, Promise.resolve(loaded), SETTINGS_LOAD_RETRY_DELAYS_MS)
}

/** Try again (2.1-Q295): once read, the session's changes are applied over the record and saved; resolves false on failure. */
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
  const fallback = inheritedIntent?.fallback
    ?? normalizeSettingsValues({ ...currentSettingsSnapshot(), ...(adapter.firstRunSettings?.() as Partial<SettingsValues>) })
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
    writesRefused: false,
    pendingHydrationPatch: { ...inheritedIntent?.patch },
    pendingHydrationPersistence: inheritedIntent?.persist ?? false,
    fallback,
    retired,
    resolveRetired,
    ready: null,
    retrying: null,
    unsubscribeExternal: null,
  }
  activeSettingsProjection = projection
  sourceSettings = null

  if (adapter.subscribe) {
    projection.unsubscribeExternal = adapter.subscribe(() => {
      if (!isCurrentProjection(projection) || !projection.durable || projection.saving || projection.requested) return
      void Promise.resolve(loadSettingsProjection(projection)).catch(() => undefined)
    })
  }

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

/** @testonly */ export function hydrateSettingsProjectionForTests(settings: Settings & Partial<SettingsValues>): void {
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
  theme.value = cachedTheme === 'dark' ? 'dark' : 'light'
}

export function snapshotSettingsProjection(): SettingsValues {
  if (!sourceSettings) {
    throw new Error('Cannot snapshot settings before settings bootstrap')
  }
  return currentSettingsSnapshot()
}

/** Builds the live problem-report `settings_summary` strictly from `privacy: 'reported'` fields (ADR 0024). */
export function readSettingsReportSummary(): Record<string, unknown> {
  return buildSettingsReportSummary(valuesFromDraft(createDraftFromProjection()))
}

export function mutateSettingsProjection(
  mutate: (draft: SettingsProjectionDraft) => void,
  options: MutateSettingsProjectionOptions = {},
): void {
  const draft = createDraftFromProjection()
  const before = valuesFromDraft(normalizeDraft(draft))
  mutate(draft)
  const normalized = normalizeDraft(draft)
  applyDraftToProjection(normalized)
  const persistMode = options.persist ?? 'immediate'
  const projection = activeSettingsProjection
  if (projection && !projection.durable && persistMode !== 'none') {
    const updated = valuesFromDraft(normalized)
    const patch = diffSettingsPatch(before, updated)
    if (Object.keys(patch).length > 0) {
      projection.pendingHydrationPatch = { ...projection.pendingHydrationPatch, ...patch }
      projection.pendingHydrationPersistence = true
    }
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
    if (projection.writesRefused) return
    const latest = currentSettingsSnapshot()
    if (
      projection.queuedPersistTimer !== null
      || projection.saving !== null
      || projection.requested !== null
      || !projection.durable
      || !settingsValuesEqual(latest, projection.durable)
    ) continue
    return
  }
}

/** @testonly */ export function resetSettingsProjectionForTests(): void {
  if (activeSettingsProjection) {
    activeSettingsProjection.unsubscribeExternal?.()
    activeSettingsProjection.unsubscribeExternal = null
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
