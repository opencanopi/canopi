import { armCanvasTool } from '../../app/keyboard/arming'
import type { PlantStampSourceInput } from '../../canvas/stamp-drag-data'

/**
 * A panel's Place button: arms Place plants with the species, and the map takes focus so the next click places and
 * Esc cancels. Without a canvas the species is kept (Place plants' chooser offers it) and focus stays on the button.
 */
export function placeSpeciesOnMap(source: PlantStampSourceInput): void {
  armCanvasTool('plant-stamp', { from: 'panel', source: { kind: 'species', species: source } })
}
