import type { ReadonlySignal } from '@preact/signals'
import type { CanopiFile } from '../../types/design'
import type { PointAction } from '../point-editor/rules'
import { FALLBACK_PLANT_SPACING_INTERVAL_M } from '../plant-spacing-interval'
import type {
  CanvasPlantLabelSource,
  CanvasSpeciesPresentationCache,
} from './presentation-data'
import type { ScenePersistedState, ScenePoint } from './scene'
import type { CanvasMapBackdrop } from './scene-visuals'
import type { PlantDisplay } from './plant-display'
import type {
  CanvasDesignObjectSelectionModel,
  CanvasRuntimeDocumentMetadata,
  CanvasSceneEditCommandSurface,
} from './runtime'
import type { LocaleKey } from '../../generated/locale-keys'

interface CanvasRuntimeChromeSettingsSnapshot {
  /** The grid; the app hides it while it presents the map. */
  readonly gridVisible: boolean
}

interface CanvasRuntimeCleanStateAdapter {
  setCanvasClean(clean: boolean): void
}

export interface CanvasRuntimeDocumentCompositionInput {
  readonly metadata: CanvasRuntimeDocumentMetadata
  readonly document: CanopiFile
  readonly canvas: CanopiFile
}

interface CanvasRuntimeDocumentAdapter {
  composeDocumentForSave(input: CanvasRuntimeDocumentCompositionInput): CanopiFile
}

export interface CanvasRuntimeSavedObjectStampCapture {
  readonly scene: ScenePersistedState
  readonly selection: CanvasDesignObjectSelectionModel
  readonly localizedCommonNames: ReadonlyMap<string, string | null>
}

export interface CanvasRuntimeSavedObjectStampAdapter {
  saveCurrentSelection(capture: CanvasRuntimeSavedObjectStampCapture): void | Promise<unknown>
}

/** The scene edits a right-click menu may run; there is no other mutation path. */
export type CanvasContextMenuCommands = Pick<
  CanvasSceneEditCommandSurface,
  | 'copy'
  | 'pasteAt'
  | 'canPaste'
  | 'duplicateSelected'
  | 'toggleSelectedPlantNamePins'
  | 'deleteSelected'
  | 'selectAll'
  | 'selectSameSpecies'
  | 'bringToFront'
  | 'sendToBack'
  | 'lockSelected'
  | 'unlockSelected'
  | 'groupSelected'
  | 'ungroupSelected'
  | 'renameZone'
  | 'rotateSelected'
>

