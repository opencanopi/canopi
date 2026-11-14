import { canvasPdf, canExportCanvasPdf } from '../../app/canvas-pdf/live'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  canvasCommandDefinitions,
  canvasCommandDisplayKey,
  isCanvasCommandDisabled,
  type CanvasCommandDefinition,
  type CanvasCommandFrom,
  type CanvasCommandId,
  type CanvasCommandProjection,
} from '../../app/canvas-commands'
import {
  composeShellCommandCatalog,
  type ShellCommandCatalogEntry,
  type ShellCommandIdForCapability,
  type ShellCommandState,
} from '../../app/shell-commands'
import { formatShortcut } from '../../app/shell-commands/shortcut-text'
import { singleKeyShortcuts } from '../../app/settings/state'
import { currentDesign } from '../../app/document-session/store'
import { desktopGeoJsonWorkflow as desktopGeoJson } from '../../platform/geojson.desktop'
import {
  closeDesign,
  designRevertAvailable,
  newDesignAction,
  openDesign,
  revertDesign,
  saveAsCurrentDesign,
  saveCurrentDesign,
} from '../../app/document-session/actions'
import { openCommandPalette } from '../../app/shell/dialogs'
import { activePanel, navigateTo, sidePanel, type Panel } from '../../app/shell/state'
import { openProblemReportDialog } from '../../app/problem-report/submission'
import { reportFailure } from '../../failures/report'
import { exportCurrentBudgetCsv } from '../../app/budget/export'
import { beginDataImport, openDataLibrary } from '../../app/lidar/library-navigation'
import { armProfile, profileAvailable } from '../../app/lidar/profile'
import { createWorkspaceShellCapabilities, designChangeable } from '../../app/workspace-commands/capabilities'
import {
  readWorkspaceCanvasProjectionState,
  workspaceCanvasCommandProjection,
  runCanvasIntent,
} from '../../app/workspace-commands/canvas-actions'
import { t } from '../../i18n'

type DesktopShellCapabilityId =
  | 'newDesign'
  | 'openDesign'
  | 'renameDesign'
  | 'saveDesign'
  | 'saveDesignAs'
  | 'revertDesign'
  | 'addData'
  | 'openDataLibrary'
  | 'importGeoJson'
  | 'exportCanvasPdf'
  | 'exportGeoJson'
  | 'exportBudgetCsv'
  | 'openSettings'
  | 'findPlants'
  | 'saveCurrentView'
  | 'manageViews'
  | 'closeDesign'
  | 'exitApp'
  | 'navigateCanvas'
  | 'navigateLayers'
  | 'navigateSiteData'
  | 'navigateSpeciesKey'
  | 'navigatePlantDatabase'
  | 'navigateFavorites'
  | 'navigateCalendar'
  | 'navigateBudget'
  | 'navigateConsortium'
  | 'navigateDesignNotebook'
  | 'navigateStories'
  | 'startProfile'
  | 'toggleToolNames'
  | 'showSatellite'
  | 'showMap'
  | 'showNoBackground'
  | 'toggleTheme'
  | 'showCommandPalette'
  | 'showShortcuts'
  | 'gettingStarted'
  | 'reportProblem'
  | 'aboutCanopi'

export type DesktopShellCommandId = ShellCommandIdForCapability<DesktopShellCapabilityId>

export type AppCommandId = DesktopShellCommandId | CanvasCommandId

export interface AppCommandState extends ShellCommandState {}

export interface AppCommandDefinition {
  readonly id: AppCommandId
  readonly label: () => string
  /** Display text, e.g. "Ctrl Shift S". */
  readonly shortcut?: string
  readonly palette: boolean
  /** `from` is the surface that ran it; a canvas tool arms with it. */
  readonly run: (state: AppCommandState, from: CanvasCommandFrom) => void
  readonly disabled?: (state: AppCommandState) => boolean
}

export function readAppCommandState(): AppCommandState {
  return {
    hasDesign: currentDesign.value !== null,
    revertAvailable: designRevertAvailable.value,
    activePanel: activePanel.value,
    sidePanel: sidePanel.value,
  }
}

function canvasAppCommandDefinition(
  definition: CanvasCommandDefinition,
): AppCommandDefinition {
  return {
    id: definition.commandId,
    label: () => t(definition.labelKey),
    // Read when shown: the language and Settings › Keyboard can change.
    get shortcut() {
      const shortcut = canvasCommandDisplayKey(definition, singleKeyShortcuts.value)
      return shortcut ? formatShortcut(shortcut, t) : undefined
    },
    // Every canvas command is in the palette, Pan included.
    palette: true,
    run: (_state, from) => runCanvasIntent(definition.intent, from),
    disabled: () => isCanvasCommandDisabled(definition.intent, readWorkspaceCanvasProjectionState()),
  }
}

export function createDesktopCanvasCommandProjection(): CanvasCommandProjection {
  return workspaceCanvasCommandProjection.value
}

function logCommandFailure(label: string, error: unknown): void {
  reportFailure(error, { shown: 'none', source: `command:${label}`, echo: [`${label} failed:`, error] })
}

function runAsyncCommand(label: string, action: () => Promise<unknown>): void {
  void action().catch((error) => logCommandFailure(label, error))
}

