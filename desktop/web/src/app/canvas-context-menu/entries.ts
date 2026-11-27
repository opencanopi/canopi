import {
  canvasCommandAriaKeys,
  canvasCommandDefinitions,
  canvasCommandDisplayKey,
  type CanvasEditAction,
  type CanvasEditCommandDefinition,
} from '../canvas-commands'
import {
  commandApplicability,
  commandRowFor,
  EDITION_CAPABILITIES,
  type Applicability,
  type CommandContext,
  type CommandOrToolRow,
  type EditionCapabilityId,
} from '../command-table'
import { formatShortcut } from '../shell-commands/shortcut-text'
import type { CanvasContextMenuRequest } from '../../canvas/runtime/app-adapter'
import type { PointAction } from '../../canvas/point-editor/rules'
import type { CanvasDesignObjectSelectionModel } from '../../canvas/runtime/runtime'
import {
  selectionCommandAvailability,
  selectionIncludesPlants,
} from '../../canvas/runtime/interaction/contextual-selection-actions'
import type { PlantAppearanceAnchor, PlantAppearanceKind } from './state'
import type { MapSelectionSummary } from '../map-selection/summary'
import type { CalendarAddTarget } from '../timeline/calendar-request'
import { openRotateSelectionDialog } from '../rotate-selection/state'
import { loneEditableZoneId, openRenameZoneDialog } from '../rename-zone/state'
import type { LocaleKey } from '../../generated/locale-keys'

export type CanvasContextMenuItemId =
  | CanvasEditAction
  | 'plant-color'
  | 'plant-symbol'
  | 'toggle-plant-names'
  | 'species-details'
  | 'rename-zone'
  | 'add-to-calendar'
  | 'set-unit-cost'
  | 'place-plants-here'
  | 'turn-view-to-edge'
  | 'finish-shape'
  | 'profile-line'
  | PointAction

export interface CanvasContextMenuCommand {
  readonly id: CanvasContextMenuItemId
  readonly label: string
  readonly shortcut?: string
  readonly keyShortcuts?: string
  /** Inapplicable commands stay listed and focusable, but do nothing. */
  readonly disabled: boolean
  readonly danger?: boolean
  readonly opensDialog?: boolean
  run(itemBounds?: DOMRect): void
}

/** Arrange ▸: stacking and grouping, one level down so the plant menu fits a short window. */
export interface CanvasContextMenuSubmenu {
  readonly id: 'arrange'
  readonly label: string
  /** Disabled while nothing in it applies. */
  readonly disabled: boolean
  readonly submenu: readonly CanvasContextMenuEntry[]
}

export type CanvasContextMenuEntry =
  | CanvasContextMenuCommand
  | CanvasContextMenuSubmenu
  | { readonly separator: true }

export interface CanvasContextMenuEntryOptions {
  readonly translate: (key: LocaleKey) => string
  /** Settings › Keyboard: false hides character-key shortcuts (`]`, `[`), which no longer work. */
  readonly characterKeyShortcuts: boolean
  openPlantAppearance(kind: PlantAppearanceKind, anchor: PlantAppearanceAnchor): void
  /** What the selection chip says about the selection (its species); null on the empty map. */
  readonly summary: MapSelectionSummary | null
  /** Species details: the species' detail in the Plant catalog. */
  openSpeciesDetail(canonicalName: string): void
  /** Add to calendar…: the Calendar's new-action editor aimed at the selection. */
  addToCalendar(target: CalendarAddTarget): void
  /** Set unit cost…: the species' price field in the Budget. */
  setUnitCost(canonicalName: string): void
  /** Profile this line (Desktop's Site data, spec §1.10, U49 Q29); absent where there is no Site data. */
  readonly profileLine?: CanvasContextMenuProfileLine
  /** The open Design is shown read-only (2.1-M478): only the entries that look stay offered; false: an editing Design. */
  readonly readOnly: boolean
  /**
   * Edition capabilities (S14, 2.1-Q170, 2.1-M163): entries whose required capability is absent are dropped via
   * `commandApplicability` (`{ lacking }`). Defaults to all capabilities when omitted by unit tests.
   */
  readonly capabilities?: readonly EditionCapabilityId[]
}

