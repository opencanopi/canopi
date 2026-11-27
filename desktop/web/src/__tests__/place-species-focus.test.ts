// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusOwner } from '../app/keyboard/focus-owner'
import { placeSpeciesOnMap } from '../components/plant-db/place-species'
import { currentCanvasToolState, setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { recentPlantStampSources } from '../canvas/stamp-drag-data'

// Esc cancels Place plants only when the key comes from the map (the canvas
// ignores Esc from panel buttons on purpose), so every Place button hands
// focus to the map surface after arming the tool (canopi-agjl).
describe('Place moves focus to the map so Esc reaches the armed tool', () => {
  let map: HTMLElement
  let mapControl: HTMLButtonElement
  let placeButton: HTMLButtonElement
  let release: () => void

  beforeEach(() => {
    map = document.createElement('div')
    map.tabIndex = 0
    map.innerHTML = '<button>Zoom in</button>'
    mapControl = map.querySelector('button')!
    placeButton = document.createElement('button')
    document.body.append(map, placeButton)
    release = focusOwner.registerRegion('map', map)
  })

  afterEach(() => {
    release()
    setCurrentCanvasSession(null)
    recentPlantStampSources.value = []
    document.body.innerHTML = ''
  })

  it('focuses the map surface itself, not the control last used inside it', () => {
    mapControl.focus()
    placeButton.focus()
    focusOwner.focusMap()
    expect(document.activeElement).toBe(map)
  })

  it('arms Place plants with the species and focuses the map', () => {
    const arm = vi.fn(() => ({ settled: new Promise<never>(() => {}), cancel: () => {} }))
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands: createTestCanvasCommandSurface({ tools: { arm } }) }))
    placeButton.focus()
    const species = { canonical_name: 'Corylus avellana', common_name: 'European hazelnut', stratum: null, width_max_m: null }
    placeSpeciesOnMap(species)
    expect(arm).toHaveBeenCalledWith('plant-stamp', { kind: 'species', species }, undefined)
    expect(currentCanvasToolState.value).toEqual({
      id: 'plant-stamp',
      source: { kind: 'species', species },
      stampId: null,
    })
    expect(document.activeElement).toBe(map)
  })

  it('leaves focus alone when there is no canvas to place on', () => {
    placeButton.focus()
    placeSpeciesOnMap({ canonical_name: 'Corylus avellana', common_name: 'European hazelnut', stratum: null, width_max_m: null })
    expect(document.activeElement).toBe(placeButton)
  })
})
