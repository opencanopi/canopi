// app/command-table/panels.ts  (L2 rank 2, pure)
//
// Panel descriptor rows (2a-2, docs/plans/2-1-foundations.md:249): single source
// of panel ids, groups, order, label keys, shared chords, and capability gates.

import type { EditionCapabilityId } from '../../generated/edition-capabilities'
import type { LocaleKey } from '../../generated/locale-keys'

export type Panel =
  | 'plant-db'
  | 'canvas'
  | 'favorites'
  | 'design-notebook'
  | 'species-key'
  | 'layers'
  | 'site-data'
  | 'calendar'
  | 'budget'
  | 'consortium'
  | 'stories'

export type SidePanel = Exclude<Panel, 'canvas'>
export type PanelGroup = 'primary' | 'design' | 'planning'

export interface PanelDescriptor {
  readonly panel: Panel
  readonly commandId:
    | 'nav.canvas'
    | 'nav.layers'
    | 'nav.siteData'
    | 'nav.speciesKey'
    | 'nav.plantDb'
    | 'nav.favorites'
    | 'nav.calendar'
    | 'nav.budget'
    | 'nav.consortium'
    | 'nav.designNotebook'
    | 'nav.stories'
  readonly labelKey: LocaleKey
  readonly group: PanelGroup
  readonly order: number
  readonly shortcuts?: readonly string[]
  readonly requires?: readonly EditionCapabilityId[]
}

function row(
  panel: Panel,
  commandId: PanelDescriptor['commandId'],
  labelKey: LocaleKey,
  group: PanelGroup,
  order: number,
  digit?: number,
  requires?: readonly EditionCapabilityId[],
): PanelDescriptor {
  return {
    panel,
    commandId,
    labelKey,
    group,
    order,
    ...(digit !== undefined ? { shortcuts: [`Alt+Shift+${digit}`, `Ctrl+${digit}`] } : {}),
    ...(requires ? { requires } : {}),
  }
}

export const PANEL_DESCRIPTORS: readonly PanelDescriptor[] = [
  row('canvas', 'nav.canvas', 'panelRail.canvas', 'primary', 0),
  row('layers', 'nav.layers', 'panelRail.layers', 'design', 0, 1),
  row('site-data', 'nav.siteData', 'canvas.layers.siteData', 'design', 1, 2, ['site-data-below-limit']),
  row('species-key', 'nav.speciesKey', 'panelRail.plants', 'design', 2, 3),
  row('plant-db', 'nav.plantDb', 'panelRail.catalog', 'design', 3, 4),
  row('favorites', 'nav.favorites', 'panelRail.favorites', 'design', 4, 5),
  row('calendar', 'nav.calendar', 'panelRail.calendar', 'planning', 0, 6),
  row('budget', 'nav.budget', 'panelRail.budget', 'planning', 1, 7),
  row('consortium', 'nav.consortium', 'panelRail.consortium', 'planning', 2, 8),
  row('design-notebook', 'nav.designNotebook', 'panelRail.notebook', 'planning', 3, 9, ['design-notebook']),
  row('stories', 'nav.stories', 'panelRail.stories', 'planning', 4),
]
