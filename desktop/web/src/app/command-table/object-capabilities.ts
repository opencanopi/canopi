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
// Exact 28x57 codes mechanically seeded from gate-logs/arch-2-1/capability-matrix.md (2.1-Q147, 2.1-M86).
const MATRIX_CODES: Readonly<Record<ObjectKind, string>> = {
  'plant': 'YYYPYYPP-NN-YYYYYYYYNYY--NYPYPYYYYY-YYPYPPPYPPY-YYY-NYNYP',
  'zone-rect': 'YYY-YYYYYPPYYYYYYYYYNY-NPN-PYNY--NYYP-NYYYYYNPP-YYPN-PNPP',
  'zone-ellipse': 'YYY-YYYYYPPYYYYYYYYYNY-NPN-PYNY--NYNP-NYYYYYNPP-YYPN-PNPP',
  'zone-polygon': 'YYY-YYYYYPPYYYYYYYYYNY-NPN-PYNY--NYYP-NYYYYYNPP-YYPN-PNYP',
  'zone-line': 'YYY-YYYYYPPYYYYYYYYYNY-NPN-PYNY--NYYY-NYYYYYNPP-YYPYYPNPP',
  'text-note': 'YYY-YYYY-NP-PYYYYYYYNY---P--YNN--NY-P--YYYYY-YP-PP---PNYP',
  'measurement-guide': 'YYY-YYYYYPPYYYYYYNYYNY--NN-PYNN---PNP-NNNNNY-YP-PP-YYPNPP',
  'group': 'PYYNYYYYNNP-YYYYYPYPNYPNNNYNPNPN-NY-P-NYYYYY-NN-PPN--PNYP',
  'scene-layer': '--P-------------Y--YNN-P-PPP--P---N----------YP-PY-------',
  'species-appearance': '---Y---------P-PP-----P---Y--PYYYYY-PYY-PPPNNYY-PPY--P-YN',
  'site-data-entry': '-------------NNYN--Y-Y-----P-NN---P----------NN-PY-YPP-YN',
  'analysis-result': '--------------NYN--Y-Y-------NN---P----------NN-PY-NP---N',
  'map-background': '----------------N--Y----------N--------------NN-PY--P----',
  'saved-view': '-------N-----NNYP---P-P---YP---NP--Y---------NNNYY--PY-YN',
  'design-map-view': '-----------------------------------Y---------PNP-------Y-',
  'story': '-------------NPYP---P-----YP---NY--Y---------NNN-Y-----YN',
  'calendar-action': '-------------NNYN--------------NNPN-P---NNN-NN----Y--P-PN',
  'budget-item': '-------------N-NN--------------NYPN-P---NNN-PN----P--P-PN',
  'consortium-entry': '-------------N-NN--------------NYPN-N---NNN-NN-------P-PN',
  'saved-object-stamp': '----PNPP-NN-Y-NYPPNPN-PPPPNNP--N-P--P-NP-PPN---------P-Y-',
  'plant-row-path': '----PNNNP-PYY---YP-Y------NY--N-----Y-Y------------N---Y-',
  'profile-line': '----NN-NN-NYY---Y----------Y--N-----P--------N--NN-YY--Y-',
  'pdf-setup': '------NP--P-----N--PP-PN--N-----N--P---------YYNNN--N----',
  'pdf-overview-page': 'Y---YYNN-PP----N---P----PYPP-N-NN-YP---------YPNN---N--P-',
  'pdf-detail-page': 'PNN-YYNNNPPNNNNYN--PN-N-PYYY-N--N-PPN--------YPNN---NNNP-',
  'pdf-split-sheets': 'PNN-PPNNNNN---NPN--P---------------P---------YYN----N----',
  'pdf-key-page': 'Y------------------P----PYYY---N-Y----------NYP---N------',
  'pdf-page-furniture': '----NN---------P-------------------Y---------YPN---------',
}

