import { describe, expect, it } from 'vitest'

import { createEllipticalZoneMeasurements } from './zone-measurements'

describe('zone measurements', () => {
  it('places Elliptical Zone dimension labels along oriented geometry', () => {
    const labels = createEllipticalZoneMeasurements(
      { x: 0, y: 0 },
      { x: 4, y: 1 },
      90,
    )

    expect(labels.find((label) => label.id === 'ellipse-dimensions')).toEqual({
      id: 'ellipse-dimensions',
      kind: 'dimension',
      text: '8 m × 2 m',
      worldPosition: { x: 1, y: 0 },
    })
    expect(labels.find((label) => label.id === 'area')?.text).toBe('13 m²')
  })
})
