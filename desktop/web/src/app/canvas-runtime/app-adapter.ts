import { effect, signal, type ReadonlySignal } from '@preact/signals'
import type {
  CanvasRuntimeAppAdapter,
  CanvasRuntimePresentationDataAdapter,
  CanvasRuntimeSavedObjectStampAdapter,
} from '../../canvas/runtime/app-adapter'
import type { CanvasMapBackdrop } from '../../canvas/runtime/scene-visuals'
import { effectiveBackgroundOpacity, mapBackgroundOf, type MapLayersState } from '../map-layers/state'
import { presentedMapLayers, storyPresentationHidesEditingAids, storyPresentationOverrides } from '../story-presentation/overrides'
import { gridVisible, snapToGridEnabled } from '../canvas-settings/signals'
import { mutateSettingsProjection } from '../settings/projection'
import { lastView, locale, plantSpacingIntervalM, scrollWheel, theme } from '../settings/state'
import { composeDocumentForSave } from '../contracts/document'
import { designSessionStore, setCanvasClean } from '../document-session/store'
import { closeCanvasContextMenu, openCanvasContextMenu } from '../canvas-context-menu/state'
import { t } from '../../i18n'
import { currentPlantDisplay } from '../plant-display/state'
import { focusOwner } from '../keyboard/focus-owner'

export interface CanvasRuntimeAppCapabilities {
  readonly presentationData: CanvasRuntimePresentationDataAdapter
  readonly savedObjectStamps?: CanvasRuntimeSavedObjectStampAdapter
  /**
   * The Site data pin, supplied by the edition that has Site data (Desktop).
   *
   * It is a capability rather than an import because importing it here would
   * pull the raster IPC and library store into the browser workspace graph,
   * which the architecture guard forbids: Web has no raster capability.
   */
  readonly pinAt?: (point: { readonly x: number; readonly y: number }) => void
  /** The Site data profile, supplied by the edition that has Site data (Desktop), for the same reason. */
  readonly finishProfile?: (points: readonly { readonly x: number; readonly y: number }[]) => void
}

export function createAppCanvasRuntimeAppAdapter(
  capabilities: CanvasRuntimeAppCapabilities,
): CanvasRuntimeAppAdapter {
  return {
    cleanState: { setCanvasClean },
    // A Design a newer Canopi saved shows read-only (2.1-M478): the Scene authority refuses every edit over it.
    isReadOnly: () => designSessionStore.isReadOnly(),
    // A tool's focus request and a closed text entry focus the map through the one focus owner.
    focus: focusOwner,
    document: { composeDocumentForSave },
    contextMenu: { open: openCanvasContextMenu, close: closeCanvasContextMenu },
    // Called per tap, so opening or closing the Site data panel needs no runtime
    // rebuild; undefined in an edition that has no raster capability.
    pinAt: capabilities.pinAt,
    finishProfile: capabilities.finishProfile,
    savedObjectStamps: capabilities.savedObjectStamps,
    presentationData: capabilities.presentationData,
    plantDisplay: {
      // A presented story step shows its own labels; the Design's choice is untouched.
      subscribe: (onChange) => effect(() => {
        const display = currentPlantDisplay.value
        const labels = storyPresentationOverrides.value?.plantLabels
        onChange(labels && labels !== display.labels ? { ...display, labels } : display)
      }),
    },
    translate: t,
    reducedMotion: reducedMotionPreference(),
    settings: {
      readLocale: () => locale.value,
      // Presenting a story shows the map without the grid.
      readChromeOverlay: () => ({ gridVisible: gridVisible.value && !storyPresentationHidesEditingAids.value }),
      readSnapToGridEnabled: () => snapToGridEnabled.value,
      readScrollWheel: () => scrollWheel.peek(),
      readPlantSpacingIntervalMeters: () => plantSpacingIntervalM.value,
      readLastView: () => lastView.peek(),
      commitPlantSpacingIntervalMeters: (meters) => {
        mutateSettingsProjection((settings) => {
          settings.plantSpacingIntervalM = meters
        }, { persist: 'immediate' })
      },
      toggleGridVisible: () => {
        gridVisible.value = !gridVisible.value
      },
      toggleSnapToGrid: () => {
        mutateSettingsProjection((settings) => {
          settings.snapToGrid = !settings.snapToGrid
        }, { persist: 'immediate' })
      },
      subscribeTheme: (onChange) => effect(() => {
        void theme.value
        onChange()
      }),
      subscribeLocale: (onChange) => effect(() => {
        void locale.value
        onChange()
      }),
      subscribeChromeOverlay: (onChange) => effect(() => {
        void gridVisible.value
        void storyPresentationHidesEditingAids.value
        onChange()
      }),
      subscribeMapBackdrop: (onChange) => effect(() => {
        onChange(mapBackdropOf(presentedMapLayers()))
      }),
    },
  }
}

let reducedMotion: { readonly source: unknown; readonly preference: ReadonlySignal<boolean> } | null = null

/**
 * The platform's prefers-reduced-motion: reduce, live: the runtime's flights (saved views, stories, places) jump instead of flying
 * while it is true; turns always jump (U34, spec §4.3).
 * One query listener per matchMedia (the app's lifetime; a test that stubs matchMedia gets its own).
 */
function reducedMotionPreference(): ReadonlySignal<boolean> {
  const matchMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia : null
  if (reducedMotion?.source === matchMedia) return reducedMotion.preference
  const query = matchMedia?.call(window, '(prefers-reduced-motion: reduce)') ?? null
  const preference = signal(query?.matches ?? false)
  query?.addEventListener?.('change', (event) => {
    preference.value = event.matches
  })
  reducedMotion = { source: matchMedia, preference }
  return preference
}

/** Below half opacity a background mostly lets the map's light paper through. */
const BACKDROP_OPACITY_THRESHOLD = 0.5

function mapBackdropOf(state: MapLayersState): CanvasMapBackdrop {
  switch (mapBackgroundOf(state)) {
    case 'satellite':
      return effectiveBackgroundOpacity(state, 'satellite') < BACKDROP_OPACITY_THRESHOLD ? 'paper' : 'satellite'
    case 'basemap':
      if (effectiveBackgroundOpacity(state, 'basemap') < BACKDROP_OPACITY_THRESHOLD) return 'paper'
      return state.basemap.style === 'dark' ? 'dark-basemap' : 'basemap'
    case 'none':
      return 'paper'
  }
}
