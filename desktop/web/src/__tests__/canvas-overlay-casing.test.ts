import { afterEach, describe, expect, it, vi } from 'vitest'

import { readCanvasPaintTokens, type CanvasPaintTokens } from '../canvas/theme-refresh'
const getCanvasColor = (name: keyof CanvasPaintTokens) => readCanvasPaintTokens()[name]
import { getCanvasInteractionStrokeVisual, resolveZoneVisual } from '../canvas/runtime/scene-visuals'

describe('overlay stroke casing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives every interaction stroke a wider casing in its theme contrast colour', () => {
    for (const state of ['hover', 'highlight', 'selected', 'locked-design-object', 'locked-layer'] as const) {
      const visual = getCanvasInteractionStrokeVisual(state)
      expect(visual.casingColor, state).toBe(getCanvasColor('interaction-casing'))
      expect(visual.casingWidthPx, state).toBeGreaterThanOrEqual(visual.widthPx + 2)
    }
  })

  it('cases Zone strokes in the dark overlay casing', () => {
    const visual = resolveZoneVisual({
      kind: 'zone', id: 'bed', name: 'bed', zoneType: 'rect', locked: false, rotationDeg: 0,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], fillColor: null, notes: null,
    })
    expect(visual.stroke).toBe(getCanvasColor('zone-stroke'))
    expect(visual.casing).toBe(getCanvasColor('overlay-casing'))
  })

})
