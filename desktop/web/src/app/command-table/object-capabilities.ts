// app/command-table/object-capabilities.ts  (L2 rank 2; type-only imports of L0; imports no feature)
//
// The 28 x 57 object-action capability matrix (2.1-Q147, 2.1-M86, 2.1-M163, 2.1-M164,
// contracts §21): keyed on `ObjectKind` (`types/design-object-kinds.ts`), with
// `ObjectOwner`, `Backing`, `ownerOf(row)`, and `cellOn(root, kind, action)`.

import type { EditionCapabilityId, EditionCapabilitySet } from '../../generated/edition-capabilities'
import { DOCUMENT_FILE_FIELD_OWNERS, type KnownCanopiKey } from '../../generated/known-canopi-keys'
import type { ObjectKind } from '../../types/design-object-kinds'
import { lackingCapabilities } from './applicability'
import type { CommandOrToolId } from './tools'

export const CAPABILITIES = [
  { id: 'select' }, { id: 'band-select' }, { id: 'select-all' }, { id: 'select-same-species' },
  { id: 'move' }, { id: 'keyboard-nudge' }, { id: 'rotate-handle' }, { id: 'rotate-by-value' },
  { id: 'reshape-vertices' }, { id: 'resize-scale' },
  { id: 'edit-by-values' }, { id: 'draw-constraints' }, { id: 'snap-to-grid' }, { id: 'copy-cut-paste' },
  { id: 'duplicate' }, { id: 'delete' }, { id: 'undo-redo' }, { id: 'group-ungroup' },
  { id: 'lock-unlock' }, { id: 'layer-visibility-lock-opacity' },
  { id: 'layer-assignment' }, { id: 'z-order' }, { id: 'plant-style' }, { id: 'zone-style' },
  { id: 'rename-zone' }, { id: 'edit-note-text' }, { id: 'plant-labels' }, { id: 'measure-show-dimensions' },
  { id: 'inspect-selection-chip' }, { id: 'hover-tooltip' },
  { id: 'inspection-lens' }, { id: 'species-details' }, { id: 'species-focus' }, { id: 'find-plants' },
  { id: 'zoom-to-selection' }, { id: 'turn-view-to-edge' }, { id: 'context-menu' }, { id: 'place-plants' },
  { id: 'plant-a-row' }, { id: 'object-stamp' },
  { id: 'save-as-stamp' }, { id: 'place-from-stamp' }, { id: 'stamp-library-manage' },
  { id: 'geojson-export-import' }, { id: 'budget-csv-export' }, { id: 'pdf-export' }, { id: 'pdf-page-edit' },
  { id: 'pdf-per-view-rotation' }, { id: 'saved-views' }, { id: 'stories' },
  { id: 'calendar-budget-targets' }, { id: 'profile-line' }, { id: 'site-data-display' },
  { id: 'multi-select-edit' }, { id: 'align-distribute' }, { id: 'touch-gestures' },
  { id: 'design-template-import' },
] as const satisfies readonly { readonly id: string }[]

export type Capability = (typeof CAPABILITIES)[number]['id']

export type Cell =
  | { readonly state: 'yes'; readonly via: readonly CommandOrToolId[] }
  | { readonly state: 'partial' | 'no'; readonly gap: string }
  | { readonly state: 'partial' | 'no'; readonly decision: string }
  | { readonly state: 'n/a'; readonly reason: string }

export type ObjectOwner = 'scene' | 'document' | 'data-library' | 'map-layer-store' | 'stamp-store' | 'tool-session'
export type SceneTargetKind = 'plant' | 'zone' | 'annotation' | 'measurement-guide' | 'group'
export type PdfPageKind = 'overview' | 'detail' | 'split' | 'key' | 'furniture'

export type Backing =
  | { readonly field: KnownCanopiKey }
  | { readonly sceneTarget: SceneTargetKind }
  | { readonly printSetup: PdfPageKind | 'setup' }
  | { readonly store: 'data-library' | 'map-layer-store' | 'stamp-store' }
  | { readonly transient: 'tool-session' }

export interface ObjectKindRow {
  readonly id: ObjectKind
  readonly backing: Backing
  readonly references?: readonly Backing[]
  readonly requires?: readonly EditionCapabilityId[]
}

