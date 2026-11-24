import { describe, expect, it } from 'vitest'
import { computePlantSpacingCount, computePlantSpacingPositions } from '../plant-spacing-sequence'
import type { WorldPoint } from '../../geo/view/types'
import type { PathPoints } from './curve'
import { plantAlongPath, type PathSpacing } from './spacing'

function open(...points: readonly WorldPoint[]): PathPoints {
  return { points: points.map((position) => ({ position, sharp: false })), closed: false }
}

function loop(...points: readonly WorldPoint[]): PathPoints {
  return { ...open(...points), closed: true }
}

const every = (metres: number): PathSpacing => ({ kind: 'interval', metres })
const plants = (count: number): PathSpacing => ({ kind: 'count', count })

function distance(a: WorldPoint, b: WorldPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('plantAlongPath', () => {
  it('plants an open 2-point row bit for bit as the straight row did', () => {
    const start = { x: 20, y: 30 }
    for (const [end, metres] of [[{ x: 26, y: 30 }, 2], [{ x: 23.7, y: 41.3 }, 0.35], [{ x: 10, y: 10.01 }, 0.001], [{ x: 20, y: 30 }, 1]] as const) {
      const row = plantAlongPath(open(start, end), every(metres))
      expect(row.count).toBe(computePlantSpacingCount(start, end, metres))
      expect(row.positions()).toEqual(computePlantSpacingPositions(start, end, metres))
      expect(row.positions(250)).toEqual(computePlantSpacingPositions(start, end, metres, { limit: 250 }))
      expect(row.lengthM).toBe(Math.hypot(end.x - start.x, end.y - start.y))
    }
    expect(plantAlongPath(open(start, { x: 26, y: 30 }), every(2)).positions()).toEqual([{ x: 22, y: 30 }, { x: 24, y: 30 }, { x: 26, y: 30 }])
  })

  it('ends a 2-point row exactly on its end point', () => {
    const end = { x: 4 + 1e-8, y: 0 }
    const positions = plantAlongPath(open({ x: 0, y: 0 }, end), every(1)).positions()
    expect(positions).toHaveLength(4)
    expect(positions.at(-1)).toEqual(end)
  })

  it('follows collinear points without overshooting them', () => {
    const row = plantAlongPath(open({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 11, y: 0 }), every(1))
    expect(row.count).toBe(11)
    const positions = row.positions()
    expect(positions).toHaveLength(11)
    positions.forEach((position, index) => {
      expect(Math.abs(position.x - (index + 1))).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(position.y)).toBeLessThanOrEqual(1e-9)
    })
    expect(positions.at(-1)).toEqual({ x: 11, y: 0 })
  })

  it('plants N plants on a loop with N equal gaps, the picked one included', () => {
    const r = 10
    const circle = loop({ x: r, y: 0 }, { x: 0, y: r }, { x: -r, y: 0 }, { x: 0, y: -r })
    const row = plantAlongPath(circle, plants(8))
    expect(row.count).toBe(7)
    const ring = [{ x: r, y: 0 }, ...row.positions()]
    const chords = ring.map((point, index) => distance(point, ring[(index + 1) % ring.length]!))
    for (const chord of chords) expect(chord).toBeCloseTo(chords[0]!, 6)
    expect(row.effectiveSpacingM).toBeCloseTo(row.lengthM / 8, 12)
  })

  it('rounds a loop\'s interval to the nearest equal gap, never fewer than 3', () => {
    const square = loop({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 })
    const sharpSquare: PathPoints = { ...square, points: square.points.map((point) => ({ ...point, sharp: true })) }
    const row = plantAlongPath(sharpSquare, every(3))
    expect(row.lengthM).toBeCloseTo(40, 12)
    // 40 m every 3 m rounds to 13 gaps of 3.077 m: 13 plants, the picked one among them.
    expect(row.count).toBe(12)
    expect(row.effectiveSpacingM).toBeCloseTo(40 / 13, 12)
    expect(plantAlongPath(sharpSquare, every(100))).toMatchObject({ count: 2, effectiveSpacingM: 40 / 3 })
  })

  it('puts N plants end to end on an open row, the last on its end', () => {
    const row = plantAlongPath(open({ x: 0, y: 0 }, { x: 8, y: 0 }), plants(5))
    expect(row.count).toBe(4)
    expect(row.effectiveSpacingM).toBe(2)
    expect(row.positions()).toEqual([{ x: 2, y: 0 }, { x: 4, y: 0 }, { x: 6, y: 0 }, { x: 8, y: 0 }])
    expect(plantAlongPath(open({ x: 0, y: 0 }, { x: 8, y: 0 }), plants(1)).count).toBe(0)
  })

  it('caps the positions it makes, never the count', () => {
    const row = plantAlongPath(open({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 10, y: 0 }), every(0.001))
    expect(row.count).toBeGreaterThan(10_000)
    expect(row.positions(250)).toHaveLength(250)
  })

  it('stays finite where points coincide', () => {
    const row = plantAlongPath(open({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }), every(1))
    expect(row.lengthM).toBe(5)
    const positions = row.positions()
    expect(positions).toHaveLength(5)
    for (const position of positions) expect(Number.isFinite(position.x) && Number.isFinite(position.y)).toBe(true)
  })

  it('plants nothing on a path with no length or no valid spacing', () => {
    expect(plantAlongPath(open({ x: 1, y: 1 }), every(1)).count).toBe(0)
    expect(plantAlongPath(open({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }), every(1)).count).toBe(0)
    expect(plantAlongPath(open({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 10, y: 0 }), every(0)).count).toBe(0)
    expect(plantAlongPath(open({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 10, y: 0 }), plants(2.5)).count).toBe(0)
  })
})
