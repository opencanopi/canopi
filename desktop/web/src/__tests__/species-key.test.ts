import { decodeCanopiDesign, encodeCanopiDesign } from './support/design-wire'
import { describe, expect, it } from 'vitest'
import { allocateSpeciesCodes } from '../canvas/runtime/species-key'
import { DEFAULT_PLANT_DISPLAY } from '../canvas/runtime/plant-display'

describe('Species codes', () => {
  it('assigns readable unique codes independently of plant order', () => {
    const names = [
      'Symphytum officinale',
      'Salvia officinalis',
      'Mentha spicata',
    ]
    const codes = allocateSpeciesCodes({}, names)
    expect(codes).toEqual({
      'Mentha spicata': 'MSP',
      'Salvia officinalis': 'SOF',
      'Symphytum officinale': 'SOF2',
    })
    expect(allocateSpeciesCodes({}, names.reverse())).toEqual(codes)
  })
  it('reserves existing codes when species are added, removed and restored', () => {
    const original = allocateSpeciesCodes({}, ['Symphytum officinale'])
    const next = allocateSpeciesCodes(original, ['Salvia officinalis'])
    expect(next['Symphytum officinale']).toBe('SOF')
    expect(next['Salvia officinalis']).toBe('SOF2')
    expect(allocateSpeciesCodes(next, ['Symphytum officinale'])).toEqual(next)
  })
  it('repairs invalid and duplicate imported codes deterministically', () => {
    const codes = allocateSpeciesCodes(
      {
        'Salvia officinalis': 'SOF',
        'Symphytum officinale': 'SOF',
        'Mentha spicata': '',
      },
      ['Mentha spicata'],
    )
    expect(new Set(Object.values(codes)).size).toBe(3)
    expect(codes['Mentha spicata']).toBe('MSP')
    expect(codes['Symphytum officinale']).toBe('SOF2')
  })
})

import { SceneStore } from '../canvas/runtime/scene/store'
import { createTestSceneRendererSnapshot } from './support/scene-renderer-snapshot'
import { getCanvasPlantNameLabels } from '../canvas/runtime/automatic-detail'

it('reserves codes across edits, serialization and reopening', () => {
  const store = new SceneStore()
  const plant = {
    kind: 'plant' as const,
    locked: false,
    id: 'salvia',
    canonicalName: 'Salvia officinalis',
    commonName: null,
    color: null,
    canopySpreadM: null,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    scale: 1,
    notes: null,
    plantedDate: null,
    quantity: 1,
  }
  store.updatePersisted((draft) => {
    draft.plants.push(plant)
  })
  expect(store.persisted.plantSpeciesCodes['Salvia officinalis']).toBe('SOF')
  store.updatePersisted((draft) => {
    draft.plants = [
      { ...plant, id: 'comfrey', canonicalName: 'Symphytum officinale' },
    ]
  })
  const reopened = new SceneStore().hydrate(
    decodeCanopiDesign(encodeCanopiDesign(store.toCanopiFile())),
  )
  expect(reopened.persisted.plantSpeciesCodes).toEqual({
    'Salvia officinalis': 'SOF',
    'Symphytum officinale': 'SOF2',
  })
})

it('admits short codes at detail scale while keeping dense labels collision-free', () => {
  const plants = Array.from({ length: 20 }, (_, index) => ({
    kind: 'plant' as const,
    locked: false,
    id: String(index),
    canonicalName: 'Mentha spicata',
    commonName: 'Mint',
    color: null,
    canopySpreadM: null,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    scale: 1,
    notes: null,
    plantedDate: null,
    quantity: 1,
  }))
  const snapshot = createTestSceneRendererSnapshot({
    scene: { plants, plantSpeciesCodes: { 'Mentha spicata': 'MSP' } },
    plantDisplay: { ...DEFAULT_PLANT_DISPLAY, labels: 'codes' },
  })
  const pixelsPerMetre = 60
  const labels = getCanvasPlantNameLabels(snapshot, pixelsPerMetre)
  expect(labels.length).toBeGreaterThan(0)
  expect(labels.length).toBeLessThanOrEqual(2)
  expect(labels.every((label) => label.text === 'MSP')).toBe(true)
  expect(
    getCanvasPlantNameLabels(snapshot, 10),
  ).toEqual([])
  // Names need 100 px/m; Labels › None admits no automatic label at any scale.
  expect(getCanvasPlantNameLabels({ ...snapshot, plantDisplay: { ...DEFAULT_PLANT_DISPLAY, labels: 'names' } }, pixelsPerMetre)).toEqual([])
  expect(getCanvasPlantNameLabels({ ...snapshot, plantDisplay: { ...DEFAULT_PLANT_DISPLAY, labels: 'none' } }, 400)).toEqual([])
  expect(
    getCanvasPlantNameLabels({
      ...snapshot,
      scene: {
        ...snapshot.scene,
        layers: [
          {
            kind: 'layer',
            name: 'plants',
            visible: false,
            locked: false,
            opacity: 1,
          },
        ],
      },
    }, pixelsPerMetre),
  ).toEqual([])
})