export const OBJECT_KIND_ROWS: Readonly<Record<ObjectKind, ObjectKindRow>> = {
  plant: { id: 'plant', backing: { sceneTarget: 'plant' }, references: [{ field: 'plants' }] },
  'zone-rect': { id: 'zone-rect', backing: { sceneTarget: 'zone' }, references: [{ field: 'zones' }] },
  'zone-ellipse': { id: 'zone-ellipse', backing: { sceneTarget: 'zone' }, references: [{ field: 'zones' }] },
  'zone-polygon': { id: 'zone-polygon', backing: { sceneTarget: 'zone' }, references: [{ field: 'zones' }] },
  'zone-line': { id: 'zone-line', backing: { sceneTarget: 'zone' }, references: [{ field: 'zones' }] },
  'text-note': { id: 'text-note', backing: { sceneTarget: 'annotation' }, references: [{ field: 'annotations' }] },
  'measurement-guide': { id: 'measurement-guide', backing: { sceneTarget: 'measurement-guide' }, references: [{ field: 'measurement_guides' }] },
  group: { id: 'group', backing: { sceneTarget: 'group' }, references: [{ field: 'groups' }] },
  'scene-layer': { id: 'scene-layer', backing: { field: 'layers' } },
  'species-appearance': { id: 'species-appearance', backing: { field: 'plant_species_colors' }, references: [{ field: 'plant_species_codes' }, { field: 'plant_species_symbols' }] },
  'site-data-entry': { id: 'site-data-entry', backing: { store: 'data-library' }, references: [{ field: 'lidar' }], requires: ['site-data-below-limit'] },
  'analysis-result': { id: 'analysis-result', backing: { store: 'data-library' }, references: [{ field: 'lidar' }], requires: ['site-data-below-limit'] },
  'map-background': { id: 'map-background', backing: { store: 'map-layer-store' } },
  'saved-view': { id: 'saved-view', backing: { field: 'views' } },
  'design-map-view': { id: 'design-map-view', backing: { field: 'map_view' } },
  story: { id: 'story', backing: { field: 'stories' } },
  'calendar-action': { id: 'calendar-action', backing: { field: 'timeline' } },
  'budget-item': { id: 'budget-item', backing: { field: 'budget' }, references: [{ field: 'budget_currency' }] },
  'consortium-entry': { id: 'consortium-entry', backing: { field: 'consortiums' } },
  'saved-object-stamp': { id: 'saved-object-stamp', backing: { store: 'stamp-store' }, requires: ['saved-stamps'] },
  'plant-row-path': { id: 'plant-row-path', backing: { transient: 'tool-session' } },
  'profile-line': { id: 'profile-line', backing: { transient: 'tool-session' }, requires: ['site-data-below-limit'] },
  'pdf-setup': { id: 'pdf-setup', backing: { printSetup: 'setup' } },
  'pdf-overview-page': { id: 'pdf-overview-page', backing: { printSetup: 'overview' } },
  'pdf-detail-page': { id: 'pdf-detail-page', backing: { printSetup: 'detail' } },
  'pdf-split-sheets': { id: 'pdf-split-sheets', backing: { printSetup: 'split' } },
  'pdf-key-page': { id: 'pdf-key-page', backing: { printSetup: 'key' } },
  'pdf-page-furniture': { id: 'pdf-page-furniture', backing: { printSetup: 'furniture' } },
} satisfies Record<ObjectKind, ObjectKindRow>

/** The only way to read a kind's owner (contracts §21). */
export function ownerOf(row: ObjectKindRow): ObjectOwner {
  if ('field' in row.backing) return DOCUMENT_FILE_FIELD_OWNERS[row.backing.field]
  if ('sceneTarget' in row.backing) return 'scene'
  if ('printSetup' in row.backing) return 'document'
  if ('store' in row.backing) return row.backing.store
  return 'tool-session'
}

