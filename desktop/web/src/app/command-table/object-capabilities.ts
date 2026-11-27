// app/command-table/object-capabilities.ts  (L2 rank 2; type-only imports of L0; imports no feature)
//
// The 28 x 57 object-action capability matrix (2.1-Q147, 2.1-M86, 2.1-M163, 2.1-M164,
// contracts §21): keyed on `ObjectKind` (`types/design-object-kinds.ts`), with
// `ObjectOwner`, `Backing`, `ownerOf(row)`, and `cellOn(root, kind, action)`.

import type { EditionCapabilityId, EditionCapabilitySet } from '../../generated/edition-capabilities'
import { DOCUMENT_FILE_FIELD_OWNERS, type KnownCanopiKey } from '../../generated/known-canopi-keys'
import type { ObjectKind } from '../../types/design-object-kinds'
import { commandRowFor, lackingCapabilities, type CommandOrToolId } from './applicability'

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
  'site-data-entry': { id: 'site-data-entry', backing: { store: 'data-library' }, references: [{ field: 'site_data' }], requires: ['site-data-below-limit'] },
  'analysis-result': { id: 'analysis-result', backing: { store: 'data-library' }, references: [{ field: 'site_data' }], requires: ['site-data-below-limit'] },
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
  if ('field' in row.backing) {
    const owner = DOCUMENT_FILE_FIELD_OWNERS[row.backing.field]
    return owner === 'format' ? 'document' : owner
  }
  if ('sceneTarget' in row.backing) return 'scene'
  if ('printSetup' in row.backing) return 'document'
  if ('store' in row.backing) return row.backing.store
  return 'tool-session'
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
}

// Compact 56-character matrix encoding from `capability-matrix.md` (Y=yes, P=partial, N=no, -=n/a).
// Exact 28x56 codes (design-template-import column deleted with 2.1-E5).
const MATRIX_CODES: Readonly<Record<ObjectKind, string>> = {
  'plant': 'YYYYYYPP-NN-YYYYYYYYNYY--NYPYYYYYYY-YYPYYYYYPPY-YYY-NYNY',
  'zone-rect': 'YYY-YYYYYYYYYYYYYYYYNY-YYN-YYYY--NYYY-NYYYYYNPP-YYPN-YNY',
  'zone-ellipse': 'YYY-YYYYYYYYYYYYYYYYNY-YYN-YYYY--NYNY-NYYYYYNPP-YYPN-YNY',
  'zone-polygon': 'YYY-YYYYYYYYYYYYYYYYNY-YYN-YYYY--NYYY-NYYYYYNPP-YYPN-YNY',
  'zone-line': 'YYY-YYYYYYYYYYYYYYYYNY-YPN-YYYY--NYYY-NYYYYYNPP-YYPYYYNY',
  'text-note': 'YYY-YYYY-NP-YYYYYYYYNY---P--YNY--NY-Y--YYYYY-YP-YY---PNY',
  'measurement-guide': 'YYY-YYYYYYYYYYYYYYYYNY--NN-YYYY---YYY-NYYYYY-YP-YY-YYYNY',
  'group': 'YYYYYYYYNNY-YYYYYPYPNYYYYYYYYYYY-NY-Y-NYYYYY-NN-YYY--YNY',
  'scene-layer': '--P-------------Y--YNN-Y-PPP--Y---Y----------YP-PY------',
  'species-appearance': '---Y---------P-PY-----P---Y--PYYYYY-PYY-YYYNNYY-PPY--P-Y',
  'site-data-entry': '-------------NNYY--Y-Y-----P-NN---P----------NN-PY-YPP-Y',
  'analysis-result': '--------------NYN--Y-Y-------NN---P----------NN-PY-NP---',
  'map-background': '----------------N--Y----------N--------------NN-PY--P---',
  'saved-view': '-------N-----NNYY---P-P---YP---NP--Y---------NNNYY--PY-Y',
  'design-map-view': '-----------------------------------Y---------PNP-------Y',
  'story': '-------------NPYY---P-----YP---NY--Y---------NNN-Y-----Y',
  'calendar-action': '-------------NNYY--------------NNPN-P---NNN-NN----Y--P-Y',
  'budget-item': '-------------N-YY--------------NYPN-P---NNN-PN----P--P-Y',
  'consortium-entry': '-------------N-NY--------------NYPN-N---NNN-NN-------P-Y',
  'saved-object-stamp': '----PNPP-NN-Y-NYPYYPN-YYPYYYP--N-P--P-NY-PPN---------Y-Y',
  'plant-row-path': '----PNNNP-PYY---YP-Y------NY--Y-----Y-Y------------N---Y',
  'profile-line': '----NN-NN-NYY---Y----------Y--N-----P--------N--NN-YY--Y',
  'pdf-setup': '------NY--Y-----N--PP-PN--N-----N--P---------YYYNN--N---',
  'pdf-overview-page': 'Y---YYNY-PP----N---P----PYPY-N-NN-YP---------YPYN---N--P',
  'pdf-detail-page': 'PNN-YYNYNPPNNNNYN--PN-N-PYYY-N--N-PPN--------YPYN---NNNP',
  'pdf-split-sheets': 'PNN-PPNYNNN---NPN--P---------------P---------YYY----N---',
  'pdf-key-page': 'Y------------------P----PYYY---N-Y----------NYP---N-----',
  'pdf-page-furniture': '----NN---------P-------------------Y---------YPY--------',
}

