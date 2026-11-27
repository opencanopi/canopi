import { expect, it } from 'vitest'
import { zoneMeasurements } from '../app/canvas-pdf/zone-measurements'

it('retains every edge of a four-sided polygon instead of treating it as a rectangle', () => {
  const zones = [{
    name: 'Trapezoid', path: 'M0 0 H6 V4 H3 Z', fill: null,
    bounds: { x: 0, y: 0, width: 6, height: 4 },
    geometry: { kind: 'polygon' as const, points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 3, y: 4 }] },
  }]
  const [zone] = zoneMeasurements(zones, zones, (a, b) => Math.hypot(b.x - a.x, b.y - a.y))
  expect(zone!.lengths).toEqual([6, 4, 3, 5])
  expect(zone!.widths).toEqual([])
  expect(zone!.dimensions.map(d => d.metres)).toEqual([6, 4, 3, 5])
})
