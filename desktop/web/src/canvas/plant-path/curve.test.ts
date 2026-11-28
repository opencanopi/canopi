import { describe, expect, it } from 'vitest'
import type { WorldPoint } from '../../geo/view/types'
import { flattenPath, pointAlong, segmentMidpoints, tangentAlong, type PathPoints } from './curve'

function path(points: readonly (WorldPoint & { readonly sharp?: boolean })[], closed = false): PathPoints {
  return { points: points.map(({ sharp = false, ...position }) => ({ position, sharp })), closed }
}

function distanceToPolyline(point: WorldPoint, vertices: readonly WorldPoint[]): number {
  let best = Infinity
  for (let index = 0; index + 1 < vertices.length; index += 1) {
    const a = vertices[index]!
    const b = vertices[index + 1]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)))
  }
  return best
}

describe('flattenPath', () => {
  it('passes through every point, in order, from the first to the last', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: -3 }, { x: 31, y: 4 }]
    const flat = flattenPath(path(points))
    expect(flat.vertices[0]).toEqual(points[0])
    expect(flat.vertices.at(-1)).toEqual(points[3])
    expect(flat.segmentStarts.map((index) => flat.vertices[index])).toEqual(points)
    // 64 samples per curve segment.
    expect(flat.vertices).toHaveLength(3 * 64 + 1)
    expect(flat.lengths[0]).toBe(0)
    for (let index = 1; index < flat.lengths.length; index += 1) expect(flat.lengths[index]).toBeGreaterThan(flat.lengths[index - 1]!)
  })

  it('bends smoothly through a smooth point and breaks straight at a sharp one', () => {
    const smooth = flattenPath(path([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]))
    // Off the two chords: the curve bulges past the middle point's corner.
    const chords = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]
    expect(Math.max(...smooth.vertices.map((vertex) => distanceToPolyline(vertex, chords)))).toBeGreaterThan(0.2)

    const sharp = flattenPath(path([{ x: 0, y: 0 }, { x: 10, y: 10, sharp: true }, { x: 20, y: 0 }]))
    expect(sharp.vertices).toEqual(chords)
    expect(sharp.lengths.at(-1)).toBeCloseTo(2 * Math.hypot(10, 10), 12)
  })

  it('closes a loop back to its first point', () => {
    const square = path([{ x: 0, y: 0, sharp: true }, { x: 10, y: 0, sharp: true }, { x: 10, y: 10, sharp: true }, { x: 0, y: 10, sharp: true }], true)
    const flat = flattenPath(square)
    expect(flat.closed).toBe(true)
    expect(flat.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }])
    expect(flat.lengths.at(-1)).toBe(40)
    expect(flat.segmentStarts).toEqual([0, 1, 2, 3, 4])
  })

  it('collapses coincident points and stays finite', () => {
    const flat = flattenPath(path([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }]))
    expect(flat.vertices).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }])
    expect(flat.segmentStarts).toEqual([0, 0, 1])
    // A loop of two distinct points is no loop.
    expect(flattenPath(path([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }], true)).closed).toBe(false)
  })
})

describe('pointAlong, tangentAlong and segmentMidpoints', () => {
  it('finds the point at a length and each segment\'s middle on the curve', () => {
    const line = path([{ x: 0, y: 0, sharp: true }, { x: 4, y: 0, sharp: true }, { x: 4, y: 6, sharp: true }])
    const flat = flattenPath(line)
    expect(pointAlong(flat, -1)).toEqual({ x: 0, y: 0 })
    expect(pointAlong(flat, 5)).toEqual({ x: 4, y: 1 })
    expect(pointAlong(flat, 99)).toEqual({ x: 4, y: 6 })
    // The direction of the segment there, clamped to the ends.
    expect(tangentAlong(flat, -1)).toEqual({ x: 4, y: 0 })
    expect(tangentAlong(flat, 2)).toEqual({ x: 4, y: 0 })
    expect(tangentAlong(flat, 5)).toEqual({ x: 0, y: 6 })
    expect(tangentAlong(flat, 99)).toEqual({ x: 0, y: 6 })
    expect(tangentAlong(flattenPath(path([{ x: 1, y: 1 }])), 0)).toEqual({ x: 0, y: 0 })
    expect(segmentMidpoints(line)).toEqual([{ x: 2, y: 0 }, { x: 4, y: 3 }])
    expect(segmentMidpoints({ ...line, closed: true })).toEqual([{ x: 2, y: 0 }, { x: 4, y: 3 }, { x: 2, y: 3 }])

    const curve = path([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }])
    const curved = flattenPath(curve)
    for (const midpoint of segmentMidpoints(curve)) expect(distanceToPolyline(midpoint, curved.vertices)).toBeLessThan(1e-9)
  })
})