// Deliberate exceptions (`decision` cells, non-superseded ledger/ADR ids; 2.1-Q147, 2.1-Q365).
const DECISION_CELLS_BY_ID: Readonly<Record<string, readonly string[]>> = {
  '2.1-Q147': ['zone-rect:budget-csv-export', 'zone-rect:calendar-budget-targets', 'zone-ellipse:budget-csv-export', 'zone-ellipse:calendar-budget-targets', 'zone-polygon:budget-csv-export', 'zone-polygon:calendar-budget-targets', 'zone-line:budget-csv-export', 'zone-line:calendar-budget-targets', 'text-note:hover-tooltip', 'analysis-result:duplicate', 'analysis-result:undo-redo', 'budget-item:context-menu', 'budget-item:budget-csv-export', 'budget-item:calendar-budget-targets', 'plant-row-path:move', 'plant-row-path:keyboard-nudge', 'plant-row-path:rotate-handle', 'plant-row-path:rotate-by-value', 'plant-row-path:reshape-vertices', 'plant-row-path:group-ungroup'],
  '2.1-Q365': ['profile-line:move', 'profile-line:keyboard-nudge', 'profile-line:rotate-by-value', 'profile-line:reshape-vertices', 'profile-line:edit-by-values', 'profile-line:inspection-lens', 'profile-line:context-menu', 'profile-line:pdf-export', 'profile-line:saved-views', 'profile-line:stories'],
  '2.1-Q56': ['plant:pdf-export'],
  'ADR 0007': ['group:group-ungroup', 'group:layer-visibility-lock-opacity', 'group:layer-assignment', 'calendar-action:save-as-stamp', 'calendar-action:place-from-stamp', 'calendar-action:stamp-library-manage', 'budget-item:save-as-stamp', 'budget-item:place-from-stamp', 'budget-item:stamp-library-manage', 'consortium-entry:save-as-stamp', 'consortium-entry:place-from-stamp', 'consortium-entry:stamp-library-manage'],
  'ADR 0008': ['zone-rect:pdf-export', 'zone-ellipse:pdf-export', 'zone-polygon:pdf-export', 'zone-line:pdf-export', 'site-data-entry:pdf-export', 'site-data-entry:pdf-page-edit', 'analysis-result:pdf-export', 'map-background:pdf-export', 'map-background:pdf-page-edit', 'calendar-action:pdf-export', 'budget-item:pdf-export', 'consortium-entry:pdf-export', 'pdf-setup:layer-visibility-lock-opacity', 'pdf-setup:site-data-display', 'pdf-overview-page:layer-visibility-lock-opacity', 'pdf-overview-page:site-data-display', 'pdf-detail-page:layer-visibility-lock-opacity', 'pdf-detail-page:site-data-display', 'pdf-split-sheets:layer-visibility-lock-opacity', 'pdf-split-sheets:site-data-display', 'pdf-key-page:layer-visibility-lock-opacity', 'pdf-key-page:budget-csv-export', 'pdf-key-page:calendar-budget-targets'],
  'ADR 0015': ['plant:rotate-handle', 'plant:rotate-by-value'],
  'ADR 0019': ['map-background:inspection-lens'],
  'ADR 0024': ['map-background:undo-redo'],
}