function isGeoJsonTransferDisabled(state: ShellCommandState): boolean {
  return !designChangeable(state) || !desktopGeoJson.isAvailable()
}

function designPanel(panel: Panel) {
  return {
    execute: () => navigateTo(panel),
    isExecutionDisabled: (state: ShellCommandState) => !state.hasDesign,
  }
}

export const DESKTOP_SHELL_COMMAND_CATALOG = composeShellCommandCatalog({
  ...createWorkspaceShellCapabilities(),
  newDesign: {
    execute: () => runAsyncCommand('New design', newDesignAction),
  },
  openDesign: {
    execute: () => runAsyncCommand('Open design', openDesign),
  },
  saveDesign: {
    execute: () => runAsyncCommand('Save design', saveCurrentDesign),
    isExecutionDisabled: (state) => !designChangeable(state),
  },
  saveDesignAs: {
    execute: () => runAsyncCommand('Save design as', saveAsCurrentDesign),
    isExecutionDisabled: (state) => !designChangeable(state),
  },
  revertDesign: {
    execute: () => runAsyncCommand('Revert design', revertDesign),
    isExecutionDisabled: (state) => !designChangeable(state) || !state.revertAvailable,
  },
  importGeoJson: {
    execute: () => runAsyncCommand('Import GeoJSON', desktopGeoJson.importGeoJson),
    isExecutionDisabled: isGeoJsonTransferDisabled,
  },
  exportCanvasPdf: {
    execute: () => canvasPdf.show(),
    isExecutionDisabled: (state) => !designChangeable(state) || !canExportCanvasPdf(),
  },
  exportGeoJson: {
    execute: () => runAsyncCommand('Export GeoJSON', desktopGeoJson.exportGeoJson),
    isExecutionDisabled: isGeoJsonTransferDisabled,
  },
  // File › Import terrain or height data… picks files and imports them into the open Design's Site data.
  addData: {
    execute: () => runAsyncCommand('Import terrain or height data', () => beginDataImport()),
    isExecutionDisabled: (state) => !designChangeable(state),
  },
  openDataLibrary: { execute: () => openDataLibrary() },
  exportBudgetCsv: {
    execute: () => runAsyncCommand('Export budget CSV', exportCurrentBudgetCsv),
    isExecutionDisabled: (state) => !designChangeable(state),
  },
  closeDesign: {
    execute: () => runAsyncCommand('Close design', closeDesign),
    isExecutionDisabled: (state) => !state.hasDesign,
  },
  exitApp: {
    execute: () => runAsyncCommand('Close window', () => getCurrentWindow().close()),
  },
  navigateCanvas: {
    execute: () => navigateTo('canvas'),
  },
  navigateLayers: designPanel('layers'),
  navigateSiteData: designPanel('site-data'),
  navigateSpeciesKey: designPanel('species-key'),
  navigatePlantDatabase: {
    // The catalog runs from the start screen; the rail offers it with a Design.
    execute: () => navigateTo('plant-db'),
    isProjectionDisabled: (state) => !state.hasDesign && state.sidePanel !== 'plant-db',
  },
  navigateFavorites: designPanel('favorites'),
  navigateCalendar: designPanel('calendar'),
  navigateBudget: designPanel('budget'),
  navigateConsortium: designPanel('consortium'),
  navigateDesignNotebook: {
    execute: () => navigateTo('design-notebook'),
  },
  navigateStories: designPanel('stories'),
  startProfile: {
    execute: () => armProfile('palette'),
    isExecutionDisabled: (state) => !designChangeable(state) || !profileAvailable.value,
  },
  reportProblem: { execute: openProblemReportDialog },
  showCommandPalette: { execute: openCommandPalette },
})

function shellAppCommandDefinition(
  command: ShellCommandCatalogEntry<DesktopShellCommandId>,
): AppCommandDefinition {
  return {
    id: command.id,
    label: () => t(command.labelKey),
    // Read when shown: the language can change after the catalog is built.
    get shortcut() {
      return command.shortcut ? formatShortcut(command.shortcut, t) : undefined
    },
    palette: command.palette,
    run: () => command.execute(),
    disabled: (state) => command.isExecutionDisabled(state),
  }
}

export const APP_COMMANDS: readonly AppCommandDefinition[] = [
  ...DESKTOP_SHELL_COMMAND_CATALOG.map(shellAppCommandDefinition),
  ...canvasCommandDefinitions.map(canvasAppCommandDefinition),
]

const commandById = new Map<AppCommandId, AppCommandDefinition>(
  APP_COMMANDS.map((command) => [command.id, command]),
)

function getAppCommandDefinition(id: AppCommandId): AppCommandDefinition | null {
  return commandById.get(id) ?? null
}

export function isCatalogCommandDisabled(id: AppCommandId): boolean {
  const command = getAppCommandDefinition(id)
  if (!command) return true
  const state = readAppCommandState()
  return command.disabled?.(state) ?? false
}

export function runCatalogCommand(id: AppCommandId, from: CanvasCommandFrom): boolean {
  const command = getAppCommandDefinition(id)
  if (!command) return false
  const state = readAppCommandState()
  if (command.disabled?.(state)) return false
  command.run(state, from)
  return true
}
