import { describe, expect, it } from 'vitest'
import type { PathPoints } from '../plant-path/curve'
import { handleSizeFor } from '../runtime/tools/select/handle-size'
import type { WorldPoint } from '../../geo/view/types'
import type { ToolHandleId } from '../runtime/interaction-types'
import { dotHandle, dotHandles, dotsWithRoom, parsePointHandle, pointHandles } from './layout'

const square: PathPoints = {
  points: [
    { position: { x: 0, y: 0 }, sharp: true },
    { position: { x: 10, y: 0 }, sharp: false },
    { position: { x: 10, y: 10 }, sharp: true },
    { position: { x: 0, y: 10 }, sharp: true },
  ],
  closed: false,
}

/** 10 px per metre on screen. */
const tenPxPerMetre = (a: WorldPoint, b: WorldPoint): number => 10 * Math.hypot(a.x - b.x, a.y - b.y)
const label = (index: number): string => `#${index + 1}`

describe('point and dot handles', () => {
  it('gives every point a vertex handle, a corner when sharp, sized for the pointer', () => {
    const handles = pointHandles('row', square, handleSizeFor('mouse'), label)
    expect(handles.map((handle) => [handle.id, handle.glyph, handle.label])).toEqual([
      ['point:row:0', 'corner', '#1'],
      ['point:row:1', 'vertex', '#2'],
      ['point:row:2', 'corner', '#3'],
      ['point:row:3', 'corner', '#4'],
    ])
    expect(handles[1]).toMatchObject({ anchor: { x: 10, y: 0 }, hitRadiusPx: 10 })
    expect(pointHandles('row', square, handleSizeFor('touch'), label)[0]!.hitRadiusPx).toBe(22)
  })

  it('puts a dot halfway along each segment on the curve, a loop\'s closing one included', () => {
    const sharpSquare: PathPoints = { points: square.points.map((point) => ({ ...point, sharp: true })), closed: true }
    const dots = dotHandles('row', sharpSquare, tenPxPerMetre, handleSizeFor('mouse'), label)
    expect(dots.map((dot) => [dot.id, dot.glyph, dot.anchor])).toEqual([
      ['dot:row:0', 'midpoint', { x: 5, y: 0 }],
      ['dot:row:1', 'midpoint', { x: 10, y: 5 }],
      ['dot:row:2', 'midpoint', { x: 5, y: 10 }],
      ['dot:row:3', 'midpoint', { x: 0, y: 5 }],
    ])
    expect(dots[0]!.hitRadiusPx).toBe(8)
    // The smooth corner bends its segments, so their dots leave the chord.
    const bent = dotHandles('row', square, tenPxPerMetre, handleSizeFor('mouse'), label)
    expect(bent).toHaveLength(3)
    expect(bent[0]!.anchor.y).not.toBe(0)
  })

  it('shows a dot only on a segment with room on screen: 52 px with a mouse, 132 px with a finger', () => {
    const scale = (pxPerMetre: number) => (a: WorldPoint, b: WorldPoint) => pxPerMetre * Math.hypot(a.x - b.x, a.y - b.y)
    expect(dotHandles('row', square, scale(5.2), handleSizeFor('mouse'), label)).toHaveLength(3)
    expect(dotHandles('row', square, scale(5.1), handleSizeFor('mouse'), label)).toHaveLength(0)
    expect(dotHandles('row', square, scale(10), handleSizeFor('touch'), label)).toHaveLength(0)
    expect(dotHandles('row', square, scale(13.2), handleSizeFor('touch'), label)).toHaveLength(3)
    expect(dotHandles('row', { points: square.points.slice(0, 1), closed: false }, tenPxPerMetre, handleSizeFor('mouse'), label)).toEqual([])
  })

  it('lays out any owner\'s dots by the same room rule and handle, a zone\'s straight edges included', () => {
    const edge = (index: number, from: WorldPoint, to: WorldPoint) => ({
      id: `edge-mid:zone:${index}` as ToolHandleId, from, to, anchor: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, index,
    })
    const edges = [edge(0, { x: 0, y: 0 }, { x: 10, y: 0 }), edge(1, { x: 10, y: 0 }, { x: 10, y: 4 })]
    const shown = dotsWithRoom(edges, tenPxPerMetre, handleSizeFor('mouse'))
    expect(shown.map((dot) => dot.index), 'a 40 px edge has no room for a mouse\'s dot').toEqual([0])
    expect(dotHandle(shown[0]!, handleSizeFor('touch'), 'Edge 1')).toEqual({
      id: 'edge-mid:zone:0', anchor: { x: 5, y: 0 }, hitRadiusPx: handleSizeFor('touch').midpointRadiusPx, glyph: 'midpoint', label: 'Edge 1',
    })
  })

  it('reads a point or dot handle id back', () => {
    expect(parsePointHandle('point:plant-row-a:3')).toEqual({ ownerId: 'plant-row-a', role: 'point', index: 3 })
    expect(parsePointHandle('dot:draft:0')).toEqual({ ownerId: 'draft', role: 'dot', index: 0 })
    for (const other of ['rotate', 'vertex:zone:1', 'point:row', 'point:row:', 'dot:row:x', 'point::2', 'dot:row:-1']) {
      expect(parsePointHandle(other), other).toBeNull()
    }
  })
})
