// types/design-object-kinds.ts  (L0, pure)
//
// The object kinds the object-action matrix keys on (2.1-Q147, contracts §21): every thing a user can act on in a
// Design, one id each. The ids are the 2.1 capability audit's 28 kinds, as they exist today; this module holds only
// the ids, so every layer can key on them. Backing, owner and `requires` live in the matrix rows
// (`app/command-table/object-capabilities.ts`, 2a-2), which `satisfies Record<ObjectKind, …>`, so a kind added here
// fails the type check until it has a row.

export const OBJECT_KINDS = [
  // Scene objects drawn on the canvas.
  { id: 'plant' },
  { id: 'zone-rect' },
  { id: 'zone-ellipse' },
  { id: 'zone-polygon' },
  { id: 'zone-line' },
  { id: 'text-note' },
  { id: 'measurement-guide' },
  { id: 'group' },
  { id: 'scene-layer' },
  // Design records shown in panels.
  { id: 'species-appearance' },
  { id: 'site-data-entry' },
  { id: 'analysis-result' },
  { id: 'map-background' },
  { id: 'saved-view' },
  { id: 'design-map-view' },
  { id: 'story' },
  { id: 'calendar-action' },
  { id: 'budget-item' },
  { id: 'consortium-entry' },
  // Personal library and tool results.
  { id: 'saved-object-stamp' },
  { id: 'plant-row-path' },
  { id: 'profile-line' },
  // PDF export setup and pages.
  { id: 'pdf-setup' },
  { id: 'pdf-overview-page' },
  { id: 'pdf-detail-page' },
  { id: 'pdf-split-sheets' },
  { id: 'pdf-key-page' },
  { id: 'pdf-page-furniture' },
] as const satisfies readonly { readonly id: string }[]

export type ObjectKind = (typeof OBJECT_KINDS)[number]['id']
