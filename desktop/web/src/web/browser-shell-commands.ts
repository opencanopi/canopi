import { canvasPdf, canExportCanvasPdf } from '../app/canvas-pdf/live'
import { navigateTo, type Panel, type SidePanel } from '../app/shell/state'
import { designSessionStore } from '../app/document-session/store'
import {
  composeShellCommandCatalog,
  projectShellCommandCatalog,
  type ProjectedShellCommand,
  type ShellChromeProjection,
  type ShellCommandCatalogEntry,
  type ShellCommandIdForCapability,
  type ShellCommandState,
} from '../app/shell-commands'
import { composeWorkspaceMenus, type MenuDefinition } from '../app/shell-commands/menus'
import { setShortcutPlatform } from '../app/shell-commands/shortcut-text'
import { createWorkspaceShellCapabilities, designChangeable } from '../app/workspace-commands/capabilities'
import { savedViewMenuActions } from '../app/saved-views'
import { plantLabelMenuActions } from '../app/plant-display/menu'
import { exportCurrentBudgetCsv } from '../app/budget/export'
import { canvasCommandDefinitions, type CanvasCommandProjection } from '../app/canvas-commands'
import { installKeyRouter, type KeyRouterHandle } from '../app/keyboard/key-router'
import { CANVAS_KEYMAP_ROWS, shellKeymapRows, type CommandSink } from '../app/keyboard/keymap'
import { saveProblem } from '../app/document-session/save-problem'
import { openProblemReportDialog } from '../app/problem-report/submission'
import { savedViewDialogOpen } from '../app/saved-views/dialogs'
import { singleKeyShortcuts } from '../app/settings/state'
import { focusOwner } from '../app/keyboard/focus-owner'
import { modalLayerOpen } from '../app/shell/modal-layer'
import { dispatchWorkspaceCanvasIntent } from '../app/workspace-commands/canvas-actions'
import { currentCanvasKeyboardPort } from '../canvas/session'
import { detectPlatform, type InputPlatform } from '../canvas/runtime/input/platform'
import { t } from '../i18n'
import type { DesignSaveStatus } from '../app/document-session/continuous-save'
import type { ReadOnlyOrigin } from '../app/document-session/store'
import type { GeoJsonWorkflow } from '../app/geojson/workflow'

type BrowserShellCapabilityId =
  | 'newDesign'
  | 'openCanopi'
  | 'renameDesign'
  | 'downloadCanopi'
  | 'revertDesign'
  | 'importGeoJson'
  | 'exportCanvasPdf'
  | 'exportGeoJson'
  | 'exportBudgetCsv'
  | 'closeDesign'
  | 'openSettings'
  | 'findPlants'
  | 'saveCurrentView'
  | 'manageViews'
  | 'navigateCanvas'
  | 'navigateTemplates'
  | 'navigateLayers'
  | 'navigateSpeciesKey'
  | 'navigatePlantDatabase'
  | 'navigateFavorites'
  | 'navigateCalendar'
  | 'navigateBudget'
  | 'navigateConsortium'
  | 'navigateStories'
  | 'toggleToolNames'
  | 'showSatellite'
  | 'showMap'
  | 'showNoBackground'
  | 'toggleTheme'
  | 'showShortcuts'
  | 'gettingStarted'
  | 'reportProblem'
  | 'aboutCanopi'

type BrowserShellCommandId = ShellCommandIdForCapability<BrowserShellCapabilityId>

export type BrowserShellProjectedCommand = ProjectedShellCommand<BrowserShellCommandId>
export type BrowserShellCatalog = readonly ShellCommandCatalogEntry<BrowserShellCommandId>[]

export interface BrowserShellChromeProjection extends ShellChromeProjection<BrowserShellCommandId> {
  /** File, Edit, View, Tools and Help, ready to render. */
  readonly workspaceMenus: readonly MenuDefinition[]
}

/**
 * The panels as the phone sheet lists them: the Design and planning panels,
 * then the primary views (the Design map and Templates) when there are two.
 */
export function browserPhoneSheetTabs<Command>(panelBar: {
  readonly primary: readonly Command[]
  readonly design: readonly Command[]
  readonly planning: readonly Command[]
}): readonly Command[] {
  return [...panelBar.design, ...panelBar.planning, ...(panelBar.primary.length > 1 ? panelBar.primary : [])]
}