/** What "Profile this line" needs from the edition that has Site data (app/lidar/profile.ts). */
export interface CanvasContextMenuProfileLine {
  /** False disables the entry, as the Site data Profile button: no elevation or height layer is shown. */
  readonly available: boolean
  /** Profiles the lone Line zone or Measure guide the menu acts on. */
  profile(target: { readonly kind: 'zone' | 'measurement-guide'; readonly id: string }): void
}

const SEPARATOR = { separator: true } as const
const DEFAULT_CAPABILITIES: readonly EditionCapabilityId[] = EDITION_CAPABILITIES.map((row) => row.id)

/** The point menu's labels (A16). */
const POINT_ACTION_LABEL_KEYS: Readonly<Record<PointAction, LocaleKey>> = {
  'delete-point': 'canvas.point.delete',
  'sharp-corner': 'canvas.point.sharp',
  'smooth-corner': 'canvas.point.smooth',
}

function isDropped(applicability: Applicability): boolean {
  return applicability === 'hidden' || typeof applicability === 'object'
}

/**
 * Projects one menu entry through `commandApplicability` (S14, 2.1-Q170, 2.1-M163):
 * `'hidden'` and `{ lacking }` entries are dropped, `'disabled'` entries stay listed and inert,
 * and `'enabled'` entries stay active.
 */
function projectEntry(
  row: CommandOrToolRow,
  ctx: CommandContext,
  build: (disabled: boolean) => CanvasContextMenuCommand,
  extraDisabled = false,
): readonly CanvasContextMenuCommand[] {
  const applicability = commandApplicability(row, ctx)
  if (isDropped(applicability)) return []
  const disabled = applicability === 'disabled' || extraDisabled
  const command = build(disabled)
  return [disabled ? { ...command, disabled: true, run: () => {} } : command]
}

function withSeparator(entries: readonly CanvasContextMenuCommand[]): readonly CanvasContextMenuEntry[] {
  return entries.length > 0 ? [...entries, SEPARATOR] : []
}

/**
 * The right-click menu for a request: projected from `app/command-table/` via
 * `commandApplicability` backed by `selectionCommandAvailability` (S14, 2.1-Q170,
 * 2.1-M163). Every command runs on the request's scene-edit surface. During a
 * polygon draft that can finish, Finish shape leads every menu. A point menu (a
 * zone's corner, a row's point) is that point's entries alone, after Finish shape
 * while drafting. On a zone's edge, Turn view to this edge leads the empty map's
 * menu and comes before Lock in the selection's. While a gesture or tool
 * transient is live, Cut and Delete are disabled (U39). Over a read-only Design
 * only what looks stays offered (2.1-M478); entries lacking an edition
 * capability are dropped.
 */