/** A viewport (client) rectangle; a pointer is a rectangle of zero size. */
export interface CanvasContextMenuAnchor {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** One entry of a point menu: what it does to the point, whether the point refuses it (Delete point below the minimum),
 *  and its run, which sends the tool a `point-action` for that point while the tool is still armed. */
export interface CanvasContextMenuPointAction {
  readonly action: PointAction
  readonly disabled: boolean
  run(): void
}

export interface CanvasContextMenuRequest {
  /** The menu opens below and right of this rectangle, flipping to stay in view. */
  readonly anchor: CanvasContextMenuAnchor
  /** Where Paste puts the clipboard, in the session plane. */
  readonly world: ScenePoint
  /**
   * The selection the menu acts on (already retargeted to the right-clicked
   * object), or `null` for the empty map.
   */
  readonly selection: CanvasDesignObjectSelectionModel | null
  readonly commands: CanvasContextMenuCommands
  /** Present only in an edition that keeps saved stamps. */
  readonly saveSelectionAsObjectStamp?: () => void
  /**
   * Place plants here (the empty map): arms Place plants and places the
   * chosen species at `world`, or, with none chosen yet, the next one picked.
   */
  readonly placePlantsAt?: (world: ScenePoint) => void
  /**
   * Finish shape: present only while the armed polygon's draft has 3 or more corners; the menu's first entry. Finishes
   * the draft as Enter does.
   */
  readonly finishShape?: () => void
  /**
   * Turn view to this edge: present only when the menu opened on a zone's edge (spec §4.16). Turns the view the smaller
   * way until that edge is level on screen.
   */
  readonly turnViewToEdge?: () => void
  /**
   * Present while a press, a tool transient (a polygon draft, a row source, Place plants' waiting point, a held stamp
   * pick) or a text entry is live (U39): the selection was kept, not retargeted, and Cut and Delete are disabled, as key
   * admission refuses Delete and Ctrl+X then.
   */
  readonly holdsSelectionDeletes?: true
  /**
   * The point menu (A16): present when the menu opened on a point the armed tool edits (a zone's corner under Select, a
   * row's point). The menu is then these entries only, after Finish shape while the draft can finish; `selection` is
   * null and the selection's commands are not offered.
   */
  readonly pointActions?: readonly CanvasContextMenuPointAction[]
  /** Gives keyboard focus back to what held it inside the map when the menu opened (a corner focused for Shift+F10)
   *  while that is still shown, else to the map; also to the map when the command run just after removes that opener
   *  and leaves focus nowhere. */
  returnFocus(): void
  /**
   * The app calls this once the request's menu has closed, however it
   * closed: a command, Esc or Tab (before returnFocus), a press or focus
   * elsewhere, a resize, a scroll, a newer request or the runtime's own
   * close. The runtime's menu state follows it.
   */
  closed?(): void
}

/**
 * The right-click menu is app chrome: the runtime decides what it acts on and
 * where it opens, the app renders it and runs its commands on `commands`.
 */
export interface CanvasRuntimeContextMenuAdapter {
  open(request: CanvasContextMenuRequest): void
  /** Closes this request's menu if it is still the open one. */
  close(request: CanvasContextMenuRequest): void
}

/** Settings › Canvas › Pointing device (stored scrollWheel): a plain wheel zooms (Mouse) or pans (Trackpad) the map. */
export type CanvasScrollWheelSetting = 'zoom' | 'pan'

export interface CanvasRuntimeSettingsAdapter {
  readLocale(): string
  readChromeOverlay(): CanvasRuntimeChromeSettingsSnapshot
  readSnapToGridEnabled(): boolean
  /** Settings › Canvas › Pointing device: what a plain wheel does; pinch and Ctrl wheel always zoom. */
  readScrollWheel(): CanvasScrollWheelSetting
  readPlantSpacingIntervalMeters(): number
  /** The app's last view as stored, if any: a new or empty Design opens at its centre, zoomed out (spec §4.15; the clamp
   *  is the runtime's, scene-runtime/construction.ts). */
  readLastView?(): { readonly lon: number; readonly lat: number; readonly zoom: number } | null
  commitPlantSpacingIntervalMeters(meters: number): void
  toggleGridVisible(): void
  toggleSnapToGrid(): void
  subscribeTheme(onChange: () => void): () => void
  subscribeLocale(onChange: () => void): () => void
  subscribeChromeOverlay(onChange: () => void): () => void
  /** Calls `onChange` now and whenever the map background under the Design changes. */
  subscribeMapBackdrop(onChange: (backdrop: CanvasMapBackdrop) => void): () => void
}

/** Display on the map: how plants are coloured, sized, outlined and labelled. */
export interface CanvasRuntimePlantDisplayAdapter {
  /** Calls `onChange` now and whenever the display changes. */
  subscribe(onChange: (display: PlantDisplay) => void): () => void
}

export interface CanvasRuntimePresentationDataAdapter {
  readonly plantLabels?: CanvasPlantLabelSource
  readonly speciesCache?: CanvasSpeciesPresentationCache
}

export type CanvasRuntimeTranslator = (
  key: LocaleKey,
  options?: Readonly<Record<string, unknown>>,
) => string

export interface CanvasRuntimeAppAdapter {
  readonly cleanState: CanvasRuntimeCleanStateAdapter
  readonly document: CanvasRuntimeDocumentAdapter
  readonly savedObjectStamps?: CanvasRuntimeSavedObjectStampAdapter
  /** Absent in a detached runtime, where right-click only suppresses the native menu. */
  readonly contextMenu?: CanvasRuntimeContextMenuAdapter
  /**
   * The Site data pin (canopi-f47t.42, spec §3.8): a Select tap on empty ground or any Pan-tool tap pins this Scene point
   * once the tool has heard the tap (ToolHostDeps.pin). Injected rather than imported, so the generic runtime stays
   * independent of the LiDAR feature; the edition decides per call whether the Site data panel is open. Absent on Web.
   */
  readonly pinAt?: (point: { readonly x: number; readonly y: number }) => void
  /** The Site data profile (canopi-f47t.42, spec §1.10): the Profile tool's finished line, in Scene points (ToolHostDeps
   *  .finishProfile). Absent on Web. */
  readonly finishProfile?: (points: readonly { readonly x: number; readonly y: number }[]) => void
  readonly presentationData?: CanvasRuntimePresentationDataAdapter
  /** Absent in a detached runtime, which draws the default display. */
  readonly plantDisplay?: CanvasRuntimePlantDisplayAdapter
  readonly settings: CanvasRuntimeSettingsAdapter
  readonly translate: CanvasRuntimeTranslator
  /** prefers-reduced-motion: reduce, live (app/canvas-runtime/app-adapter.ts): the view's flights jump while it is true
   *  (spec §4.3; turns always jump, U34). Absent in a detached runtime, which always flies. */
  readonly reducedMotion?: ReadonlySignal<boolean>
  /** How ToolHostDeps.focus leaves the runtime: app/canvas-runtime/app-adapter.ts passes the FocusOwner; absent (a
   *  detached runtime), interaction-session.ts focuses its host itself. */
  readonly focus?: CanvasFocusPort
}

/** How a tool's focus request (ToolEffects.requestFocus) leaves the runtime. The FocusOwner implements it. */
export interface CanvasFocusPort {
  focusMap(): void
}

export function createDetachedCanvasRuntimeAppAdapter(): CanvasRuntimeAppAdapter {
  let gridVisible = false
  let snapToGrid = false
  let plantSpacingIntervalM = FALLBACK_PLANT_SPACING_INTERVAL_M

  return {
    cleanState: {
      setCanvasClean: () => {},
    },
    document: {
      composeDocumentForSave: composeDetachedCanvasDocument,
    },
    translate: detachedCanvasRuntimeTranslator,
    settings: {
      readLocale: () => 'en',
      readChromeOverlay: () => ({ gridVisible }),
      readSnapToGridEnabled: () => snapToGrid,
      readScrollWheel: () => 'zoom',
      readPlantSpacingIntervalMeters: () => plantSpacingIntervalM,
      commitPlantSpacingIntervalMeters: (meters) => {
        plantSpacingIntervalM = meters
      },
      toggleGridVisible: () => {
        gridVisible = !gridVisible
      },
      toggleSnapToGrid: () => {
        snapToGrid = !snapToGrid
      },
      subscribeTheme: subscribeImmediately,
      subscribeLocale: subscribeImmediately,
      subscribeChromeOverlay: subscribeImmediately,
      subscribeMapBackdrop: (onChange) => {
        onChange('basemap')
        return () => {}
      },
    },
  }
}

function detachedCanvasRuntimeTranslator(
  key: string,
  options?: Readonly<Record<string, unknown>>,
): string {
  return typeof options?.defaultValue === 'string' ? options.defaultValue : key
}

function subscribeImmediately(onChange: () => void): () => void {
  onChange()
  return () => {}
}

function composeDetachedCanvasDocument({
  metadata,
  document,
  canvas,
}: CanvasRuntimeDocumentCompositionInput): CanopiFile {
  return {
    ...document,
    ...canvas,
    name: metadata.name,
    description: metadata.description ?? document.description ?? null,
    consortiums: document.consortiums,
    timeline: document.timeline,
    budget: document.budget,
    budget_currency: document.budget_currency,
    created_at: document.created_at,
    extra: normalizeDetachedExtra(document.extra),
  }
}

/** The Design's `extra`, all of it Design Edit's: the scene owns no `extra` key. */
function normalizeDetachedExtra(extra: CanopiFile['extra']): Record<string, unknown> {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {}
  return { ...extra }
}