/** Capability gates declared on commands/tools referenced in `Cell.via`. */
export const COMMAND_REQUIRES: Readonly<Partial<Record<CommandOrToolId, readonly EditionCapabilityId[]>>> = {
  'file.open': ['file-home'],
  'file.save': ['file-home'],
  'file.saveAs': ['save-as-path'],
  'file.exit': ['quit-app'],
  'file.addData': ['site-data-below-limit'],
  'file.dataLibrary': ['site-data-below-limit'],
  'nav.siteData': ['site-data-below-limit'],
  'nav.designNotebook': ['design-notebook'],
  'siteData.profile': ['site-data-below-limit'],
  profile: ['site-data-below-limit'],
  'canvas.saveSelectionAsStamp': ['saved-stamps'],
  'saved-object-stamp': ['saved-stamps'],
}

const DEFAULT_VIA: Readonly<Record<Capability, readonly CommandOrToolId[]>> = {
  select: ['select'],
  'band-select': ['select'],
  'select-all': ['canvas.selectAll'],
  'select-same-species': ['canvas.selectSameSpecies'],
  move: ['select'],
  'keyboard-nudge': ['select'],
  'rotate-handle': ['select'],
  'rotate-by-value': ['canvas.rotateSelected'],
  'reshape-vertices': ['select'],
  'resize-scale': ['select'],
  'edit-by-values': ['select'],
  'draw-constraints': ['polygon'],
  'snap-to-grid': ['canvas.toggleSnapToGrid'],
  'copy-cut-paste': ['canvas.copy', 'canvas.cut', 'canvas.paste'],
  duplicate: ['canvas.duplicateSelected'],
  delete: ['canvas.deleteSelected'],
  'undo-redo': ['edit.undo', 'edit.redo'],
  'group-ungroup': ['canvas.groupSelected', 'canvas.ungroupSelected'],
  'lock-unlock': ['canvas.lockSelected', 'canvas.unlockSelected'],
  'layer-visibility-lock-opacity': ['nav.layers'],
  'layer-assignment': ['nav.layers'],
  'z-order': ['canvas.bringToFront', 'canvas.sendToBack'],
  'plant-style': ['nav.speciesKey'],
  'zone-style': ['select'],
  'rename-zone': ['select'],
  'edit-note-text': ['text'],
  'plant-labels': ['view.cycleLabels'],
  'measure-show-dimensions': ['measurement-guide'],
  'inspect-selection-chip': ['select'],
  'hover-tooltip': ['select'],
  'inspection-lens': ['select'],
  'species-details': ['nav.plantDb'],
  'species-focus': ['nav.speciesKey'],
  'find-plants': ['edit.findPlants'],
  'zoom-to-selection': ['view.zoomToSelection'],
  'turn-view-to-edge': ['view.turnViewLeft', 'view.turnViewRight'],
  'context-menu': ['select'],
  'place-plants': ['plant-stamp'],
  'plant-a-row': ['plant-spacing'],
  'object-stamp': ['object-stamp'],
  'save-as-stamp': ['canvas.saveSelectionAsStamp'],
  'place-from-stamp': ['saved-object-stamp'],
  'stamp-library-manage': ['nav.favorites'],
  'geojson-export-import': ['file.exportGeoJson', 'file.importGeoJson'],
  'budget-csv-export': ['file.exportBudgetCsv'],
  'pdf-export': ['file.exportCanvasPdf'],
  'pdf-page-edit': ['file.exportCanvasPdf'],
  'pdf-per-view-rotation': ['file.exportCanvasPdf'],
  'saved-views': ['view.saveCurrentView', 'view.manageViews'],
  stories: ['nav.stories'],
  'calendar-budget-targets': ['nav.calendar', 'nav.budget'],
  'profile-line': ['siteData.profile', 'profile'],
  'site-data-display': ['nav.siteData'],
  'multi-select-edit': ['select'],
  'align-distribute': ['select'],
  'touch-gestures': ['select'],
  'design-template-import': ['nav.templates'],
}