export function buildCanvasContextMenuEntries(
  request: CanvasContextMenuRequest,
  options: CanvasContextMenuEntryOptions,
): readonly CanvasContextMenuEntry[] {
  const { commands, selection, world } = request
  const can = selection ? selectionCommandAvailability(selection) : null
  const commandContext: CommandContext = {
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    hasDesign: true,
    revertAvailable: false,
    canvasAvailable: true,
    spatialEditingAvailable: true,
    readOnly: options.readOnly,
    selection: can,
    held: request.holdsSelectionDeletes === true,
    lockedObjectsPresent: false,
    canPaste: commands.canPaste(),
    canUndo: false,
    canRedo: false,
  }

  const editEntries = (
    id: CanvasEditAction,
    run: () => void,
    extra: Partial<CanvasContextMenuCommand> = {},
    rowOverrides?: Partial<CommandOrToolRow>,
  ): readonly CanvasContextMenuCommand[] => {
    const definition = editDefinition(id)
    const baseRow = commandRowFor(definition.commandId)
    const row = rowOverrides ? { ...baseRow, ...rowOverrides } : baseRow
    return projectEntry(
      row,
      commandContext,
      (disabled) => editCommand(definition, disabled, run, options.translate, options.characterKeyShortcuts, extra),
    )
  }

  const paste = editEntries('paste', () => commands.pasteAt(world))

  // Turn view to this edge (spec §4.16): only when the menu opened on a zone's edge; it moves the view, never an object,
  // so a locked zone or read-only Design keeps it enabled.
  const turnViewToEdge = request.turnViewToEdge
  const edgeEntries = withSeparator(projectEntry(
    { id: 'turn-view-to-edge', needsCanvas: true, hidden: !turnViewToEdge },
    commandContext,
    (disabled) => ({
      id: 'turn-view-to-edge',
      label: options.translate('canvas.contextMenu.turnViewToEdge'),
      disabled,
      run: () => turnViewToEdge?.(),
    }),
  ))

  // Finish shape (spec §3.2): a polygon draft that can finish leads every menu with it.
  const finishShape = request.finishShape
  const finishEntries = withSeparator(projectEntry(
    { id: 'finish-shape', needsSpatialEditing: true, hidden: !finishShape },
    commandContext,
    (disabled) => ({
      id: 'finish-shape',
      label: options.translate('canvas.contextMenu.finishShape'),
      disabled,
      run: () => finishShape?.(),
    }),
  ))

  const pointActions = request.pointActions
  if (pointActions) {
    // Delete point shows Delete's keys: in the point menu they delete its point (deletePointShortcuts).
    const deleteKeys = shortcutOf(editDefinition('delete'), options.translate, options.characterKeyShortcuts)
    return [
      ...finishEntries,
      ...pointActions.flatMap((entry) => projectEntry(
        { id: entry.action, needsSpatialEditing: true },
        commandContext,
        (disabled) => ({
          id: entry.action,
          label: options.translate(POINT_ACTION_LABEL_KEYS[entry.action]),
          ...(entry.action === 'delete-point' ? deleteKeys : {}),
          disabled,
          run: () => entry.run(),
        }),
        entry.disabled,
      )),
    ]
  }

  if (!selection || !can) {
    const placePlantsAt = request.placePlantsAt
    const placePlantsEntries = withSeparator(projectEntry(
      { id: 'place-plants-here', needsSpatialEditing: true, hidden: !placePlantsAt },
      commandContext,
      (disabled) => ({
        id: 'place-plants-here',
        label: options.translate('canvas.contextMenu.placePlantsHere'),
        disabled,
        run: () => placePlantsAt?.(world),
      }),
    ))
    return [
      ...finishEntries,
      ...edgeEntries,
      ...placePlantsEntries,
      ...paste,
      ...editEntries('select-all', () => commands.selectAll()),
    ]
  }

  const species = options.summary?.species ?? []
  const oneSpecies = species.length === 1 ? species[0]!.canonicalName : null
  const plants = selectionIncludesPlants(selection)

  const appearance = (kind: PlantAppearanceKind, labelKey: LocaleKey): readonly CanvasContextMenuCommand[] => {
    const id = kind === 'color' ? 'plant-color' : 'plant-symbol'
    return projectEntry(
      { id, needsSpatialEditing: true, hidden: !plants },
      commandContext,
      (disabled) => ({
        id,
        label: options.translate(labelKey),
        disabled,
        opensDialog: true,
        run: (itemBounds) => {
          const bounds = itemBounds ?? request.anchor
          options.openPlantAppearance(kind, {
            getBoundingClientRect: () => ({ top: bounds.top, right: bounds.right }),
            focus: () => request.returnFocus(),
          })
        },
      }),
      !can.plantAppearance,
    )
  }

  const plain = <T,>(
    id: CanvasContextMenuItemId,
    labelKey: LocaleKey,
    target: T | null,
    run: (target: T) => void,
    row: Omit<CommandOrToolRow, 'id'>,
  ): readonly CanvasContextMenuCommand[] => projectEntry(
    { id, ...row },
    commandContext,
    (disabled) => ({
      id,
      label: options.translate(labelKey),
      disabled,
      run: () => {
        if (target !== null) run(target)
      },
    }),
    target === null,
  )

  const calendarTarget = calendarTargetFor(selection)
  const planningEntries = withSeparator([
    ...plain('add-to-calendar', 'canvas.contextMenu.addToCalendar', calendarTarget, options.addToCalendar, {
      needsSpatialEditing: true,
    }),
    ...plain('set-unit-cost', 'canvas.contextMenu.setUnitCost', oneSpecies, options.setUnitCost, {
      needsSpatialEditing: true,
      hidden: !plants,
    }),
  ])

  const plantEntries = withSeparator([
    ...editEntries('select-same-species', () => commands.selectSameSpecies(), {}, { hidden: !plants }),
    ...appearance('color', 'canvas.plantColor.label'),
    ...appearance('symbol', 'canvas.plantSymbol.label'),
    ...projectEntry(
      { id: 'toggle-plant-names', needsSpatialEditing: true, hidden: !plants },
      commandContext,
      (disabled) => ({
        id: 'toggle-plant-names',
        label: options.translate(can.plantNamesPinned ? 'canvas.contextMenu.hideName' : 'canvas.contextMenu.showName'),
        disabled,
        run: () => commands.toggleSelectedPlantNamePins(),
      }),
      !can.plantAppearance,
    ),
    ...plain('species-details', 'canvas.contextMenu.speciesDetails', oneSpecies, options.openSpeciesDetail, {
      needsCanvas: true,
      hidden: !plants,
    }),
  ])

  // Rename zone… names one lone zone; a locked one keeps the item, disabled.
  const loneZone = calendarTarget?.kind === 'zone' ? calendarTarget.zoneId : null
  const renameZoneId = loneEditableZoneId(selection)
  const zoneEntries = withSeparator(projectEntry(
    { id: 'rename-zone', needsSpatialEditing: true, hidden: loneZone === null },
    commandContext,
    (disabled) => ({
      id: 'rename-zone',
      label: options.translate('canvas.contextMenu.renameZone'),
      disabled,
      run: () => {
        if (renameZoneId === null) return
        openRenameZoneDialog({
          zoneId: renameZoneId,
          name: options.summary?.zones[0]?.name ?? null,
          rename: (zoneId, name) => commands.renameZone(zoneId, name),
          returnFocus: () => request.returnFocus(),
        })
      },
    }),
    renameZoneId === null,
  ))

  // Profile this line: a lone Line zone or Measure guide, locked or not, since a profile edits nothing.
  // Gated by `site-data-below-limit` via `commandApplicability` (S14).
  const lineTarget = profileLineTarget(selection, options.summary)
  const profiler = options.profileLine
  const profileEntries = withSeparator(projectEntry(
    {
      id: 'profile-line',
      requires: ['site-data-below-limit'],
      needsCanvas: true,
      hidden: !lineTarget || !profiler,
    },
    commandContext,
    (disabled) => ({
      id: 'profile-line',
      label: options.translate('canvas.contextMenu.profileLine'),
      disabled,
      run: () => {
        if (profiler && lineTarget) profiler.profile(lineTarget)
      },
    }),
    !profiler?.available,
  ))

  const arrange: readonly CanvasContextMenuEntry[] = [
    ...editEntries('bring-to-front', () => commands.bringToFront()),
    ...editEntries('send-to-back', () => commands.sendToBack()),
    SEPARATOR,
    ...editEntries('group', () => commands.groupSelected()),
    ...editEntries('ungroup', () => commands.ungroupSelected()),
  ]

  return [
    ...finishEntries,
    ...editEntries('cut', () => {
      commands.copy()
      commands.deleteSelected()
    }),
    ...editEntries('copy', () => commands.copy()),
    ...paste,
    ...editEntries('duplicate', () => commands.duplicateSelected()),
    SEPARATOR,
    ...plantEntries,
    ...zoneEntries,
    ...profileEntries,
    ...planningEntries,
    {
      id: 'arrange',
      label: options.translate('menu.edit.arrange'),
      disabled: arrange.every((entry) => 'separator' in entry || entry.disabled),
      submenu: arrange,
    },
    ...editEntries('rotate', () => openRotateSelectionDialog({
      rotate: (degrees) => commands.rotateSelected(degrees),
      returnFocus: () => request.returnFocus(),
    })),
    ...editEntries(
      'save-as-stamp',
      () => request.saveSelectionAsObjectStamp?.(),
      {},
      { hidden: !request.saveSelectionAsObjectStamp },
    ),
    SEPARATOR,
    ...edgeEntries,
    ...editEntries('lock', () => commands.lockSelected()),
    ...editEntries('unlock', () => commands.unlockSelected()),
    SEPARATOR,
    ...editEntries('delete', () => commands.deleteSelected(), { danger: true }),
  ]
}

