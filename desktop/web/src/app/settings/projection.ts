import { batch } from '@preact/signals'
import type { LastView, SatelliteSource, ScrollWheel } from '../../generated/contracts'
import type { EditionCapabilitySet } from '../../generated/edition-capabilities'
import type { UnitSystem } from '../../generated/quantity-table'
import { readFailureCode, readWithRetry } from '../../failures/store-read'
import { storeHealth, writeStoreHealth } from '../../failures/health'
import { reportFailure } from '../../failures/report'
import type { Locale, Settings, Theme } from '../../types/settings'
import { withFirstRunSettings, type SettingsPlatformAdapter } from '../../platform/settings'
import { DEFAULT_SAVED_STAMPS_FRAME_HEIGHT, type SettingsValues } from './field-table'
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
  mapLayersFromSettings,
  mapLayersToSettingsFields,
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

interface ActiveSettingsProjection {
  readonly adapter: SettingsPlatformAdapter
  disposed: boolean
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
  ready: Promise<void> | null
  /** The first or a Try again read in flight; a press joins it, so one read lands and applies the session's changes. */
  retrying: Promise<boolean> | null
  unsubscribeExternal: (() => void) | null
}

const DEFAULT_QUEUED_PERSIST_DELAY_MS = 160
const SETTINGS_LOAD_RETRY_DELAYS_MS: readonly number[] = [100, 400] // SET-05: a busy store gets two more reads

let sourceSettings: SettingsValues | null = null
let activeSettingsProjection: ActiveSettingsProjection | null = null

const trimmedKey = (value: string | null | undefined): string | null => value?.trim() || null

const SCALAR_BINDINGS: readonly [keyof SettingsValues, keyof SettingsProjectionDraft, { value: unknown }, boolean?][] = [
  ['locale', 'locale', locale],
  ['theme', 'theme', theme],
  ['unit_system', 'unitSystem', unitSystem],
  ['snap_to_grid', 'snapToGrid', snapToGridEnabled],
  ['plant_spacing_interval_m', 'plantSpacingIntervalM', plantSpacingIntervalM],
  ['last_view', 'lastView', lastView, true],
  ['last_open_home', 'lastOpenHome', lastOpenHome],
  ['single_key_shortcuts', 'singleKeyShortcuts', singleKeyShortcuts],
  ['scroll_wheel', 'scrollWheel', scrollWheel],
  ['launch_check', 'launchCheck', launchCheck],
]

const setIfChanged = <T>(sig: { value: T }, next: T): void => {
  if (JSON.stringify(sig.value) !== JSON.stringify(next)) sig.value = next
}

function flattenGroups(layers: MapLayersState, nd: NewDesignDefaults) {
  return {
    ...mapLayersToSettingsFields(layers),
    new_design_satellite: nd.satellite,
    new_design_symbol_scale: nd.symbolScale,
    new_design_labels: nd.labels,
  }
}

function readLiveValues(trimKey = true): SettingsValues {
  const out: Record<string, unknown> = {
    ...flattenGroups(mapLayers.value, newDesignDefaults.value),
    side_panel_width: sidePanelWidth.value,
    saved_stamps_frame_height: savedStampsFrameHeight.value,
    google_maps_api_key: trimKey ? trimmedKey(googleMapsApiKey.value) : googleMapsApiKey.value,
    satellite_source: satelliteSource.value,
    used_canvas_tools: [...usedCanvasTools.value],
    tool_names_visible: toolNamesVisible.value,
  }
  for (const [k, , sig] of SCALAR_BINDINGS) out[k] = sig.value
  return out as unknown as SettingsValues
}

function createDraftFromValues(v: SettingsValues, rawKey: string | null = v.google_maps_api_key ?? null): SettingsProjectionDraft {
  const out: Record<string, unknown> = {
    googleMapsApiKey: rawKey,
    satelliteSource: v.satellite_source ?? (trimmedKey(v.google_maps_api_key) ? 'google_key' : 'free'),
    sidePanel: { width: v.side_panel_width },
    savedStamps: { frameHeight: v.saved_stamps_frame_height ?? DEFAULT_SAVED_STAMPS_FRAME_HEIGHT },
    mapLayers: mapLayersFromSettings(v),
    toolRail: { usedTools: v.used_canvas_tools, namesVisible: v.tool_names_visible },
    newDesigns: { satellite: v.new_design_satellite, symbolScale: v.new_design_symbol_scale, labels: v.new_design_labels },
  }
  for (const [k, dk] of SCALAR_BINDINGS) out[dk] = v[k]
  return out as unknown as SettingsProjectionDraft
}

