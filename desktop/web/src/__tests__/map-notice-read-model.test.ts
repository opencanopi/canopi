import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasSurfaceState } from '../app/canvas-map-surface/canvas-host'
import { getMapNoticeReadModel } from '../app/canvas-map-surface/map-notice'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import type { LayerSlotId, LayerStatus } from '../maplibre/map-lifetime'

function readySurface(layers: ReadonlyArray<readonly [LayerSlotId, LayerStatus]> = []): CanvasSurfaceState {
  return {
    kind: 'map',
    map: { kind: 'ready', attempt: 1, layers: new Map(layers) },
    retry: 'withheld',
  }
}

function failedMapSurface(retry: 'offered' | 'withheld' | 'never'): CanvasSurfaceState {
  return {
    kind: 'map',
    map: { kind: 'failed', attempt: 1, cause: retry === 'never' ? 'no-webgl2' : 'context-lost' },
    retry,
  }
}

function translate(key: string): string {
  return {
    'canvas.layers.mapUnavailable': 'Map unavailable',
    'canvas.layers.basemapLoading': 'Loading',
    'canvas.layers.layerSkipped': 'A map layer couldn’t be shown',
    'canvas.layers.basemapFailed': 'Basemap couldn’t load. Check your connection.',
    'canvas.layers.satelliteFailed': 'Satellite imagery couldn’t load. Check your connection or your Google key in Settings.',
    'canvas.layers.mapStopped': 'The map stopped drawing. Your Design is safe.',
  }[key] ?? key
}

describe('Map Notice read model', () => {
  afterEach(() => {
    mapLayers.value = createDefaultMapLayers()
  })

  it('reports loading while the basemap is not ready', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: { kind: 'map', map: { kind: 'creating', attempt: 1 }, retry: 'withheld' },
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'loading',
      statusText: 'Loading',
      retry: false,
    })
  })

  it('reports a map failure with a fixed message, never the engine text', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: failedMapSurface('never'),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'error',
      statusText: 'Map unavailable',
      retry: false,
    })
  })

  it('offers Retry on a map that stopped drawing and can be rebuilt', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: failedMapSurface('offered'),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'error',
      statusText: 'The map stopped drawing. Your Design is safe.',
      retry: true,
    })
  })

  it('reports a failed basemap with Retry, below a map failure and above a skipped layer', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: readySurface([
        ['background', { kind: 'failed', reason: 'basemap' }],
        ['terrain', { kind: 'failed', reason: 'terrain' }],
        ['library:skipped', { kind: 'skipped', reason: 'layer-skipped' }],
      ]),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'error',
      statusText: 'Basemap couldn’t load. Check your connection.',
      retry: true,
    })
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: failedMapSurface('never'),
      t: translate,
    })).toMatchObject({ statusText: 'Map unavailable', retry: false })
  })

  // canopi-k94s: one sentence for a rejected key and a lost connection, with the Basemap's Retry.
  it('names Satellite in a background failure while Satellite is on', () => {
    const base = createDefaultMapLayers()
    mapLayers.value = { ...base, satellite: { ...base.satellite, visible: true } }
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: readySurface([['background', { kind: 'failed', reason: 'basemap' }]]),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'error',
      statusText: 'Satellite imagery couldn’t load. Check your connection or your Google key in Settings.',
      retry: true,
    })
    // While its Google session opens, Satellite shows the same loading notice as the Street map.
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: readySurface([['background', { kind: 'loading' }]]),
      t: translate,
    })).toMatchObject({ statusText: 'Loading', tone: 'loading', retry: false })
  })

  it('reports a basemap download in progress as loading, without Retry', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: readySurface([
        ['background', { kind: 'loading' }],
        ['library:skipped', { kind: 'skipped', reason: 'layer-skipped' }],
      ]),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'loading',
      statusText: 'Loading',
      retry: false,
    })
  })

  it('reports a terrain failure as a skipped layer, never the engine text', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: readySurface([['terrain', { kind: 'failed', reason: 'terrain' }]]),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'ready',
      statusText: 'A map layer couldn’t be shown',
      retry: false,
    })
  })

  it('reports a skipped optional layer as a quiet ready notice', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: readySurface([['library:skipped', { kind: 'skipped', reason: 'layer-skipped' }]]),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: true,
      tone: 'ready',
      statusText: 'A map layer couldn’t be shown',
      retry: false,
    })
  })

  it('hides for a ready map with no actionable map status', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: true,
      surface: readySurface([['background', { kind: 'ready' }]]),
      t: translate,
    })).toEqual({
      visible: false,
      mapSurfaceVisible: true,
      tone: 'ready',
      statusText: '',
      retry: false,
    })
  })

  it('hides without an open Design', () => {
    expect(getMapNoticeReadModel({
      hasDesign: false,
      mapVisible: true,
      surface: failedMapSurface('never'),
      t: translate,
    })).toMatchObject({ visible: false, mapSurfaceVisible: false, statusText: '' })
  })

  it('reports a map that stopped drawing with Retry even when every background row is hidden', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: false,
      surface: failedMapSurface('offered'),
      t: translate,
    })).toEqual({
      visible: true,
      mapSurfaceVisible: false,
      tone: 'error',
      statusText: 'The map stopped drawing. Your Design is safe.',
      retry: true,
    })
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: false,
      surface: failedMapSurface('never'),
      t: translate,
    })).toMatchObject({ visible: true, statusText: 'Map unavailable', retry: false })
  })

  it('hides without a visible map layer', () => {
    expect(getMapNoticeReadModel({
      hasDesign: true,
      mapVisible: false,
      surface: { kind: 'map', map: { kind: 'creating', attempt: 1 }, retry: 'withheld' },
      t: translate,
    })).toMatchObject({ visible: false, mapSurfaceVisible: false, statusText: '' })
  })
})