function editCommand(
  definition: CanvasEditCommandDefinition,
  disabled: boolean,
  run: () => void,
  translate: (key: LocaleKey) => string,
  characterKeys: boolean,
  extra: Partial<CanvasContextMenuCommand>,
): CanvasContextMenuCommand {
  return {
    id: definition.id,
    label: translate(definition.labelKey),
    ...shortcutOf(definition, translate, characterKeys),
    disabled,
    run: () => {
      if (!disabled) run()
    },
    ...extra,
  }
}

function editDefinition(id: CanvasEditAction): CanvasEditCommandDefinition {
  const definition = canvasCommandDefinitions.find(
    (candidate): candidate is CanvasEditCommandDefinition => candidate.kind === 'edit' && candidate.id === id,
  )
  if (!definition) throw new Error(`Missing Canvas edit command '${id}'`)
  return definition
}

/** An edit command's shortcut as the menu shows and announces it. Only real shortcuts: Deselect's Esc hint belongs to
 *  the map, not this menu. */
function shortcutOf(
  definition: CanvasEditCommandDefinition,
  translate: (key: LocaleKey) => string,
  characterKeys: boolean,
): Pick<CanvasContextMenuCommand, 'shortcut' | 'keyShortcuts'> {
  const shortcut = definition.shortcuts ? canvasCommandDisplayKey(definition, characterKeys) : undefined
  if (!shortcut) return {}
  const keyShortcuts = canvasCommandAriaKeys(definition, characterKeys)
  return { shortcut: formatShortcut(shortcut, translate), ...(keyShortcuts ? { keyShortcuts } : {}) }
}