export interface BrowserShellDesignIdentity {
  readonly name: string
  readonly saveStatus: DesignSaveStatus
  readonly saveFailureReason: string | null
  /** Why a read-only Design is read-only; its save status popover says so (2.1-Q336). */
  readonly readOnlyOrigin?: ReadOnlyOrigin | undefined
}

export interface BrowserShellCapabilities {
  newDesign(): void
  openCanopi(): void
  downloadCanopi(): void
  revertDesign(): void
  importGeoJson(): void
  exportGeoJson(): void
  exportBudgetCsv(): void
  closeDesign(): void
  navigate(panel: Panel): void
}

export interface BrowserDesignShellCommands {
  newDesign(): Promise<void>
  openCanopi(): Promise<boolean>
  downloadCanopi(): Promise<void>
  revertDesign(): Promise<unknown>
  closeDesign(): Promise<unknown>
}

/**
 * A browser keeps these for itself (new window, tab switching), so the Web
 * Edition neither shows nor listens for them.
 */
const BROWSER_RESERVED_SHORTCUTS: ReadonlySet<string> = new Set([
  'Ctrl+N',
  'Ctrl+Q',
  'Ctrl+W',
  'Ctrl+1',
  'Ctrl+2',
  'Ctrl+3',
  'Ctrl+4',
  'Ctrl+5',
  'Ctrl+6',
  'Ctrl+7',
  'Ctrl+8',
  'Ctrl+9',
])

export function createBrowserShellCapabilities(
  commands: BrowserDesignShellCommands,
  onError: (error: unknown) => void,
  geoJson: Pick<GeoJsonWorkflow, 'importGeoJson' | 'exportGeoJson'>,
): BrowserShellCapabilities {
  return {
    newDesign: () => runBrowserDesignCommand(() => commands.newDesign(), onError),
    openCanopi: () => runBrowserDesignCommand(() => commands.openCanopi(), onError),
    downloadCanopi: () => runBrowserDesignCommand(() => commands.downloadCanopi(), onError),
    revertDesign: () => runBrowserDesignCommand(() => commands.revertDesign(), onError),
    importGeoJson: () => runBrowserDesignCommand(() => geoJson.importGeoJson(), onError),
    exportGeoJson: () => runBrowserDesignCommand(() => geoJson.exportGeoJson(), onError),
    exportBudgetCsv: () => runBrowserDesignCommand(exportCurrentBudgetCsv, onError),
    closeDesign: () => runBrowserDesignCommand(() => commands.closeDesign(), onError),
    navigate: navigateTo,
  }
}

export interface BrowserShellCatalogOptions {
  readonly templatesEnabled: boolean
  /** A Design is open in a mounted canvas runtime (GeoJSON needs one). */
  readonly canvasReady: () => boolean
}

const storedCopyShown = () => {
  const session = designSessionStore.sessionKind.value
  return session.kind === 'read-only' && session.origin === 'storage-unchecked'
}

/** The Web Edition command catalog; availability reads the live state it is given. */
export function createBrowserShellCatalog(
  capabilities: BrowserShellCapabilities,
  { templatesEnabled, canvasReady }: BrowserShellCatalogOptions,
): BrowserShellCatalog {
  const needsDesign = (state: ShellCommandState) => !state.hasDesign
  // A read-only Design offers Close only (2.1-Q315): no copy, revert, import or export.
  const needsChangeable = (state: ShellCommandState) => !designChangeable(state)
  const designPanel = (panel: SidePanel) => ({
    execute: () => capabilities.navigate(panel),
    isExecutionDisabled: needsDesign,
  })
  return composeShellCommandCatalog({
    ...createWorkspaceShellCapabilities(),
    newDesign: { execute: () => capabilities.newDesign() },
    openCanopi: { execute: () => capabilities.openCanopi() },
    downloadCanopi: {
      execute: () => capabilities.downloadCanopi(),
      // A Draft opened read-only while 2.1's Drafts could not be listed keeps its stored copy (2.1-Q334); a newer
      // Canopi's Design never, since re-encoding it as this format is unsafe.
      isExecutionDisabled: (state) => needsChangeable(state) && !(state.hasDesign && storedCopyShown()),
    },
    revertDesign: {
      execute: () => capabilities.revertDesign(),
      isExecutionDisabled: (state) => needsChangeable(state) || !state.revertAvailable,
    },
    importGeoJson: {
      execute: () => capabilities.importGeoJson(),
      isExecutionDisabled: (state) => needsChangeable(state) || !canvasReady(),
    },
    exportCanvasPdf: {
      execute: () => canvasPdf.show(),
      isExecutionDisabled: (state) => needsChangeable(state) || !canExportCanvasPdf(),
    },
    exportGeoJson: {
      execute: () => capabilities.exportGeoJson(),
      isExecutionDisabled: (state) => needsChangeable(state) || !canvasReady(),
    },
    exportBudgetCsv: {
      execute: () => capabilities.exportBudgetCsv(),
      isExecutionDisabled: needsChangeable,
    },
    closeDesign: {
      execute: () => capabilities.closeDesign(),
      isExecutionDisabled: needsDesign,
    },
    navigateCanvas: { execute: () => capabilities.navigate('canvas') },
    ...(templatesEnabled
      ? { navigateTemplates: { execute: () => capabilities.navigate('templates') } }
      : {}),
    navigateLayers: designPanel('layers'),
    navigateSpeciesKey: designPanel('species-key'),
    navigatePlantDatabase: { execute: () => capabilities.navigate('plant-db') },
    navigateFavorites: { execute: () => capabilities.navigate('favorites') },
    navigateCalendar: designPanel('calendar'),
    navigateBudget: designPanel('budget'),
    navigateConsortium: designPanel('consortium'),
    navigateStories: designPanel('stories'),
    // A Web report is one zip, downloaded (2.1-Q60, Q283).
    reportProblem: { execute: openProblemReportDialog },
  })
}