// Deliberate exceptions (`decision` cells, non-superseded ledger/ADR ids; never process row 2.1-Q147).
const DECISION_CELLS_BY_ID: Readonly<Record<string, readonly string[]>> = {
  '2.1-Q365': ['profile-line:context-menu', 'profile-line:edit-by-values', 'profile-line:inspection-lens', 'profile-line:keyboard-nudge', 'profile-line:move', 'profile-line:pdf-export', 'profile-line:reshape-vertices', 'profile-line:rotate-by-value', 'profile-line:saved-views', 'profile-line:stories'],
  '2.1-Q56': ['plant:pdf-export'],
  '2.1-Q96': ['budget-item:budget-csv-export', 'budget-item:calendar-budget-targets', 'budget-item:context-menu'],
  'ADR 0007': ['budget-item:place-from-stamp', 'budget-item:save-as-stamp', 'budget-item:stamp-library-manage', 'calendar-action:place-from-stamp', 'calendar-action:save-as-stamp', 'calendar-action:stamp-library-manage', 'consortium-entry:place-from-stamp', 'consortium-entry:save-as-stamp', 'consortium-entry:stamp-library-manage', 'group:group-ungroup', 'group:layer-assignment', 'group:layer-visibility-lock-opacity'],
  'ADR 0008': ['analysis-result:pdf-export', 'budget-item:pdf-export', 'calendar-action:pdf-export', 'consortium-entry:pdf-export', 'map-background:pdf-export', 'map-background:pdf-page-edit', 'pdf-detail-page:layer-visibility-lock-opacity', 'pdf-detail-page:site-data-display', 'pdf-key-page:budget-csv-export', 'pdf-key-page:calendar-budget-targets', 'pdf-key-page:layer-visibility-lock-opacity', 'pdf-overview-page:layer-visibility-lock-opacity', 'pdf-overview-page:site-data-display', 'pdf-setup:layer-visibility-lock-opacity', 'pdf-setup:site-data-display', 'pdf-split-sheets:layer-visibility-lock-opacity', 'pdf-split-sheets:site-data-display', 'site-data-entry:pdf-export', 'site-data-entry:pdf-page-edit', 'zone-ellipse:pdf-export', 'zone-line:pdf-export', 'zone-polygon:pdf-export', 'zone-rect:pdf-export'],
  'ADR 0015': ['plant:rotate-by-value', 'plant:rotate-handle'],
  'ADR 0019': ['map-background:inspection-lens'],
  'ADR 0024': ['map-background:undo-redo'],
}

