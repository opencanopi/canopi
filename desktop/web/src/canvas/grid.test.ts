import { describe, expect, it } from 'vitest'
import { createTestView } from '../__tests__/support/test-view'
import { gridInterval } from './grid'
import { mapZoomToStageScale, createSessionPlane } from '../geo/session-plane'
const NANTES = { lon: -1.5536, lat: 47.2184 }

describe('gridInterval', () => {
  it('a camera placed at exactly 20 px/m shows the 1 m grid, though its scale reads back a hair under', () => {
    const readBack = mapZoomToStageScale(createSessionPlane(NANTES).zoomForPixelsPerMetre(20), NANTES.lat)
    expect(readBack).toBeLessThan(20)
    expect(gridInterval(readBack).interval).toBe(1)
    expect(gridInterval(20).interval).toBe(1)
  })

  it('Back to my Design on an empty Design near Nantes shows the 2 m grid at 10 px/m', () => {
    const view = createTestView({
      plane: createSessionPlane(NANTES),
      screen: { width: 1200, height: 1000 },
      viewport: { x: 0, y: 0, scale: 0.01 },
    })
    view.navigation.returnToDesign()
    expect(view.view().pixelsPerMetre).toBeCloseTo(10, 9)
    expect(gridInterval(view.view().pixelsPerMetre).interval).toBe(2)
    view.dispose()
  })

  it('a scale clearly under the gap steps up', () => {
    expect(gridInterval(19.99).interval).toBe(2)
  })
})