export interface BrowserShellProjectionInput {
  readonly catalog: BrowserShellCatalog
  readonly state: ShellCommandState
  readonly canvas: CanvasCommandProjection
}

export function createBrowserShellCommandProjection({
  catalog,
  state,
  canvas,
}: BrowserShellProjectionInput): BrowserShellChromeProjection {
  const shell = projectShellCommandCatalog(catalog, state, t, {
    unavailableShortcuts: BROWSER_RESERVED_SHORTCUTS,
  })
  return {
    ...shell,
    workspaceMenus: composeWorkspaceMenus({ shell, canvas, translate: t, savedViews: savedViewMenuActions(), plantLabels: plantLabelMenuActions() }),
  }
}

function runBrowserDesignCommand(
  command: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  try {
    void command().catch(onError)
  } catch (error) {
    onError(error)
  }
}

/** What the Web keys need to run shell commands against the live state. */
export interface WebShellShortcutSource {
  readonly catalog: BrowserShellCatalog
  readState(): ShellCommandState
}

let activeKeyRouter: KeyRouterHandle | null = null

/**
 * The Web Edition key router (spec §1.6): its shell rows, less the shortcuts a browser keeps, then the canvas rows. A
 * shell shortcut takes its key even when its command is disabled; a canvas command takes it when it ran, or when it is
 * an Edit command while the map has a selection (dispatchWorkspaceCanvasIntent).
 * Installing again replaces the router; main.web.tsx installs it once, on the browser's own platform, which also
 * names the mod key in every shortcut label (Cmd on a Mac).
 */
export function installWebKeyRouter(
  shell: WebShellShortcutSource,
  platform: InputPlatform = detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown }),
): KeyRouterHandle {
  activeKeyRouter?.dispose()
  setShortcutPlatform(platform)
  const commands: CommandSink = {
    run(command) {
      const entry = shell.catalog.find((candidate) => candidate.id === command)
      if (entry) {
        if (!entry.isExecutionDisabled(shell.readState())) entry.execute()
        return true
      }
      const definition = canvasCommandDefinitions.find((candidate) => candidate.commandId === command)
      return definition ? dispatchWorkspaceCanvasIntent(definition.intent, 'shortcut') : false
    },
  }
  const router = installKeyRouter({
    target: window,
    keymap: [...shellKeymapRows(shell.catalog, { omit: BROWSER_RESERVED_SHORTCUTS }), ...CANVAS_KEYMAP_ROWS],
    commands,
    canvas: currentCanvasKeyboardPort,
    singleKeys: singleKeyShortcuts,
    focus: focusOwner,
    isModalOpen: () => saveProblem.peek() !== null || savedViewDialogOpen.peek() || modalLayerOpen.peek(),
    platform,
    document,
  })
  const handle: KeyRouterHandle = {
    dispose() {
      router.dispose()
      if (activeKeyRouter === handle) activeKeyRouter = null
    },
  }
  activeKeyRouter = handle
  return handle
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => activeKeyRouter?.dispose())
}