function valuesFromDraft(draft: SettingsProjectionDraft): SettingsValues {
  const out: Record<string, unknown> = {
    ...flattenGroups(normalizeMapLayers(draft.mapLayers), draft.newDesigns),
    side_panel_width: Number.isFinite(draft.sidePanel.width) ? Math.round(draft.sidePanel.width!) : null,
    saved_stamps_frame_height: Number.isFinite(draft.savedStamps.frameHeight) ? Math.round(draft.savedStamps.frameHeight) : DEFAULT_SAVED_STAMPS_FRAME_HEIGHT,
    google_maps_api_key: trimmedKey(draft.googleMapsApiKey),
    satellite_source: draft.satelliteSource === 'google_key' ? 'google_key' : 'free',
    used_canvas_tools: [...draft.toolRail.usedTools],
    tool_names_visible: draft.toolRail.namesVisible,
  }
  for (const [k, dk] of SCALAR_BINDINGS) out[k] = draft[dk]
  return normalizeSettingsValues(out)
}

function applyValuesToSignals(v: SettingsValues, rawKey: string | null = v.google_maps_api_key ?? null): SettingsValues {
  const draft = createDraftFromValues(v, rawKey)
  batch(() => {
    for (const [, dk, sig, deep] of SCALAR_BINDINGS) {
      if (deep) setIfChanged(sig, draft[dk])
      else sig.value = draft[dk]
    }
    googleMapsApiKey.value = draft.googleMapsApiKey
    satelliteSource.value = draft.satelliteSource
    sidePanelWidth.value = draft.sidePanel.width
    savedStampsFrameHeight.value = draft.savedStamps.frameHeight
    setIfChanged(mapLayers, draft.mapLayers)
    setIfChanged(usedCanvasTools, draft.toolRail.usedTools)
    toolNamesVisible.value = draft.toolRail.namesVisible
    setIfChanged(newDesignDefaults, draft.newDesigns)
  })
  return { ...v, satellite_source: draft.satelliteSource, saved_stamps_frame_height: draft.savedStamps.frameHeight }
}

function projectSettingsToSignals(settings: Partial<SettingsValues> & Settings): SettingsValues {
  const normalized = normalizeSettingsValues({
    ...settings,
    contour_interval: Number.isFinite(settings.contour_interval) ? Math.max(0, Math.round(settings.contour_interval)) : 0,
  })
  return applyValuesToSignals(normalized)
}

function currentSettingsSnapshot(): SettingsValues {
  return normalizeSettingsValues(readLiveValues(true))
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
      await (projection.adapter.savePatch
        ? projection.adapter.savePatch(patch, next)
        : projection.adapter.save(next))
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
  if (projection.disposed || !projection.durable || projection.writesRefused) return
  projection.retryBlocked = false
  projection.persistenceError = null

  if (!projection.saving && settingsValuesEqual(settings, projection.durable)) {
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
    if (projection !== activeSettingsProjection || projection.disposed || !sourceSettings || !projection.durable) return
    admitPersistenceSnapshot(projection, currentSettingsSnapshot())
  }, delayMs)
}

/**
 * HMR flush-and-drop (canopi-f47t.52.13): fires one best-effort flush of any pending
 * dirty state on the retiring projection, unsubscribes external listeners, and drops
 * the instance immediately without handing off state to any successor.
 */
function retireSettingsProjection(projection: ActiveSettingsProjection): void {
  if (projection.disposed) return
  projection.unsubscribeExternal?.()
  projection.unsubscribeExternal = null
  clearQueuedPersist(projection)
  if (activeSettingsProjection === projection && projection.durable && sourceSettings) {
    admitPersistenceSnapshot(projection, currentSettingsSnapshot())
  }
  projection.disposed = true
  projection.requested = null
  if (activeSettingsProjection === projection) {
    activeSettingsProjection = null
    sourceSettings = null
  }
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return v != null && (typeof v === 'object' || typeof v === 'function') && typeof (v as PromiseLike<unknown>).then === 'function'
}

