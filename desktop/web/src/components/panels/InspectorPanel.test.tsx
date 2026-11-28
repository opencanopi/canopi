// @vitest-environment jsdom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeInspector, inspectorOpen, openInspector } from '../../app/planning-view/state'
import { zoneDimensionsVisible } from '../../app/canvas-settings/signals'
import { installSpeciesCatalogWorkbench, type SpeciesCatalogWorkbench } from '../../app/plant-browser'
import { locale, unitSystem } from '../../app/settings/state'
import { currentCanvasSession } from '../../canvas/session'
import type { CanvasRuntimeSurfaces, CanvasSceneEditCommandSurface } from '../../canvas/runtime/runtime'
import { createDefaultScenePersistedState, type ScenePersistedState } from '../../canvas/runtime/scene'
import { createSessionPlane } from '../../geo/session-plane'
import { InspectorPanel } from './InspectorPanel'

function makePersistedScene(): ScenePersistedState {
  const scene = createDefaultScenePersistedState()
  scene.zones = [
    {
      kind: 'zone',
      id: 'z-rect',
      name: 'Rect bed',
      locked: false,
      zoneType: 'rect',
      points: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }],
      rotationDeg: 0,
      fillColor: '#4caf50',
      strokeColor: '#2e7d32',
      opacity: 0.8,
      notes: null,
    },
    {
      kind: 'zone',
      id: 'z-poly',
      name: 'Triangle',
      locked: false,
      zoneType: 'polygon',
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }],
      rotationDeg: 0,
      fillColor: '#8bc34a',
      notes: null,
    },
    {
      kind: 'zone',
      id: 'z-line',
      name: 'Swale',
      locked: false,
      zoneType: 'line',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      rotationDeg: 0,
      fillColor: '#03a9f4',
      notes: null,
    },
  ]
  scene.measurementGuides = [
    { kind: 'measurement-guide', id: 'g-1', locked: false, start: { x: 0, y: 0 }, end: { x: 6, y: 0 } },
  ]
  scene.plants = [
    {
      kind: 'plant',
      id: 'p-1',
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#e53935',
      position: { x: 1, y: 1 },
      rotationDeg: 0,
      canopySpreadM: 4,
      notes: 'Young tree',
      plantedDate: '2026-03-01',
      quantity: 2,
    },
  ]
  scene.annotations = [
    {
      kind: 'annotation',
      id: 'a-1',
      locked: false,
      annotationType: 'text',
      position: { x: 2, y: 2 },
      text: 'Mulch heavily',
      fontSize: 16,
      rotationDeg: 0,
    },
  ]
  return scene
}

