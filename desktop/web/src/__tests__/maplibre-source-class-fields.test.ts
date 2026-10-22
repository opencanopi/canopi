// MapLibre's TypeScript sources, through the test-only `maplibre-gl-source` alias (vite.config.ts), keep the legacy class
// fields they are written for: a subclass's bare field declaration never resets what the base constructor set.
import { describe, expect, it } from 'vitest'
import { FillStyleLayer } from 'maplibre-gl-source/style/style_layer/fill_style_layer.ts'

describe('MapLibre sources under Vite 8', () => {
  it('canopi-f47t.52.228.17: a FillStyleLayer keeps the transitioning paint its base constructor set', () => {
    const layer = new FillStyleLayer({ id: 'fill', type: 'fill', source: 'design' }, {})

    expect(layer._transitioningPaint).toBeDefined()
    expect(layer._transitionablePaint).toBeDefined()
    expect(layer.hasTransition()).toBe(false)
  })
})