// Gap cells (`gap` cells, open capability-fill theme beads in .beads/issues.jsonl; ratcheted by policy/ratchets/object-capability-gaps.json).
const GAP_CELLS_BY_BEAD: Readonly<Record<string, readonly string[]>> = {
  'canopi-capt1later': ['measurement-guide:align-distribute', 'measurement-guide:edit-note-text', 'measurement-guide:layer-assignment', 'measurement-guide:plant-a-row', 'measurement-guide:rename-zone'],
  'canopi-capt10later': ['plant:layer-assignment', 'scene-layer:edit-note-text', 'scene-layer:layer-assignment', 'scene-layer:measure-show-dimensions', 'scene-layer:plant-labels', 'scene-layer:saved-views', 'scene-layer:select-all', 'scene-layer:z-order', 'text-note:layer-assignment', 'zone-ellipse:layer-assignment', 'zone-line:layer-assignment', 'zone-polygon:layer-assignment', 'zone-rect:layer-assignment'],
  'canopi-capt12later': ['text-note:find-plants', 'text-note:hover-tooltip', 'zone-ellipse:find-plants', 'zone-ellipse:turn-view-to-edge', 'zone-line:find-plants', 'zone-polygon:find-plants', 'zone-rect:find-plants'],
  'canopi-capt13later': ['species-appearance:geojson-export-import'],
  'canopi-capt14later': ['plant-row-path:profile-line', 'plant:plant-a-row', 'zone-ellipse:plant-a-row', 'zone-ellipse:profile-line', 'zone-line:plant-a-row', 'zone-polygon:plant-a-row', 'zone-polygon:profile-line', 'zone-rect:plant-a-row', 'zone-rect:profile-line'],
  'canopi-capt2s2c': ['pdf-detail-page:context-menu', 'pdf-detail-page:multi-select-edit', 'pdf-detail-page:rotate-handle', 'pdf-detail-page:saved-views', 'pdf-detail-page:turn-view-to-edge', 'pdf-overview-page:plant-labels', 'pdf-overview-page:rotate-handle', 'pdf-overview-page:turn-view-to-edge', 'pdf-setup:rotate-handle', 'pdf-setup:turn-view-to-edge', 'pdf-split-sheets:rotate-handle', 'pdf-split-sheets:turn-view-to-edge'],
  'canopi-capt2later': ['analysis-result:pdf-page-edit', 'measurement-guide:pdf-page-edit', 'pdf-detail-page:align-distribute', 'pdf-detail-page:band-select', 'pdf-detail-page:copy-cut-paste', 'pdf-detail-page:draw-constraints', 'pdf-detail-page:duplicate', 'pdf-detail-page:edit-by-values', 'pdf-detail-page:hover-tooltip', 'pdf-detail-page:layer-assignment', 'pdf-detail-page:pdf-page-edit', 'pdf-detail-page:plant-style', 'pdf-detail-page:rename-zone', 'pdf-detail-page:reshape-vertices', 'pdf-detail-page:resize-scale', 'pdf-detail-page:select', 'pdf-detail-page:select-all', 'pdf-detail-page:snap-to-grid', 'pdf-detail-page:species-focus', 'pdf-detail-page:touch-gestures', 'pdf-detail-page:undo-redo', 'pdf-detail-page:zoom-to-selection', 'pdf-key-page:pdf-page-edit', 'pdf-key-page:rename-zone', 'pdf-key-page:species-details', 'pdf-overview-page:edit-by-values', 'pdf-overview-page:hover-tooltip', 'pdf-overview-page:pdf-page-edit', 'pdf-overview-page:rename-zone', 'pdf-overview-page:resize-scale', 'pdf-overview-page:saved-views', 'pdf-overview-page:species-details', 'pdf-overview-page:species-focus', 'pdf-overview-page:touch-gestures', 'pdf-page-furniture:delete', 'pdf-page-furniture:keyboard-nudge', 'pdf-page-furniture:move', 'pdf-page-furniture:pdf-page-edit', 'pdf-setup:layer-assignment', 'pdf-setup:plant-labels', 'pdf-setup:plant-style', 'pdf-setup:saved-views', 'pdf-setup:species-focus', 'pdf-setup:stories', 'pdf-setup:undo-redo', 'pdf-setup:zone-style', 'pdf-split-sheets:band-select', 'pdf-split-sheets:delete', 'pdf-split-sheets:duplicate', 'pdf-split-sheets:edit-by-values', 'pdf-split-sheets:keyboard-nudge', 'pdf-split-sheets:move', 'pdf-split-sheets:reshape-vertices', 'pdf-split-sheets:resize-scale', 'pdf-split-sheets:select', 'pdf-split-sheets:select-all', 'pdf-split-sheets:undo-redo'],
  'canopi-capt3s2c': ['design-map-view:pdf-per-view-rotation', 'saved-view:pdf-per-view-rotation', 'story:pdf-per-view-rotation'],
  'canopi-capt3later': ['design-map-view:pdf-export', 'design-map-view:pdf-page-edit', 'saved-view:pdf-export', 'saved-view:pdf-page-edit', 'scene-layer:pdf-page-edit', 'story:pdf-export', 'story:pdf-page-edit', 'text-note:pdf-page-edit', 'zone-ellipse:pdf-page-edit', 'zone-line:pdf-page-edit', 'zone-polygon:pdf-page-edit', 'zone-rect:pdf-page-edit'],
  'canopi-capt4later': ['plant-row-path:edit-by-values', 'plant-row-path:group-ungroup', 'plant-row-path:keyboard-nudge', 'plant-row-path:move', 'plant-row-path:plant-labels', 'plant-row-path:reshape-vertices', 'plant-row-path:rotate-by-value', 'plant-row-path:rotate-handle', 'plant:align-distribute', 'plant:edit-by-values', 'plant:edit-note-text', 'plant:measure-show-dimensions', 'plant:resize-scale', 'text-note:align-distribute', 'text-note:edit-by-values', 'text-note:edit-note-text', 'text-note:multi-select-edit', 'text-note:resize-scale', 'zone-ellipse:align-distribute', 'zone-ellipse:edit-note-text', 'zone-line:align-distribute', 'zone-line:edit-note-text', 'zone-line:rename-zone', 'zone-polygon:align-distribute', 'zone-polygon:edit-note-text', 'zone-rect:align-distribute', 'zone-rect:edit-note-text'],
  'canopi-capt5later': ['saved-object-stamp:context-menu', 'saved-object-stamp:duplicate', 'saved-object-stamp:edit-by-values', 'saved-object-stamp:find-plants', 'saved-object-stamp:geojson-export-import', 'saved-object-stamp:inspect-selection-chip', 'saved-object-stamp:keyboard-nudge', 'saved-object-stamp:layer-assignment', 'saved-object-stamp:layer-visibility-lock-opacity', 'saved-object-stamp:move', 'saved-object-stamp:place-from-stamp', 'saved-object-stamp:plant-a-row', 'saved-object-stamp:rename-zone', 'saved-object-stamp:resize-scale', 'saved-object-stamp:rotate-by-value', 'saved-object-stamp:rotate-handle', 'saved-object-stamp:species-details', 'saved-object-stamp:stamp-library-manage', 'saved-object-stamp:undo-redo'],
  'canopi-capt6later': ['group:align-distribute', 'group:find-plants', 'group:pdf-export', 'group:pdf-page-edit', 'group:plant-a-row', 'group:reshape-vertices', 'group:resize-scale'],
  'canopi-capt7later': ['analysis-result:undo-redo'],
  'canopi-capt8later': ['budget-item:copy-cut-paste', 'budget-item:find-plants', 'budget-item:multi-select-edit', 'budget-item:species-details', 'budget-item:zoom-to-selection', 'calendar-action:budget-csv-export', 'calendar-action:context-menu', 'calendar-action:copy-cut-paste', 'calendar-action:duplicate', 'calendar-action:find-plants', 'calendar-action:multi-select-edit', 'calendar-action:species-details', 'calendar-action:species-focus', 'calendar-action:zoom-to-selection', 'consortium-entry:budget-csv-export', 'consortium-entry:context-menu', 'consortium-entry:copy-cut-paste', 'consortium-entry:delete', 'consortium-entry:find-plants', 'consortium-entry:multi-select-edit', 'consortium-entry:species-details', 'consortium-entry:zoom-to-selection', 'plant:budget-csv-export', 'saved-view:copy-cut-paste', 'saved-view:duplicate', 'saved-view:layer-assignment', 'saved-view:measure-show-dimensions', 'saved-view:plant-style', 'saved-view:rotate-by-value', 'saved-view:site-data-display', 'saved-view:species-details', 'saved-view:species-focus', 'species-appearance:budget-csv-export', 'species-appearance:copy-cut-paste', 'species-appearance:hover-tooltip', 'species-appearance:multi-select-edit', 'species-appearance:plant-style', 'species-appearance:saved-views', 'species-appearance:stories', 'story:copy-cut-paste', 'story:duplicate', 'story:layer-assignment', 'story:measure-show-dimensions', 'story:species-details', 'zone-ellipse:budget-csv-export', 'zone-ellipse:calendar-budget-targets', 'zone-line:budget-csv-export', 'zone-line:calendar-budget-targets', 'zone-polygon:budget-csv-export', 'zone-polygon:calendar-budget-targets', 'zone-rect:budget-csv-export', 'zone-rect:calendar-budget-targets'],
  'canopi-capt9later': ['analysis-result:duplicate', 'analysis-result:hover-tooltip', 'analysis-result:inspection-lens', 'analysis-result:profile-line', 'analysis-result:saved-views', 'analysis-result:site-data-display', 'analysis-result:zoom-to-selection', 'map-background:saved-views', 'map-background:site-data-display', 'plant:site-data-display', 'site-data-entry:copy-cut-paste', 'site-data-entry:duplicate', 'site-data-entry:hover-tooltip', 'site-data-entry:inspection-lens', 'site-data-entry:measure-show-dimensions', 'site-data-entry:multi-select-edit', 'site-data-entry:saved-views', 'site-data-entry:site-data-display', 'site-data-entry:zoom-to-selection'],
  'canopi-qjuzy': ['species-appearance:context-menu', 'species-appearance:delete'],
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
      for (const req of commandRowFor(via).requires ?? []) needed.add(req)
    }
  }
  const missing = lackingCapabilities([...needed], root)
  return missing.length > 0 ? { state: 'lacking', requires: missing } : cell
}