describe('InspectorPanel', () => {
  let container: HTMLDivElement
  const edits: Partial<CanvasSceneEditCommandSurface> = {
    editZoneDimensions: vi.fn(() => true),
    setZoneStyle: vi.fn(() => true),
    editMeasurementGuideDimensions: vi.fn(() => true),
    editPlantFields: vi.fn(() => true),
    replacePlantsSpecies: vi.fn(() => true),
    editAnnotationFields: vi.fn(() => true),
  }
  const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
  const sceneRev = signal(0)

  function mountWithSelection(editableTargets: readonly { kind: string; id: string }[], persisted = makePersistedScene()) {
    currentCanvasSession.value = {
      queries: {
        revision: { scene: sceneRev },
        sessionPlane: signal(plane),
        getSceneSnapshot: () => persisted,
        getDesignObjectSelection: () => ({
          editableTargets,
          lockedTargets: [],
          blockedTargets: [],
          bounds: null,
        }),
      },
      commands: {
        sceneEdits: edits,
      },
    } as unknown as CanvasRuntimeSurfaces
    return act(() => render(<InspectorPanel />, container))
  }

  async function commitTextInput(id: string, value: string, viaEnter = false) {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!
    expect(input).not.toBeNull()
    await act(() => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(() => {
      if (viaEnter) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      } else {
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      }
    })
    return input
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    locale.value = 'en'
    unitSystem.value = 'metric'
    zoneDimensionsVisible.value = true
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await act(() => render(null, container))
    container.remove()
    currentCanvasSession.value = null
    closeInspector()
  })

  it('shows empty state when nothing is selected and closes when close button is clicked', async () => {
    openInspector()
    await mountWithSelection([])
    expect(container.querySelector('[data-inspector-panel]')).not.toBeNull()
    expect(container.querySelector('input')).toBeNull()
    await act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(inspectorOpen.value).toBe(false)
  })

  it('edits rect zone dimensions, invalid values, and zone style', async () => {
    await mountWithSelection([{ kind: 'zone', id: 'z-rect' }])
    await commitTextInput('inspector-width', '5 m', true)
    expect(edits.editZoneDimensions).toHaveBeenCalledWith('z-rect', { widthM: 5 })
    await commitTextInput('inspector-height', '3 m')
    expect(edits.editZoneDimensions).toHaveBeenCalledWith('z-rect', { heightM: 3 })
    await commitTextInput('inspector-rotation', '15')
    expect(edits.editZoneDimensions).toHaveBeenCalledWith('z-rect', { rotationDeg: 15 })
    await commitTextInput('inspector-center-lat', '48.86')
    await commitTextInput('inspector-center-lon', '2.36')
    expect(edits.editZoneDimensions).toHaveBeenCalledTimes(5)

    // Invalid dimension marks aria-invalid
    const badWidth = await commitTextInput('inspector-width', '-5 m')
    expect(badWidth.getAttribute('aria-invalid')).toBe('true')
    const badRot = await commitTextInput('inspector-rotation', 'not-a-number')
    expect(badRot.getAttribute('aria-invalid')).toBe('true')

    // Opacity slider commits unified opacity
    const range = container.querySelector<HTMLInputElement>('#inspector-zone-opacity')!
    await act(() => {
      range.value = '0.5'
      range.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(edits.setZoneStyle).toHaveBeenCalledWith('z-rect', { opacity: 0.5 })
  })

  it('edits polygon zone side lengths, interior angles, and centre lat/lon', async () => {
    await mountWithSelection([{ kind: 'zone', id: 'z-poly' }])
    await commitTextInput('inspector-side-0', '6 m')
    expect(edits.editZoneDimensions).toHaveBeenCalledWith('z-poly', { sideIndex: 0, sideLengthM: 6 })
    await commitTextInput('inspector-corner-0', '90')
    expect(edits.editZoneDimensions).toHaveBeenCalledWith('z-poly', { cornerIndex: 0, cornerAngleDeg: 90 })
    await commitTextInput('inspector-center-lat', '48.851')
    await commitTextInput('inspector-center-lon', '2.351')
    expect(edits.editZoneDimensions).toHaveBeenCalledTimes(4)
  })

  it('edits line zone and measurement guide dimensions', async () => {
    await mountWithSelection([{ kind: 'zone', id: 'z-line' }])
    await commitTextInput('inspector-length', '12 m')
    expect(edits.editZoneDimensions).toHaveBeenCalledWith('z-line', { lengthM: 12 })
    await commitTextInput('inspector-angle', '30')
    expect(edits.editZoneDimensions).toHaveBeenCalledWith('z-line', { angleDeg: 30 })
    await commitTextInput('inspector-center-lat', '48.852')
    await commitTextInput('inspector-center-lon', '2.352')

    await mountWithSelection([{ kind: 'measurement-guide', id: 'g-1' }])
    await commitTextInput('inspector-guide-length', '8 m')
    expect(edits.editMeasurementGuideDimensions).toHaveBeenCalledWith('g-1', { lengthM: 8 })
    await commitTextInput('inspector-guide-angle', '45')
    expect(edits.editMeasurementGuideDimensions).toHaveBeenCalledWith('g-1', { angleDeg: 45 })
    await commitTextInput('inspector-center-lat', '48.853')
    await commitTextInput('inspector-center-lon', '2.353')
  })

  it('edits plant fields and annotation fields', async () => {
    await mountWithSelection([{ kind: 'plant', id: 'p-1' }])
    await commitTextInput('inspector-plant-spread', '5 m')
    expect(edits.editPlantFields).toHaveBeenCalledWith('p-1', { canopySpreadM: 5 })
    await commitTextInput('inspector-plant-quantity', '3')
    expect(edits.editPlantFields).toHaveBeenCalledWith('p-1', { quantity: 3 })
    await commitTextInput('inspector-plant-quantity', '1,000')
    expect(edits.editPlantFields).toHaveBeenCalledWith('p-1', { quantity: 1000 })
    const dateInput = container.querySelector<HTMLInputElement>('#inspector-plant-date')!
    await act(() => {
      dateInput.value = '2026-05-01'
      dateInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(edits.editPlantFields).toHaveBeenCalledWith('p-1', { plantedDate: '2026-05-01' })
    const notesArea = container.querySelector<HTMLTextAreaElement>('#inspector-plant-notes')!
    await act(() => {
      notesArea.value = 'Pruned'
      notesArea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(edits.editPlantFields).toHaveBeenCalledWith('p-1', { notes: 'Pruned' })

    await mountWithSelection([{ kind: 'annotation', id: 'a-1' }])
    const noteText = container.querySelector<HTMLTextAreaElement>('#inspector-note-text')!
    await act(() => {
      noteText.value = 'Updated note'
      noteText.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(edits.editAnnotationFields).toHaveBeenCalledWith('a-1', { text: 'Updated note' })
    await commitTextInput('inspector-note-font-size', '20')
    expect(edits.editAnnotationFields).toHaveBeenCalledWith('a-1', { fontSize: 20 })
  })

  it('locks aspect ratio on rect zones so changing width or height scales the other axis proportionally', async () => {
    await mountWithSelection([{ kind: 'zone', id: 'z-rect' }])
    const widthInput = container.querySelector<HTMLInputElement>('#inspector-width')!
    // Normalized dimension formatting omits trailing .0 on whole metres.
    expect(widthInput.value).toBe('4 m')

    const lockBtn = container.querySelector<HTMLButtonElement>('#inspector-aspect-lock')!
    expect(lockBtn.getAttribute('aria-pressed')).toBe('false')
    await act(() => lockBtn.click())
    expect(lockBtn.getAttribute('aria-pressed')).toBe('true')

    // Rect is 4 m x 2 m (2:1). Setting width to 8 m scales height to ~4 m in one edit.
    await commitTextInput('inspector-width', '8 m', true)
    const widthCall = vi.mocked(edits.editZoneDimensions!).mock.calls.at(-1)!
    expect(widthCall[0]).toBe('z-rect')
    expect(widthCall[1].widthM).toBeCloseTo(8, 5)
    expect(widthCall[1].heightM).toBeCloseTo(4, 2)

    // Setting height to 1 m scales width to ~2 m in one edit.
    await commitTextInput('inspector-height', '1 m', true)
    const heightCall = vi.mocked(edits.editZoneDimensions!).mock.calls.at(-1)!
    expect(heightCall[0]).toBe('z-rect')
    expect(heightCall[1].heightM).toBeCloseTo(1, 5)
    expect(heightCall[1].widthM).toBeCloseTo(2, 2)

    // Unlocking restores independent axis editing.
    await act(() => lockBtn.click())
    expect(lockBtn.getAttribute('aria-pressed')).toBe('false')
    await commitTextInput('inspector-width', '6 m', true)
    expect(edits.editZoneDimensions).toHaveBeenLastCalledWith('z-rect', { widthM: 6 })
  })

  it('toggles canvas-only zone dimensions visibility from the zone inspector', async () => {
    await mountWithSelection([{ kind: 'zone', id: 'z-rect' }])
    const toggle = container.querySelector<HTMLInputElement>('#inspector-zone-dimensions-visible')!
    expect(toggle.checked).toBe(true)
    await act(() => toggle.click())
    expect(zoneDimensionsVisible.value).toBe(false)
    await act(() => toggle.click())
    expect(zoneDimensionsVisible.value).toBe(true)
  })

  it('bulk replaces species across multi-selected plants in one transaction and handles sparse catalog entries', async () => {
    const searchSpy = vi.fn().mockResolvedValue([
      {
        canonical_name: 'Castanea sativa',
        slug: 'castanea-sativa',
        common_name: 'Sweet chestnut',
        common_name_2: null,
        matched_common_name: null,
        is_name_fallback: false,
        family: null,
        genus: null,
        height_max_m: null,
        hardiness_zone_min: null,
        hardiness_zone_max: null,
        growth_rate: null,
        stratum: null,
        habit: null,
        climate_zones: [],
        life_cycles: [],
        edibility_rating: null,
        medicinal_rating: null,
        width_max_m: null,
        is_favorite: false,
      },
    ])
    installSpeciesCatalogWorkbench({ searchCloseMatches: searchSpy } as unknown as SpeciesCatalogWorkbench)
    const scene = makePersistedScene()
    scene.plants.push({ ...scene.plants[0]!, id: 'p-2', position: { x: 5, y: 5 } })
    await mountWithSelection([{ kind: 'plant', id: 'p-1' }, { kind: 'plant', id: 'p-2' }], scene)

    const searchInput = container.querySelector<HTMLInputElement>('#inspector-replace-species-search')!
    await act(async () => {
      searchInput.value = 'castanea'
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(searchSpy).toHaveBeenCalledWith('castanea', 8)

    const option = container.querySelector<HTMLButtonElement>('[data-replace-species-option="Castanea sativa"]')!
    expect(option).not.toBeNull()
    await act(() => option.click())

    const submit = container.querySelector<HTMLButtonElement>('#inspector-replace-species-submit')!
    expect(submit.disabled).toBe(false)
    await act(() => submit.click())

    expect(edits.replacePlantsSpecies).toHaveBeenCalledTimes(1)
    expect(edits.replacePlantsSpecies).toHaveBeenCalledWith(['p-1', 'p-2'], {
      canonicalName: 'Castanea sativa',
      commonName: 'Sweet chestnut',
      canopySpreadM: null,
      adoptSpeciesSpread: false,
    })
  })
})