// Gap cells (`gap` cells, open owning beads in .beads/issues.jsonl; ratcheted by policy/ratchets/object-capability-gaps.json).
const GAP_CELLS_BY_BEAD: Readonly<Record<string, readonly string[]>> = {
  'canopi-0rl5': ['budget-item:copy-cut-paste', 'budget-item:delete', 'budget-item:species-details', 'budget-item:zoom-to-selection', 'budget-item:multi-select-edit'],
  'canopi-b5c7': ['consortium-entry:copy-cut-paste', 'consortium-entry:delete', 'consortium-entry:species-details', 'consortium-entry:find-plants', 'consortium-entry:zoom-to-selection', 'consortium-entry:context-menu', 'consortium-entry:budget-csv-export', 'consortium-entry:multi-select-edit'],
  'canopi-f47t.52.10': ['story:copy-cut-paste', 'story:duplicate', 'story:layer-assignment', 'story:measure-show-dimensions', 'story:species-details'],
  'canopi-f47t.52.123': ['species-appearance:undo-redo', 'site-data-entry:undo-redo', 'saved-view:undo-redo', 'story:undo-redo', 'calendar-action:undo-redo', 'budget-item:undo-redo', 'consortium-entry:undo-redo'],
  'canopi-f47t.52.133': ['zone-rect:touch-gestures', 'zone-ellipse:touch-gestures', 'zone-line:touch-gestures', 'consortium-entry:touch-gestures'],
  'canopi-f47t.52.140': ['saved-view:rotate-by-value', 'saved-view:copy-cut-paste', 'saved-view:duplicate', 'saved-view:layer-assignment', 'saved-view:plant-style', 'saved-view:measure-show-dimensions', 'saved-view:species-details', 'saved-view:species-focus', 'saved-view:site-data-display'],
  'canopi-f47t.52.155': ['measurement-guide:resize-scale', 'measurement-guide:edit-by-values', 'measurement-guide:group-ungroup', 'measurement-guide:layer-assignment', 'measurement-guide:rename-zone', 'measurement-guide:edit-note-text', 'measurement-guide:measure-show-dimensions', 'measurement-guide:hover-tooltip', 'measurement-guide:inspection-lens', 'measurement-guide:zoom-to-selection', 'measurement-guide:turn-view-to-edge', 'measurement-guide:context-menu', 'measurement-guide:plant-a-row', 'measurement-guide:object-stamp', 'measurement-guide:save-as-stamp', 'measurement-guide:place-from-stamp', 'measurement-guide:stamp-library-manage', 'measurement-guide:saved-views', 'measurement-guide:stories', 'measurement-guide:multi-select-edit', 'measurement-guide:align-distribute', 'measurement-guide:touch-gestures'],
  'canopi-f47t.52.156': ['plant:save-as-stamp', 'plant:place-from-stamp', 'plant:stamp-library-manage', 'species-appearance:save-as-stamp', 'species-appearance:place-from-stamp', 'species-appearance:stamp-library-manage', 'saved-object-stamp:move', 'saved-object-stamp:keyboard-nudge', 'saved-object-stamp:rotate-handle', 'saved-object-stamp:rotate-by-value', 'saved-object-stamp:resize-scale', 'saved-object-stamp:edit-by-values', 'saved-object-stamp:duplicate', 'saved-object-stamp:undo-redo', 'saved-object-stamp:group-ungroup', 'saved-object-stamp:lock-unlock', 'saved-object-stamp:layer-visibility-lock-opacity', 'saved-object-stamp:layer-assignment', 'saved-object-stamp:plant-style', 'saved-object-stamp:zone-style', 'saved-object-stamp:rename-zone', 'saved-object-stamp:edit-note-text', 'saved-object-stamp:plant-labels', 'saved-object-stamp:measure-show-dimensions', 'saved-object-stamp:inspect-selection-chip', 'saved-object-stamp:species-details', 'saved-object-stamp:find-plants', 'saved-object-stamp:context-menu', 'saved-object-stamp:plant-a-row', 'saved-object-stamp:object-stamp', 'saved-object-stamp:place-from-stamp', 'saved-object-stamp:stamp-library-manage', 'saved-object-stamp:geojson-export-import', 'saved-object-stamp:multi-select-edit'],
  'canopi-f47t.52.174': ['zone-rect:pdf-page-edit', 'zone-ellipse:pdf-page-edit', 'zone-polygon:pdf-page-edit', 'zone-line:pdf-page-edit', 'text-note:pdf-page-edit', 'scene-layer:pdf-page-edit', 'saved-view:pdf-export', 'saved-view:pdf-page-edit', 'saved-view:pdf-per-view-rotation', 'design-map-view:pdf-export', 'design-map-view:pdf-page-edit', 'design-map-view:pdf-per-view-rotation', 'story:pdf-export', 'story:pdf-page-edit', 'story:pdf-per-view-rotation', 'pdf-setup:rotate-handle', 'pdf-setup:rotate-by-value', 'pdf-setup:edit-by-values', 'pdf-setup:undo-redo', 'pdf-setup:layer-assignment', 'pdf-setup:plant-style', 'pdf-setup:zone-style', 'pdf-setup:plant-labels', 'pdf-setup:species-focus', 'pdf-setup:turn-view-to-edge', 'pdf-setup:pdf-per-view-rotation', 'pdf-setup:saved-views', 'pdf-setup:stories', 'pdf-overview-page:rotate-handle', 'pdf-overview-page:rotate-by-value', 'pdf-overview-page:resize-scale', 'pdf-overview-page:edit-by-values', 'pdf-overview-page:rename-zone', 'pdf-overview-page:plant-labels', 'pdf-overview-page:measure-show-dimensions', 'pdf-overview-page:species-details', 'pdf-overview-page:species-focus', 'pdf-overview-page:turn-view-to-edge', 'pdf-overview-page:pdf-page-edit', 'pdf-overview-page:pdf-per-view-rotation', 'pdf-overview-page:saved-views', 'pdf-overview-page:touch-gestures', 'pdf-detail-page:select', 'pdf-detail-page:band-select', 'pdf-detail-page:select-all', 'pdf-detail-page:rotate-handle', 'pdf-detail-page:rotate-by-value', 'pdf-detail-page:reshape-vertices', 'pdf-detail-page:resize-scale', 'pdf-detail-page:edit-by-values', 'pdf-detail-page:draw-constraints', 'pdf-detail-page:snap-to-grid', 'pdf-detail-page:copy-cut-paste', 'pdf-detail-page:duplicate', 'pdf-detail-page:undo-redo', 'pdf-detail-page:layer-assignment', 'pdf-detail-page:plant-style', 'pdf-detail-page:rename-zone', 'pdf-detail-page:hover-tooltip', 'pdf-detail-page:species-focus', 'pdf-detail-page:zoom-to-selection', 'pdf-detail-page:turn-view-to-edge', 'pdf-detail-page:context-menu', 'pdf-detail-page:pdf-page-edit', 'pdf-detail-page:pdf-per-view-rotation', 'pdf-detail-page:saved-views', 'pdf-detail-page:multi-select-edit', 'pdf-detail-page:align-distribute', 'pdf-detail-page:touch-gestures', 'pdf-split-sheets:select', 'pdf-split-sheets:band-select', 'pdf-split-sheets:select-all', 'pdf-split-sheets:move', 'pdf-split-sheets:keyboard-nudge', 'pdf-split-sheets:rotate-handle', 'pdf-split-sheets:rotate-by-value', 'pdf-split-sheets:reshape-vertices', 'pdf-split-sheets:edit-by-values', 'pdf-split-sheets:duplicate', 'pdf-split-sheets:delete', 'pdf-split-sheets:undo-redo', 'pdf-split-sheets:turn-view-to-edge', 'pdf-split-sheets:pdf-per-view-rotation', 'pdf-key-page:rename-zone', 'pdf-key-page:species-details', 'pdf-key-page:pdf-page-edit', 'pdf-page-furniture:move', 'pdf-page-furniture:delete', 'pdf-page-furniture:pdf-page-edit', 'pdf-page-furniture:pdf-per-view-rotation'],
  'canopi-f47t.52.48': ['plant:budget-csv-export', 'plant:design-template-import', 'species-appearance:copy-cut-paste', 'species-appearance:hover-tooltip', 'species-appearance:geojson-export-import', 'species-appearance:budget-csv-export', 'species-appearance:saved-views', 'species-appearance:stories', 'species-appearance:multi-select-edit', 'species-appearance:design-template-import', 'site-data-entry:design-template-import', 'analysis-result:design-template-import', 'budget-item:design-template-import'],
  'canopi-f47t.52.5': ['plant:select-same-species', 'plant:plant-a-row', 'zone-rect:plant-a-row', 'zone-rect:profile-line', 'zone-rect:design-template-import', 'zone-ellipse:plant-a-row', 'zone-ellipse:profile-line', 'zone-ellipse:design-template-import', 'zone-polygon:plant-a-row', 'zone-polygon:profile-line', 'zone-polygon:design-template-import', 'zone-line:rename-zone', 'zone-line:plant-a-row', 'zone-line:design-template-import', 'text-note:edit-note-text', 'text-note:design-template-import', 'measurement-guide:pdf-page-edit', 'measurement-guide:design-template-import', 'group:select', 'group:select-same-species', 'group:reshape-vertices', 'group:resize-scale', 'group:edit-by-values', 'group:plant-style', 'group:zone-style', 'group:rename-zone', 'group:edit-note-text', 'group:measure-show-dimensions', 'group:inspect-selection-chip', 'group:hover-tooltip', 'group:inspection-lens', 'group:species-details', 'group:find-plants', 'group:context-menu', 'group:plant-a-row', 'group:pdf-export', 'group:pdf-page-edit', 'group:saved-views', 'group:stories', 'group:calendar-budget-targets', 'group:multi-select-edit', 'group:align-distribute', 'group:design-template-import', 'scene-layer:edit-note-text', 'scene-layer:plant-labels', 'scene-layer:measure-show-dimensions', 'species-appearance:plant-style', 'site-data-entry:measure-show-dimensions', 'analysis-result:hover-tooltip', 'analysis-result:pdf-page-edit', 'saved-view:design-template-import', 'story:design-template-import', 'calendar-action:budget-csv-export', 'calendar-action:touch-gestures', 'calendar-action:design-template-import', 'budget-item:find-plants', 'budget-item:touch-gestures', 'consortium-entry:design-template-import', 'plant-row-path:plant-labels', 'plant-row-path:profile-line', 'pdf-overview-page:hover-tooltip', 'pdf-split-sheets:resize-scale', 'pdf-page-furniture:keyboard-nudge'],
  'canopi-f47t.52.52': ['plant:resize-scale', 'plant:edit-by-values', 'plant:edit-note-text', 'plant:measure-show-dimensions', 'plant:align-distribute', 'zone-rect:resize-scale', 'zone-rect:edit-by-values', 'zone-rect:zone-style', 'zone-rect:rename-zone', 'zone-rect:edit-note-text', 'zone-rect:measure-show-dimensions', 'zone-rect:context-menu', 'zone-rect:multi-select-edit', 'zone-rect:align-distribute', 'zone-ellipse:resize-scale', 'zone-ellipse:edit-by-values', 'zone-ellipse:zone-style', 'zone-ellipse:rename-zone', 'zone-ellipse:edit-note-text', 'zone-ellipse:measure-show-dimensions', 'zone-ellipse:context-menu', 'zone-ellipse:multi-select-edit', 'zone-ellipse:align-distribute', 'zone-polygon:resize-scale', 'zone-polygon:edit-by-values', 'zone-polygon:zone-style', 'zone-polygon:rename-zone', 'zone-polygon:edit-note-text', 'zone-polygon:measure-show-dimensions', 'zone-polygon:context-menu', 'zone-polygon:multi-select-edit', 'zone-polygon:align-distribute', 'zone-line:resize-scale', 'zone-line:edit-by-values', 'zone-line:zone-style', 'zone-line:edit-note-text', 'zone-line:measure-show-dimensions', 'zone-line:multi-select-edit', 'zone-line:align-distribute', 'text-note:resize-scale', 'text-note:edit-by-values', 'text-note:snap-to-grid', 'text-note:context-menu', 'text-note:multi-select-edit', 'text-note:align-distribute', 'plant-row-path:edit-by-values'],
  'canopi-f47t.52.6': ['plant:hover-tooltip', 'zone-rect:hover-tooltip', 'zone-rect:find-plants', 'zone-ellipse:hover-tooltip', 'zone-ellipse:find-plants', 'zone-ellipse:turn-view-to-edge', 'zone-polygon:hover-tooltip', 'zone-polygon:find-plants', 'zone-line:hover-tooltip', 'zone-line:find-plants', 'text-note:inspection-lens', 'text-note:find-plants', 'text-note:saved-views', 'text-note:stories', 'plant-row-path:inspection-lens'],
  'canopi-f47t.52.65': ['plant:site-data-display', 'site-data-entry:copy-cut-paste', 'site-data-entry:duplicate', 'site-data-entry:hover-tooltip', 'site-data-entry:inspection-lens', 'site-data-entry:zoom-to-selection', 'site-data-entry:saved-views', 'site-data-entry:site-data-display', 'site-data-entry:multi-select-edit', 'analysis-result:inspection-lens', 'analysis-result:zoom-to-selection', 'analysis-result:saved-views', 'analysis-result:profile-line', 'analysis-result:site-data-display', 'map-background:saved-views', 'map-background:site-data-display'],
  'canopi-f47t.52.94': ['plant:layer-assignment', 'zone-rect:layer-assignment', 'zone-ellipse:layer-assignment', 'zone-polygon:layer-assignment', 'zone-line:layer-assignment', 'text-note:layer-assignment', 'scene-layer:select-all', 'scene-layer:layer-assignment', 'scene-layer:z-order', 'scene-layer:zone-style', 'scene-layer:inspection-lens', 'scene-layer:zoom-to-selection', 'scene-layer:saved-views'],
  'canopi-qjuzy': ['species-appearance:delete', 'species-appearance:context-menu'],
  'canopi-wsi1': ['calendar-action:copy-cut-paste', 'calendar-action:duplicate', 'calendar-action:species-details', 'calendar-action:species-focus', 'calendar-action:find-plants', 'calendar-action:zoom-to-selection', 'calendar-action:context-menu', 'calendar-action:multi-select-edit'],
  'canopi-z1ie7': ['pdf-overview-page:delete'],
}

const DECISION_BY_CELL = new Map<string, string>(
  Object.entries(DECISION_CELLS_BY_ID).flatMap(([id, cells]) => cells.map((cell) => [cell, id] as const)),
)

const GAP_BEAD_BY_CELL = new Map<string, string>(
  Object.entries(GAP_CELLS_BY_BEAD).flatMap(([bead, cells]) => cells.map((cell) => [cell, bead] as const)),
)

function cellFor(kind: ObjectKind, cap: Capability, code: string): Cell {
  if (code === '-') return { state: 'n/a', reason: `${kind} does not participate in ${cap}` }
  if (code === 'Y') return { state: 'yes', via: DEFAULT_VIA[cap] }
  const state = code === 'P' ? 'partial' : 'no'
  const key = `${kind}:${cap}`
  const decision = DECISION_BY_CELL.get(key)
  if (decision) return { state, decision }
  const gap = GAP_BEAD_BY_CELL.get(key)
  if (gap) return { state, gap }
  throw new Error(`Unclassified capability hole ${key}`)
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
      row[cap] = cellFor(kind, cap, code[i]!)
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