function isCurrentProjection(projection: ActiveSettingsProjection): boolean {
  return activeSettingsProjection === projection && !projection.disposed
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

// A settled read makes settings ready, raising `fields_reset` with field names when any field had to be reset
// (2.1-Q54, Q361), never overwriting a `newer_read_only` status the adapter reported (2.1-Q320).
function admitLoadedSettings(projection: ActiveSettingsProjection, outcome: Settings): void {
  const decoded = decodeSettingsRecord({ ...outcome })
  const resetFields = [...new Set<string>([...(projection.adapter.takeResetFields?.() ?? []), ...decoded.resetFields])]
  const firstRunStamp = projection.adapter.takeFirstRunStamp?.() ?? null

  applyLoadedSettings(projection, decoded.values)
  if (!isCurrentProjection(projection)) return

  // 2.1-Q169: stamp `unit_system` once on first run so a later browser language change keeps it.
  if (firstRunStamp && Object.keys(firstRunStamp).length > 0 && projection.adapter.savePatch && !projection.writesRefused) {
    void projection.adapter.savePatch(firstRunStamp, decoded.values).catch(() => undefined)
  }

  if (storeHealth.peek().settings?.status.kind === 'newer_read_only') return
  writeStoreHealth(
    'settings',
    { status: { kind: 'ready' }, notice: resetFields.length > 0 ? 'fields_reset' : null },
    resetFields,
  )
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

  const fallback = normalizeSettingsValues({
    ...currentSettingsSnapshot(),
    ...(adapter.firstRunSettings?.() as Partial<SettingsValues>),
  })

  const projection: ActiveSettingsProjection = {
    adapter,
    disposed: false,
    durable: null,
    requested: null,
    saving: null,
    queuedPersistTimer: null,
    drainPromise: null,
    draining: false,
    retryBlocked: false,
    persistenceError: null,
    writesRefused: false,
    pendingHydrationPatch: {},
    pendingHydrationPersistence: false,
    fallback,
    ready: null,
    retrying: null,
    unsubscribeExternal: null,
  }
  activeSettingsProjection = projection
  sourceSettings = null

  if (adapter.subscribe) {
    projection.unsubscribeExternal = adapter.subscribe(() => {
      if (
        !isCurrentProjection(projection)
        || !projection.durable
        || projection.saving
        || projection.requested
        || projection.queuedPersistTimer !== null
      ) return
      void Promise.resolve(loadSettingsProjection(projection)).catch(() => undefined)
    })
  }

  const loaded = loadSettingsProjection(projection)
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

/** Builds the live problem-report `settings_summary` strictly from `privacy: 'reported'` fields (ADR 0024). */
export function readSettingsReportSummary(capabilities?: EditionCapabilitySet): Record<string, unknown> {
  return buildSettingsReportSummary(currentSettingsSnapshot(), capabilities)
}

export function mutateSettingsProjection(
  mutate: (draft: SettingsProjectionDraft) => void,
  options: MutateSettingsProjectionOptions = {},
): void {
  const before = currentSettingsSnapshot()
  const draft = createDraftFromValues(before, googleMapsApiKey.value)
  mutate(draft)
  const after = applyValuesToSignals(valuesFromDraft(draft), draft.googleMapsApiKey)

  const persistMode = options.persist ?? 'immediate'
  const projection = activeSettingsProjection
  if (projection && !projection.disposed && !projection.durable) {
    const patch = diffSettingsPatch(before, after)
    if (Object.keys(patch).length > 0) {
      projection.pendingHydrationPatch = { ...projection.pendingHydrationPatch, ...patch }
      if (persistMode !== 'none') projection.pendingHydrationPersistence = true
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
        new Promise<void>((resolve) => { globalThis.setTimeout(resolve, 0) }),
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
    if (
      projection.queuedPersistTimer === null
      && !projection.saving
      && !projection.requested
      && projection.durable
      && settingsValuesEqual(currentSettingsSnapshot(), projection.durable)
    ) return
  }
}

/** @testonly */ export function resetSettingsProjectionForTests(): void {
  if (activeSettingsProjection) {
    activeSettingsProjection.unsubscribeExternal?.()
    activeSettingsProjection.unsubscribeExternal = null
    activeSettingsProjection.disposed = true
    clearQueuedPersist(activeSettingsProjection)
    activeSettingsProjection.requested = null
  }
  activeSettingsProjection = null
  sourceSettings = null
}
