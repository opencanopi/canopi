import { effect } from '@preact/signals'
import { describe, expect, it } from 'vitest'
import {
  createDefaultMapLayersForTests as createDefaultMapLayers,
  mapLayers,
  type MapLayersState,
  locale,
} from '../settings/state'
import type { Locale } from '../../generated/contracts'
import { readWorkspaceActivationSnapshot, readWorkspaceBackgroundPresentation } from './workspace-activation-snapshot'

const identity = {}

function store(hasDesign = true) {
  return {
    hasCurrentDesign: () => hasDesign,
    sessionIdentity: { peek: () => identity },
  } as never
}

function layers(overrides: {
  basemap?: Partial<MapLayersState['basemap']>
  satellite?: Partial<MapLayersState['satellite']>
} = {}): MapLayersState {
  const defaults = createDefaultMapLayers()
  return {
    ...defaults,
    basemap: { ...defaults.basemap, ...overrides.basemap },
    satellite: { ...defaults.satellite, ...overrides.satellite },
  }
}

/** Reads with the app locale set to `value`, restoring it afterwards. */
function inLocale<T>(value: Locale, read: () => T): T {
  const previous = locale.peek()
  locale.value = value
  try {
    return read()
  } finally {
    locale.value = previous
  }
}

describe('readWorkspaceActivationSnapshot', () => {
  it('returns null without a current Design', () => {
    expect(readWorkspaceActivationSnapshot({ store: store(false), readInitialCenter: () => ({ lat: 0, lon: 0 }) })).toBeNull()
  })

  it('copies the initial map centre and normalized background presentation', () => {
    const basemap = { style: 'positron' as const, visible: true, opacity: Number.NaN }
    const snapshot = inLocale('fr', () => readWorkspaceActivationSnapshot({
      store: store(),
      readInitialCenter: () => ({ lat: 48.86, lon: 2.35 }),
      readMapLayers: () => ({ ...layers(), basemap }),
    }))
    expect(snapshot).toEqual(expect.objectContaining({
      sessionIdentity: identity,
      map: expect.objectContaining({
        initialCenter: { lat: 48.86, lon: 2.35 },
        background: {
          basemap: { style: 'positron', visible: true, opacity: 0 },
          satellite: { visible: false, opacity: 1 },
          locale: 'fr',
        },
      }),
    }))
    expect(snapshot?.map).not.toHaveProperty('anchor')
    expect(snapshot?.map).not.toHaveProperty('northBearingDeg')
    expect(snapshot?.map).not.toHaveProperty('placementStatus')
    basemap.visible = false
    expect(snapshot?.map.background.basemap.visible).toBe(true)
    expect(Object.isFrozen(snapshot?.map.initialCenter)).toBe(true)
    expect(Object.isFrozen(snapshot?.map.background)).toBe(true)
    expect(Object.isFrozen(snapshot?.map.background.basemap)).toBe(true)
  })

  it('shares normalized presentation with the live settings reader', () => {
    expect(inLocale('de', () => readWorkspaceBackgroundPresentation({
      readMapLayers: () => layers({
        basemap: { style: 'dark', visible: false, opacity: 2 },
        satellite: { visible: true, opacity: -1 },
      }),
    }))).toEqual({
      basemap: { style: 'dark', visible: false, opacity: 1 },
      satellite: { visible: true, opacity: 0 },
      locale: 'de',
    })
  })

  it('never carries the Google key into the background presentation', () => {
    const presentation = readWorkspaceBackgroundPresentation({
      readMapLayers: () => layers({ satellite: { visible: true } }),
    })
    expect(Object.keys(presentation.satellite).sort()).toEqual(['opacity', 'visible'])
  })

  it('tracks the map layer store and locale through the default readers', () => {
    const previousLayers = mapLayers.peek()
    const previousLocale = locale.peek()
    const seen: ReturnType<typeof readWorkspaceBackgroundPresentation>[] = []
    const dispose = effect(() => {
      seen.push(readWorkspaceBackgroundPresentation())
    })

    try {
      mapLayers.value = layers({ basemap: { style: 'bright', visible: false, opacity: 0.37 } })
      expect(seen).toHaveLength(2)
      expect(seen.at(-1)?.basemap).toEqual({ style: 'bright', visible: false, opacity: 0.37 })

      mapLayers.value = layers({ satellite: { visible: true, opacity: 0.5 } })
      expect(seen.at(-1)?.satellite).toEqual({ visible: true, opacity: 0.5 })

      locale.value = previousLocale === 'fr' ? 'de' : 'fr'
      expect(seen).toHaveLength(4)
      expect(seen.at(-1)?.locale).toBe(locale.peek())
    } finally {
      dispose()
      mapLayers.value = previousLayers
      locale.value = previousLocale
    }
  })
})
