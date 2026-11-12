import { openAboutCanopiDialog } from '../about/state'
import { designSessionStore } from '../document-session/store'
import { focusOpenPlantFinder } from '../plant-finder/focus'
import { selectPanel } from '../shell/state'
import { setMapBackground } from '../map-layers/actions'
import { mapBackgroundOf, mapLayers } from '../map-layers/state'
import { mutateSettingsProjection } from '../settings/projection'
import { theme } from '../settings/state'
import { openGettingStartedDialog, openKeyboardShortcutsDialog, openSettingsDialog } from '../shell/dialogs'
import { requestDesignRename } from '../shell/requests'
import {
  canShowSavedViews,
  currentSavedViews,
  openManageViewsDialog,
  openSaveViewDialog,
} from '../saved-views'
import type { ShellCommandCapabilities, ShellCommandState } from '../shell-commands'
import { toggleToolNames, toolRailShowsNames } from '../tool-rail/learning'

/**
 * A Design is open and may change or leave Canopi: Rename, Save, Revert, the imports and the exports. A read-only
 * Design (one a newer Canopi saved) offers Close only (2.1-Q315, M478).
 */
export function designChangeable(state: ShellCommandState): boolean {
  return state.hasDesign && !designSessionStore.isReadOnly()
}

/**
 * Shell capabilities both editions share: they act on app state only (title
 * bar, dialogs, device settings, map background), never on files or IPC.
 */
export function createWorkspaceShellCapabilities() {
  return {
    renameDesign: {
      execute: requestDesignRename,
      isExecutionDisabled: (state) => !designChangeable(state),
    },
    openSettings: { execute: openSettingsDialog },
    findPlants: { execute: findPlants },
    saveCurrentView: {
      execute: openSaveViewDialog,
      isExecutionDisabled: (state) => !designChangeable(state) || !canShowSavedViews(),
    },
    manageViews: {
      execute: openManageViewsDialog,
      isExecutionDisabled: (state) => !designChangeable(state) || currentSavedViews().length === 0,
    },
    toggleToolNames: {
      execute: toggleToolNames,
      isChecked: () => toolRailShowsNames.value,
    },
    showSatellite: {
      execute: () => setMapBackground('satellite'),
      isChecked: () => mapBackgroundOf(mapLayers.value) === 'satellite',
    },
    showMap: {
      execute: () => setMapBackground('basemap'),
      isChecked: () => mapBackgroundOf(mapLayers.value) === 'basemap',
    },
    showNoBackground: {
      execute: () => setMapBackground('none'),
      isChecked: () => mapBackgroundOf(mapLayers.value) === 'none',
    },
    toggleTheme: {
      execute: toggleTheme,
      isChecked: () => theme.value === 'dark',
    },
    showShortcuts: { execute: openKeyboardShortcutsDialog },
    gettingStarted: { execute: openGettingStartedDialog },
    aboutCanopi: { execute: openAboutCanopiDialog },
  } satisfies ShellCommandCapabilities
}

/** Edit › Find plants (Ctrl F): the open panel's finder, else the Plant catalog's. */
function findPlants(): void {
  if (focusOpenPlantFinder()) return
  selectPanel('plant-db')
  requestAnimationFrame(() => { focusOpenPlantFinder() })
}

function toggleTheme(): void {
  mutateSettingsProjection((settings) => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark'
  }, { persist: 'immediate' })
}
