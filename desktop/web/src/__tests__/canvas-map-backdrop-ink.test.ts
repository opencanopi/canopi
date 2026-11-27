// @vitest-environment jsdom

// The backdrop rules no UI theme reaches. Each theme's ink over each backdrop, the same ink in both themes and the
// Inspection Lens paper's ink are browser checks on the real cascade: e2e/canvas/backdrop-ink.spec.ts
// (canopi-f47t.52.253).
import { describe, expect, it } from 'vitest'

import { createMapLibreEmptyStyle } from '../maplibre/config'
import {
  CANVAS_MAP_BACKDROP_COLORS,
  getLabelHalo,
  getMapBackdropInk,
  getMapTextColor,
} from '../canvas/runtime/scene-visuals'
import { SceneRuntimePresentationController } from '../canvas/runtime/scene-runtime/presentation'
import { SceneStore } from '../canvas/runtime/scene'

describe('canvas label ink follows the map backdrop, not the UI theme', () => {
  it('keeps cream text on a dark halo over satellite imagery', () => {
    const ink = getMapBackdropInk('satellite')
    expect(getMapTextColor(ink)).toBe('#FFF3D6')
    expect(getLabelHalo(12, ink).color).toBe('#14100A')
  })

  it('treats no background as the map’s own paper colour', () => {
    const background = createMapLibreEmptyStyle().layers[0]!
    expect(background.type).toBe('background')
    const paint = (background as { paint?: Record<string, unknown> }).paint
    expect(String(paint?.['background-color']).toLowerCase()).toBe(CANVAS_MAP_BACKDROP_COLORS.paper.toLowerCase())
  })

  it('reports whether the backdrop changed', () => {
    const controller = new SceneRuntimePresentationController({
      sceneStore: new SceneStore(),
      readPixelsPerMetre: () => 1,
      getLocale: () => 'en',
      resolveHighlightedTargets: () => ({ plantIds: [], zoneIds: [] }),
      onPlantNamesChanged: () => {},
    })
    expect(controller.setMapBackdrop('basemap')).toBe(false)
    expect(controller.setMapBackdrop('satellite')).toBe(true)
  })
})
