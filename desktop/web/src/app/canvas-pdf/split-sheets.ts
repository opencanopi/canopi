import type { PrintBounds, PrintPlant, PrintPoint } from '../../canvas/print'
import { contains } from './field-geometry'
import { areaFromFrame, type PageFrame } from './page-frame'

/** Previewable coverage partition. Coincident plants cannot be separated by cropping. */
function splitFieldBounds(bounds: PrintBounds, plants: readonly PrintPlant[]): PrintBounds[] {
  const result: PrintBounds[] = []
  const partition = (ground: PrintBounds, depth: number) => {
    const positions = new Set(plants.filter(p => contains(ground, p.position)).map(p => `${p.position.x},${p.position.y}`))
    if (depth >= 5 || (depth > 0 && positions.size <= 120)) { result.push(ground); return }
    if (ground.width >= ground.height) {
      const width = ground.width / 2
      partition({ ...ground, width }, depth + 1)
      partition({ ...ground, x: ground.x + width, width }, depth + 1)
    } else {
      const height = ground.height / 2
      partition({ ...ground, height }, depth + 1)
      partition({ ...ground, y: ground.y + height, height }, depth + 1)
    }
  }
  partition(bounds, 0)
  return result
}

/**
 * Splits a page's ground (in the layout frame) by the turned plants, as Print Areas in plan metres that turn together
 * about one pivot: the split's centre, or `pivot` when the page is itself a split sheet. At any later angle they then
 * tile the ground turned about that pivot, as the area they replace would be.
 */
export function splitPrintArea(
  ground: PrintBounds,
  plants: readonly PrintPlant[],
  frame: PageFrame,
  pivot?: PrintPoint,
  splitId?: string,
): { bounds: PrintBounds; pivot: PrintPoint; angleDeg: number; splitId?: string }[] {
  const turned = frame.angleDeg ? plants.map(plant => ({ ...plant, position: frame.toFrame(plant.position) })) : plants
  const about = pivot ?? frame.fromFrame({ x: ground.x + ground.width / 2, y: ground.y + ground.height / 2 })
  return splitFieldBounds(ground, turned).map(bounds => ({
    bounds: areaFromFrame(frame, bounds, about),
    pivot: about,
    angleDeg: frame.angleDeg,
    ...(splitId ? { splitId } : {}),
  }))
}
