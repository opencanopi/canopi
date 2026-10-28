// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultScenePersistedState, type ScenePlantEntity } from '../canvas/runtime/scene'
import { setCurrentCanvasSession } from '../canvas/session'
import { DisplayLegend } from '../components/canvas/DisplayLegend'
import { phoneLayout } from '../app/shell/phone-layout'
import { registerMapArea, registerMapOccluder, visibleMapFrame } from '../app/shell/visible-map-area'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'


describe('DisplayLegend', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
  })

  it('shows grouped pinned plant names', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = [
      plant({ id: 'plant-1', pinnedName: true, color: '#112233', symbol: 'tree' }),
      plant({ id: 'plant-2', pinnedName: true, color: '#112233', symbol: 'tree' }),
      plant({ id: 'plant-3', pinnedName: false, color: '#112233', symbol: 'tree' }),
    ]
    const query = createTestCanvasQuerySurface({
      scene,
      localizedNames: new Map([['Malus domestica', 'Pommier']]),
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: query }))

    await act(async () => {
      render(<DisplayLegend />, container)
      await Promise.resolve()
    })

    expect(container.querySelector('[data-pinned-plant-name-legend]')).not.toBeNull()
    expect(container.querySelectorAll('[data-pinned-plant-name-entry]')).toHaveLength(1)
    expect(container.textContent).toContain('Pommier')
    expect(container.querySelector('[data-pinned-plant-name-count]')?.textContent).toBe('2')
  })

  it('is not shown on a phone, where the pinned names show on the map alone', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = [plant({ id: 'plant-1', pinnedName: true, color: '#112233', symbol: 'tree' })]
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: createTestCanvasQuerySurface({ scene }) }))
    try {
      phoneLayout.value = 'landscape'
      await act(async () => { render(<DisplayLegend />, container) })
      expect(container.querySelector('[data-pinned-plant-name-legend]')).toBeNull()
      await act(async () => { phoneLayout.value = null })
      expect(container.querySelector('[data-pinned-plant-name-legend]')).not.toBeNull()
    } finally {
      phoneLayout.value = null
    }
  })

  // The Web edition's desktop layout under 761 px: an open panel is a bottom sheet over the legend's place. A legend
  // covering the left edge there would keep framing and the map notice clear of chrome no one sees.
  it('covers the map\'s left edge only while no bottom chrome spans its place', async () => {
    const boxes = new Map<Element, { left: number; top: number; width: number; height: number }>()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.hasAttribute('data-pinned-plant-name-legend')
        ? { left: 76, top: 500, width: 164, height: 136 }
        : boxes.get(this) ?? { left: 0, top: 0, width: 0, height: 0 }
      const { left, top, width, height } = box
      return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect
    })
    const area = document.createElement('div')
    const sheet = document.createElement('div')
    document.body.append(area, sheet)
    boxes.set(area, { left: 0, top: 0, width: 750, height: 700 })
    boxes.set(sheet, { left: 12, top: 252, width: 726, height: 384 })
    const scene = createDefaultScenePersistedState()
    scene.plants = [plant({ id: 'plant-1', pinnedName: true, color: '#112233', symbol: 'tree' })]
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: createTestCanvasQuerySurface({ scene }) }))
    const releaseArea = registerMapArea(area)
    try {
      await act(async () => { render(<DisplayLegend />, container) })
      const legend = () => container.querySelector('[data-pinned-plant-name-legend]')!
      expect(legend().hasAttribute('data-covers-map')).toBe(true)
      expect(visibleMapFrame.value.left).toBe(240)

      let releaseSheet = () => {}
      await act(async () => { releaseSheet = registerMapOccluder(sheet, 'bottom') })
      expect(legend().hasAttribute('data-covers-map')).toBe(false)
      expect(visibleMapFrame.value.left).toBe(0)

      await act(async () => { releaseSheet() })
      expect(legend().hasAttribute('data-covers-map')).toBe(true)
    } finally {
      render(null, container)
      releaseArea()
      vi.restoreAllMocks()
    }
  })

  it('groups pinned names by localized name, effective symbol, and color', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = [
      plant({ id: 'plant-1', pinnedName: true, color: '#112233', symbol: 'tree' }),
      plant({ id: 'plant-2', pinnedName: true, color: '#112233', symbol: 'tree' }),
      plant({ id: 'plant-3', pinnedName: true, color: '#445566', symbol: 'tree' }),
      plant({ id: 'plant-4', pinnedName: true, color: '#112233', symbol: 'shrub' }),
    ]
    const query = createTestCanvasQuerySurface({
      scene,
      localizedNames: new Map([['Malus domestica', 'Pommier']]),
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: query }))

    await act(async () => {
      render(<DisplayLegend />, container)
      await Promise.resolve()
    })

    expect(container.querySelectorAll('[data-pinned-plant-name-entry]')).toHaveLength(3)
    expect([...container.querySelectorAll('[data-pinned-plant-name-count]')].map((el) => el.textContent)).toEqual(['2'])
  })

  it('lists every pinned name of a large legend, none left out', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = Array.from({ length: 12 }, (_, index) =>
      plant({
        id: `plant-${index}`,
        canonicalName: `Species ${index}`,
        commonName: `Species ${index}`,
        pinnedName: true,
        color: `#1122${index.toString(16).padStart(2, '0')}`,
      }),
    )
    const query = createTestCanvasQuerySurface({ scene })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: query }))

    await act(async () => {
      render(<DisplayLegend />, container)
      await Promise.resolve()
    })

    expect(container.querySelectorAll('[data-pinned-plant-name-entry]')).toHaveLength(12)
  })

  it('updates pinned plant names when pins or localized names change', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = [plant({ pinnedName: false })]
    const query = createTestCanvasQuerySurface({ scene })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: query }))

    await act(async () => {
      render(<DisplayLegend />, container)
      await Promise.resolve()
    })

    expect(container.querySelector('[data-pinned-plant-name-legend]')).toBeNull()

    await act(async () => {
      scene.plants[0] = { ...scene.plants[0]!, pinnedName: true }
      query.bumpSceneRevision()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Apple')

    await act(async () => {
      query.setLocalizedNames(new Map([['Malus domestica', 'Pommier']]))
      query.bumpPlantNamesRevision()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Pommier')
    expect(container.textContent).not.toContain('Apple')
  })

  it('hides the pinned-name legend when plant layer visibility makes it inapplicable', async () => {
    const scene = createDefaultScenePersistedState()
    scene.plants = [plant({ pinnedName: true })]
    const query = createTestCanvasQuerySurface({ scene })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: query }))

    await act(async () => {
      render(<DisplayLegend />, container)
      await Promise.resolve()
    })

    expect(container.querySelector('[data-pinned-plant-name-legend]')).not.toBeNull()

    await act(async () => {
      scene.layers = scene.layers.map((layer) =>
        layer.name === 'plants' ? { ...layer, visible: false } : layer,
      )
      query.bumpSceneRevision()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-pinned-plant-name-legend]')).toBeNull()
  })
})

function plant(overrides: Partial<ScenePlantEntity> = {}): ScenePlantEntity {
  return {
    kind: 'plant',
    id: 'plant-1',
    locked: false,
    canonicalName: 'Malus domestica',
    commonName: 'Apple',
    color: null,
    symbol: null,
    pinnedName: false,
    canopySpreadM: null,
    position: { x: 0, y: 0 },
    rotationDeg: null,
    notes: null,
    plantedDate: null,
    quantity: null,
    ...overrides,
  }
}
