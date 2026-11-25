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
  | 'templates'
  | 'design-notebook'
  | 'species-key'
  | 'layers'
  | 'site-data'
  | 'calendar'
  | 'budget'
  | 'consortium'
  | 'stories'

export type SidePanel = Exclude<Panel, 'canvas' | 'templates'>
export type PanelGroup = 'primary' | 'design' | 'planning'

export interface PanelDescriptor {
  readonly panel: Panel
  readonly commandId:
    | 'nav.canvas'
    | 'nav.templates'
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

export const PANEL_DESCRIPTORS: readonly PanelDescriptor[] = [
  { panel: 'canvas', commandId: 'nav.canvas', labelKey: 'panelRail.canvas', group: 'primary', order: 0 },
  { panel: 'templates', commandId: 'nav.templates', labelKey: 'worldMap.title', group: 'primary', order: 1 },
  { panel: 'layers', commandId: 'nav.layers', labelKey: 'panelRail.layers', group: 'design', order: 0, shortcuts: ['Ctrl+1', 'Alt+Shift+1'] },
  { panel: 'site-data', commandId: 'nav.siteData', labelKey: 'canvas.layers.siteData', group: 'design', order: 1, shortcuts: ['Ctrl+2', 'Alt+Shift+2'], requires: ['site-data-below-limit'] },
  { panel: 'species-key', commandId: 'nav.speciesKey', labelKey: 'panelRail.plants', group: 'design', order: 2, shortcuts: ['Ctrl+3', 'Alt+Shift+3'] },
  { panel: 'plant-db', commandId: 'nav.plantDb', labelKey: 'panelRail.catalog', group: 'design', order: 3, shortcuts: ['Ctrl+4', 'Alt+Shift+4'] },
  { panel: 'favorites', commandId: 'nav.favorites', labelKey: 'panelRail.favorites', group: 'design', order: 4, shortcuts: ['Ctrl+5', 'Alt+Shift+5'] },
  { panel: 'calendar', commandId: 'nav.calendar', labelKey: 'panelRail.calendar', group: 'planning', order: 0, shortcuts: ['Ctrl+6', 'Alt+Shift+6'] },
  { panel: 'budget', commandId: 'nav.budget', labelKey: 'panelRail.budget', group: 'planning', order: 1, shortcuts: ['Ctrl+7', 'Alt+Shift+7'] },
  { panel: 'consortium', commandId: 'nav.consortium', labelKey: 'panelRail.consortium', group: 'planning', order: 2, shortcuts: ['Ctrl+8', 'Alt+Shift+8'] },
  { panel: 'design-notebook', commandId: 'nav.designNotebook', labelKey: 'panelRail.notebook', group: 'planning', order: 3, shortcuts: ['Ctrl+9', 'Alt+Shift+9'], requires: ['design-notebook'] },
  { panel: 'stories', commandId: 'nav.stories', labelKey: 'panelRail.stories', group: 'planning', order: 4 },
]
