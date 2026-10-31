// The Site data pin, profile line and chart hover as MapLibre overlay contracts (canopi-f47t.42, spec §1.10).
import { afterEach, describe, expect, it } from 'vitest'
import {
  getGuideLineVisual,
  getMapBackdropInk,
  OVERLAY_CASING_EXTRA_PX,
  setCanvasMapBackdrop,
  SITE_PIN_VISUAL,
} from '../canvas/runtime/scene-visuals'
import { siteHoverOverlayContract, siteMapOverlayContract, siteMapOverlayIds } from './site-overlay'

const PIN = [2.35, 48.85] as const
const LINE = [[2.35, 48.85], [2.36, 48.86], [2.37, 48.85]] as const

function paintOf(contract: { readonly layers: readonly { readonly id: string; readonly paint: Readonly<Record<string, unknown>> }[] }, id: string) {
  return contract.layers.find((layer) => layer.id === id)!.paint
}

describe('the Site data map overlay', () => {
  afterEach(() => {
    setCanvasMapBackdrop('basemap')
  })

  it('draws nothing with neither a pin nor a line, but names every layer so a sync clears them', () => {
    for (const site of [null, { pin: null, profileLine: null }]) {
      const contract = siteMapOverlayContract(site)
      expect(contract.hasRenderableFeatures).toBe(false)
      expect(contract.source.data.features).toEqual([])
      expect(contract.layers.map((layer) => layer.id)).toEqual(siteMapOverlayIds().layerIds)
    }
  })

  it('draws the pin as one point and the line with a dot at each vertex, on one source, back to front', () => {
    const contract = siteMapOverlayContract({ pin: PIN, profileLine: LINE })
    const ids = siteMapOverlayIds()

    expect(contract.hasRenderableFeatures).toBe(true)
    expect(contract.source.id).toBe(ids.sourceId)
    expect(contract.source.data.features.map((feature) => [feature.properties.role, feature.geometry.coordinates])).toEqual([
      ['profile-line', LINE],
      ...LINE.map((vertex) => ['profile-vertex', vertex]),
      ['pin', PIN],
    ])
    expect(contract.layers.map((layer) => layer.id)).toEqual(ids.layerIds)
    expect(contract.layers.every((layer) => layer.source === ids.sourceId)).toBe(true)
    expect(contract.layers.map((layer) => [layer.type, layer.filter])).toEqual([
      ['line', ['==', ['get', 'role'], 'profile-line']],
      ['line', ['==', ['get', 'role'], 'profile-line']],
      ['circle', ['==', ['get', 'role'], 'profile-vertex']],
      ['circle', ['==', ['get', 'role'], 'pin']],
      ['circle', ['==', ['get', 'role'], 'pin']],
    ])
    expect(siteMapOverlayContract({ pin: PIN, profileLine: null }).source.data.features).toHaveLength(1)
    expect(siteMapOverlayContract({ pin: null, profileLine: LINE }).hasRenderableFeatures).toBe(true)
  })

  it('takes the line from the canvas visuals and paints the pin an ink core in a white ring on every backdrop', () => {
    const contract = siteMapOverlayContract({ pin: PIN, profileLine: LINE })
    const guide = getGuideLineVisual()

    expect(paintOf(contract, 'site-profile-casing')['line-color']).toBe(guide.casing)
    expect(paintOf(contract, 'site-profile-line')['line-color']).toBe(guide.color)
    expect(Number(paintOf(contract, 'site-profile-casing')['line-width']) - Number(paintOf(contract, 'site-profile-line')['line-width']))
      .toBe(OVERLAY_CASING_EXTRA_PX)

    // Spec §1.10 and the board's MAPINK: the pin sits on imagery, so its two tones never follow the backdrop.
    for (const backdrop of ['basemap', 'satellite'] as const) {
      setCanvasMapBackdrop(backdrop)
      const pinned = siteMapOverlayContract({ pin: PIN, profileLine: null })
      expect(paintOf(pinned, 'site-pin-core')['circle-color']).toBe('#27231D')
      expect(paintOf(pinned, 'site-pin-ring')['circle-color']).toBe('#FFFFFF')
    }
  })

  it('draws no point that is not finite', () => {
    const contract = siteMapOverlayContract({ pin: [Number.NaN, 48], profileLine: [[2, 48], [Number.POSITIVE_INFINITY, 48]] })
    expect(contract.hasRenderableFeatures).toBe(false)
  })

  it('draws the chart hover as a hollow ring on its own source, and nothing for null', () => {
    const ids = siteMapOverlayIds().hover
    const hover = siteHoverOverlayContract(PIN)
    expect(hover.hasRenderableFeatures).toBe(true)
    expect(hover.source.id).toBe(ids.sourceId)
    expect(hover.source.data.features.map((feature) => feature.geometry.coordinates)).toEqual([PIN])
    expect(hover.layers.map((layer) => layer.id)).toEqual(ids.layerIds)
    const ring = paintOf(hover, 'site-hover-ring')
    expect(ring['circle-opacity']).toBe(0)
    expect(ring['circle-stroke-color']).toBe(getMapBackdropInk().text)

    const none = siteHoverOverlayContract(null)
    expect(none.hasRenderableFeatures).toBe(false)
    expect(none.layers.map((layer) => layer.id)).toEqual(ids.layerIds)
  })

  it('takes every colour from scene-visuals.ts: each layer paints only guide, pin and backdrop ink colours, on every backdrop (spec §1.10)', () => {
    for (const backdrop of ['basemap', 'dark-basemap', 'satellite', 'paper'] as const) {
      setCanvasMapBackdrop(backdrop)
      const guide = getGuideLineVisual()
      const ink = getMapBackdropInk()
      const visuals = [guide.color, guide.casing, SITE_PIN_VISUAL.core, SITE_PIN_VISUAL.ring, ink.halo, ink.text]
      const layers = [...siteMapOverlayContract({ pin: PIN, profileLine: LINE }).layers, ...siteHoverOverlayContract(PIN).layers]
      const colours = layers.flatMap((layer) => Object.entries(layer.paint).filter(([key]) => key.endsWith('-color')).map(([, value]) => value))
      expect(colours.length, backdrop).toBeGreaterThan(0)
      for (const colour of colours) expect(visuals, backdrop).toContain(colour)
    }
  })
})