// Compact 57-character matrix encoding from `capability-matrix.md` (Y=yes, P=partial, N=no, -=n/a).
const MATRIX_CODES: Readonly<Record<ObjectKind, string>> = {
  plant: 'YYYPY YPP-N N-YYY YYYYY NYY-- NYPYP YYYYY -YYPY PPPYP PY-YY Y-NYN YP'.replace(/\s+/g, ''),
  'zone-rect': 'YYY-Y YYYYP PYYYY YYYYY NY-NP N-PYN Y--NY YP-NY YYYYN PP-YY PNYPN PP'.replace(/\s+/g, ''),
  'zone-ellipse': 'YYY-Y YYYYP PYYYY YYYYY NY-NP N-PYN Y--NY NP-NY YYYYN PP-YY PNYPN PP'.replace(/\s+/g, ''),
  'zone-polygon': 'YYY-Y YYYYP PYYYY YYYYY NY-NP N-PYN Y--NY YP-NY YYYYN PP-YY PNYPN YP'.replace(/\s+/g, ''),
  'zone-line': 'YYY-Y YYYYP PYYYY YYYYY NY-NP N-PYN Y--NY YY-NY YYYYN PP-YY PYYPN PP'.replace(/\s+/g, ''),
  'text-note': 'YYY-Y YYY-N P-PYY YYYYY NY--- P--YN N--NY -P--Y YYY-- YP-PP ---PN YP'.replace(/\s+/g, ''),
  'measurement-guide': 'YYY-Y YYYYP PYYYY YYNYN NY--- NN-PY N---P NP-NN NNNY- YP-PP -YYPN PP'.replace(/\s+/g, ''),
  group: 'PYYNY YYYNN P-YYY YYYPP NYPNN NYNPN PN-NY -P-NY YYY-- NN-PP N--PN YP'.replace(/\s+/g, ''),
  'scene-layer': '--P-- ----- ----- -Y--Y NN-PP PP--- P---N ----- ----- YP-PY ----- --'.replace(/\s+/g, ''),
  'species-appearance': '---Y- ----- ---P- PP--- --P-- -Y--P YYYYY -PYY- PPPNN YY-PP Y--P- YN'.replace(/\s+/g, ''),
  'site-data-entry': '----- ----- ---NN YN--Y -Y--- --P-N N---P ----- ----- NN-PY -YPP- YN'.replace(/\s+/g, ''),
  'analysis-result': '----- ----- ----N YN--Y -Y--- ----N N---P ----- ----- NN-PY -NP-- -N'.replace(/\s+/g, ''),
  'map-background': '----- ----- ----- -N--Y ----- ----- N---- ----- ----- NN-PY --P-- --'.replace(/\s+/g, ''),
  'saved-view': '----- --N-- ---NN YP--- P-P-- -YP-- -NP-- Y---- ----- NNYY- --PY- YN'.replace(/\s+/g, ''),
  'design-map-view': '----- ----- ----- ----- ----- ----- ----- Y---- ----- PNP-- ----- Y-'.replace(/\s+/g, ''),
  story: '----- ----- ---NP YP--- P---- -YP-- -NY-- Y---- ----- NNN-Y ----- YN'.replace(/\s+/g, ''),
  'calendar-action': '----- ----- ---NN YN--- ----- ----- -NNPN -P--- NNN-N N---- Y--P- PN'.replace(/\s+/g, ''),
  'budget-item': '----- ----- ---N- NN--- ----- ----- -NYPN -P--- NNN-P N---- P--P- PN'.replace(/\s+/g, ''),
  'consortium-entry': '----- ----- ---N- NN--- ----- ----- -NYPN -N--- NNN-N N---- ---P- PN'.replace(/\s+/g, ''),
  'saved-object-stamp': '----P NPP-N N-Y-N YPPNP N-PPP PPNNP -N-P- -P-NP -PPN- ----- ---P- Y-'.replace(/\s+/g, ''),
  'plant-row-path': '----P NNNP- PYY-- -YP-Y ----- -NY-- N---- -Y-Y- ----- ----- -N--- Y-'.replace(/\s+/g, ''),
  'profile-line': '----N N-NN- NYY-- -Y--- ----- --Y-- N---- -P--- ----- N--NN -YY-- Y-'.replace(/\s+/g, ''),
  'pdf-setup': '----- -NP-- P---- -N--P P-PN- -N--- --N-- P---- ----- YYN-N --N-- --'.replace(/\s+/g, ''),
  'pdf-overview-page': 'Y---Y YNN-P P---- N---P ----P YPP-N -NN-Y P---- ----- YPNN- --N-- P-'.replace(/\s+/g, ''),
  'pdf-detail-page': 'PNN-Y YNNNN PNNNN YN--P N-N-P YYY-N --N-P PN--- ----- YPNN- --NNN P-'.replace(/\s+/g, ''),
  'pdf-split-sheets': 'PNN-P PNNNN N---N PN--P ----- ----- ----- P---- ----- YYN-- --N-- --'.replace(/\s+/g, ''),
  'pdf-key-page': 'Y---- ----- ----- ----P ----P YYY-N -N-Y- ----- ----N YP--- N---- --'.replace(/\s+/g, ''),
  'pdf-page-furniture': '----N N---- ----- P---- ----- ----- ----- Y---- ----- YPN-- --N-- --'.replace(/\s+/g, ''),
}

