import type { PrintPlant } from '../../canvas/print'
import { nearestPlantSpacing } from '../../canvas/plant-spacing'
import { MM, PRINT } from './print-style'

const LONE_PLANT_SPACING_M = 4

/** Physical visibility floor and ceiling; legend samples retain the nominal symbol size. */
export function paperPlantRadius(plants: readonly PrintPlant[], plant: PrintPlant, scale: number, symbolScale = 1): number {
  const spacing = Math.min(nearestPlantSpacing(plants, plant.position), LONE_PLANT_SPACING_M)
  return Math.max(.35 * MM, Math.min(PRINT.marker, spacing * scale * .42 * symbolScale))
}