/**
 * The keys a point menu (A16) takes for its Delete point while it is open: Delete's (Delete, Backspace). The canvas
 * menu's keys are its entries' shortcuts on what it names (Delete on the selection's menu deletes the selection), and a
 * point menu names a point, so they delete that point, never the selection (components/canvas/CanvasContextMenu).
 */
export function deletePointShortcuts(): readonly string[] {
  return editDefinition('delete').shortcuts ?? []
}

/**
 * Add to calendar… aims at the selected plants (the Calendar's "Selected on
 * map" target, editable plants only), else at one lone zone; null otherwise.
 */
function calendarTargetFor(selection: CanvasDesignObjectSelectionModel): CalendarAddTarget | null {
  if (selection.plantNamePinning.plantIds.length > 0) return { kind: 'selected-plants' }
  const targets = [...selection.editableTargets, ...selection.lockedTargets]
  const [only] = targets
  return targets.length === 1 && only?.kind === 'zone' ? { kind: 'zone', zoneId: only.id } : null
}

/** The lone Line zone or Measure guide a menu acts on, or null. */
function profileLineTarget(
  selection: CanvasDesignObjectSelectionModel,
  summary: MapSelectionSummary | null,
): { readonly kind: 'zone' | 'measurement-guide'; readonly id: string } | null {
  const targets = [...selection.editableTargets, ...selection.lockedTargets]
  const [only] = targets
  if (targets.length !== 1 || !only) return null
  if (only.kind === 'measurement-guide') return { kind: 'measurement-guide', id: only.id }
  return only.kind === 'zone' && summary?.zones.length === 1 && summary.zones[0]!.zoneType === 'line'
    ? { kind: 'zone', id: only.id }
    : null
}