function holeCell(kind: ObjectKind, cap: Capability, state: 'partial' | 'no'): Cell {
  // Decided holes (2.1-Q365): profile-line is a transient tool result.
  if (kind === 'profile-line') return { state, decision: '2.1-Q365' }
  if (kind === 'species-appearance' && (cap === 'delete' || cap === 'context-menu')) {
    return { state, gap: 'canopi-qjuzy' }
  }
  if (kind === 'pdf-overview-page' && cap === 'delete') {
    return { state, gap: 'canopi-z1ie7' }
  }
  if (kind === 'measurement-guide' && cap === 'group-ungroup') {
    return { state, decision: '2.1-Q108' }
  }
  if (kind.startsWith('pdf-') && (cap === 'site-data-display' || cap === 'calendar-budget-targets' || cap === 'budget-csv-export')) {
    return { state, decision: 'ADR 0008' }
  }
  if (cap === 'context-menu') return { state, gap: 'canopi-f47t.52.6' }
  if (kind === 'measurement-guide') return { state, gap: 'canopi-f47t.52.155' }
  if (kind === 'saved-object-stamp') return { state, gap: 'canopi-f47t.52.160' }
  return { state, gap: 'canopi-f47t.52.179' }
}

function buildMatrix(): Record<ObjectKind, Record<Capability, Cell>> {
  const matrix = {} as Record<ObjectKind, Record<Capability, Cell>>
  for (const kind of Object.keys(OBJECT_KIND_ROWS) as ObjectKind[]) {
    const code = MATRIX_CODES[kind]
    if (code.length !== CAPABILITIES.length) {
      throw new Error(`Capability matrix row '${kind}' has ${code.length} cells, expected ${CAPABILITIES.length}`)
    }
    const row = {} as Record<Capability, Cell>
    for (let i = 0; i < CAPABILITIES.length; i += 1) {
      const cap = CAPABILITIES[i]!.id
      const ch = code[i]!
      if (ch === 'Y') row[cap] = { state: 'yes', via: DEFAULT_VIA[cap] }
      else if (ch === 'P') row[cap] = holeCell(kind, cap, 'partial')
      else if (ch === 'N') row[cap] = holeCell(kind, cap, 'no')
      else row[cap] = { state: 'n/a', reason: `${kind} does not participate in ${cap}` }
    }
    matrix[kind] = row
  }
  return matrix
}

export const CAPABILITY_MATRIX = buildMatrix() satisfies Record<ObjectKind, Record<Capability, Cell>>

/**
 * Evaluates a matrix cell for an edition/OS capability set (contracts §21):
 * returns `{ state: 'lacking', requires }` when the root lacks any capability
 * required by the object kind or any command/tool in `cell.via`.
 */
export function cellOn(
  root: EditionCapabilitySet,
  kind: ObjectKind,
  action: Capability,
): Cell | { readonly state: 'lacking'; readonly requires: readonly EditionCapabilityId[] } {
  const cell = CAPABILITY_MATRIX[kind][action]
  if (cell.state === 'n/a') return cell
  const needed = new Set<EditionCapabilityId>(OBJECT_KIND_ROWS[kind].requires ?? [])
  if (cell.state === 'yes') {
    for (const via of cell.via) {
      for (const req of COMMAND_REQUIRES[via] ?? []) needed.add(req)
    }
  }
  const missing = lackingCapabilities([...needed], root)
  return missing.length > 0 ? { state: 'lacking', requires: missing } : cell
}
