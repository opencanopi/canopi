import { computed, effect, signal, type ReadonlySignal } from '@preact/signals'
import type {
  CanvasRuntimeAppAdapter,
  CanvasRuntimePresentationDataAdapter,
  CanvasRuntimeSavedObjectStampAdapter,
  CanvasRuntimeSceneSessionAdapter,
} from '../../canvas/runtime/app-adapter'
import {
  lastView,
  locale,
  mapBackdropOf,
  plantSpacingIntervalM,
  scrollWheel,
  snapToGridEnabled,
  theme,
  unitSystem,
} from '../settings/state'

import { presentedMapLayers, storyPresentationHidesEditingAids, storyPresentationOverrides } from '../story-presentation/overrides'
import { gridVisible, toggleZoneDimensions, zoneDimensionsVisible } from '../canvas-settings/signals'
import { mutateSettingsProjection } from '../settings/projection'
import { composeDocumentForSave } from '../contracts/document'
import { activeSessionCore, getLiveSessionCore } from '../document-session/live-core'
import { designSessionStore } from '../document-session/store'
import {
  closeCanvasContextMenu,
  closePlantAppearance,
  openCanvasContextMenu,
} from '../canvas-context-menu/state'
import { t } from '../../i18n'
import { currentPlantDisplay } from '../plant-display/state'
import { focusOwner } from '../keyboard/focus-owner'

export interface AppCanvasRuntimeAdapterDeps {
  readonly presentationData: CanvasRuntimePresentationDataAdapter
  readonly savedObjectStamps?: CanvasRuntimeSavedObjectStampAdapter
  readonly placeSavedStamp?: CanvasRuntimeSceneSessionAdapter['placeSavedStamp']
}

export function createAppCanvasRuntimeAppAdapter(
  deps: AppCanvasRuntimeAdapterDeps,
): CanvasRuntimeAppAdapter {
  const canUndo = computed(() => activeSessionCore.value?.canUndo.value ?? false)
  const canRedo = computed(() => activeSessionCore.value?.canRedo.value ?? false)
  return {
    sceneSession: {
      canUndo,
      canRedo,
      recordSceneEdit: (label, command, options) => {
        getLiveSessionCore()?.recordSceneEdit(label, command, options)
      },
      placeSavedStamp: deps.placeSavedStamp,
      undo: () => {
        getLiveSessionCore()?.undo()
      },
      redo: () => {
        getLiveSessionCore()?.redo()
      },
      remapSceneCommands: (map) => {
        getLiveSessionCore()?.remapSceneCommands(map)
      },
    },
    // A read-only session (2.1-M478, Q347): the Scene authority refuses every edit over it.
    isReadOnly: () => designSessionStore.isReadOnly(),
    // A tool's focus request and a closed text entry focus the map through the one focus owner.
    focus: focusOwner,
    document: { composeDocumentForSave },
    contextMenu: { open: openCanvasContextMenu, close: closeCanvasContextMenu },
    closePlantAppearance,
    savedObjectStamps: deps.savedObjectStamps,
    presentationData: deps.presentationData,
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
      readUnitSystem: () => unitSystem.value,
      // Presenting a story shows the map without the grid or zone dimension callouts.
      readChromeOverlay: () => ({ gridVisible: gridVisible.value && !storyPresentationHidesEditingAids.value }),
      readZoneDimensionsVisible: () => zoneDimensionsVisible.value && !storyPresentationHidesEditingAids.value,
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
      toggleZoneDimensionsVisible: () => {
        toggleZoneDimensions()
      },
      subscribeTheme: (onChange) => effect(() => {
        void theme.value
        onChange()
      }),
      subscribeLocale: (onChange) => effect(() => {
        void locale.value
        onChange()
      }),
      subscribeUnitSystem: (onChange) => effect(() => {
        void unitSystem.value
        onChange()
      }),
      subscribeChromeOverlay: (onChange) => effect(() => {
        void gridVisible.value
        void zoneDimensionsVisible.value
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


