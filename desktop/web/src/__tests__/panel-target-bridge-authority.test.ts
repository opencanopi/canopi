import { describe, expect, it } from 'vitest'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import { hoveredPanelTargets, selectedPanelTargets } from '../app/panel-targets/state'
import { currentCanvasSelection } from '../canvas/session-state'
import { targets, speciesTarget } from '../target'

function createScene() {
  const scene = createDefaultScenePersistedState()
  scene.plants = [
    {
      kind: 'plant',
      locked: false,
      id: 'plant-1',
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: null,
      canopySpreadM: null,
      position: { x: 0, y: 0 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: null,
    },
  ]
  return scene
}

describe('panel target bridge authority', () => {
  it('keeps resolver and map projection seams pure', () => {
    const selectionBefore = new Set(['canvas-selection'])
    currentCanvasSelection.value = selectionBefore
    hoveredPanelTargets.value = [speciesTarget('Malus domestica')]
    selectedPanelTargets.value = [speciesTarget('Malus domestica')]

    const scene = createScene()
    const targetList = [speciesTarget('Malus domestica')]

    const resolved = targets.resolve(targetList, targets.indexScene(scene))

    expect(resolved.plantIds).toEqual(['plant-1'])

    expect(currentCanvasSelection.value).toEqual(selectionBefore)
    expect(hoveredPanelTargets.value).toEqual([speciesTarget('Malus domestica')])
    expect(selectedPanelTargets.value).toEqual([speciesTarget('Malus domestica')])
  })
})
