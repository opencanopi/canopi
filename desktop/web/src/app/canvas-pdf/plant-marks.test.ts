import { describe, expect, it } from 'vitest'
import type { PrintPlant } from '../../canvas/print'
import { paperPlantRadius } from './plant-marks'
import { MM, PRINT } from './print-style'

function printPlant(id: string, x: number, y: number): PrintPlant {
  return {
    id,
    canonicalName: 'Malus domestica',
    position: { x, y },
    color: '#2E7D32',
    symbol: 'round',
    mark: [],
    pinnedName: false,
  }
}

describe('paperPlantRadius', () => {
  it('scales with symbolScale between the paper minimum and maximum', () => {
    const plants = [printPlant('a', 0, 0), printPlant('b', 1, 0)]
    const scale = 5
    const base = paperPlantRadius(plants, plants[0]!, scale, 1)
    expect(base).toBeCloseTo(1 * scale * 0.42, 6)
    expect(paperPlantRadius(plants, plants[0]!, scale, 1.5)).toBeCloseTo(base * 1.5, 6)
    expect(paperPlantRadius(plants, plants[0]!, scale, 0.5)).toBeCloseTo(base * 0.5, 6)
  })

  it('caps a lone plant to 4 m spacing rather than always hitting PRINT.marker', () => {
    const lone = [printPlant('a', 0, 0)]
    const scale = 1
    expect(paperPlantRadius(lone, lone[0]!, scale, 1)).toBeCloseTo(4 * scale * 0.42, 6)
    expect(paperPlantRadius(lone, lone[0]!, scale, 1)).toBeLessThan(PRINT.marker)
    expect(paperPlantRadius(lone, lone[0]!, scale, 1.5)).toBeCloseTo(4 * scale * 0.42 * 1.5, 6)
  })

  it('clamps to the paper minimum (0.35 mm) and maximum (PRINT.marker)', () => {
    const dense = [printPlant('a', 0, 0), printPlant('b', 0.1, 0)]
    expect(paperPlantRadius(dense, dense[0]!, 1, 1)).toBeCloseTo(0.35 * MM, 6)
    const wide = [printPlant('a', 0, 0), printPlant('b', 10, 0)]
    expect(paperPlantRadius(wide, wide[0]!, 100, 1)).toBe(PRINT.marker)
  })
})
