import { beforeEach, describe, expect, it } from 'vitest'
import { activePanel, navigateTo, selectPanel, sidePanel } from '../app/shell/state'

beforeEach(() => {
  activePanel.value = 'canvas'
  sidePanel.value = null
})

describe('app navigation', () => {
  it('uses one dock for Species key, Layers and the existing library panels', () => {
    navigateTo('species-key')
    expect(sidePanel.value).toBe('species-key')
    navigateTo('layers')
    expect(sidePanel.value).toBe('layers')
    expect(activePanel.value).toBe('canvas')
    navigateTo('plant-db')
    expect(sidePanel.value).toBe('plant-db')
    navigateTo('layers')
    navigateTo('layers')
    expect(sidePanel.value).toBe(null)
  })

  it('opens the Species Catalog Workbench as a sidebar panel', () => {
    navigateTo('plant-db')

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')
  })

  it('switches between the surviving sidebar panels', () => {
    navigateTo('plant-db')
    navigateTo('favorites')

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('favorites')
  })

  it('opens the Design Notebook as an app-level sidebar panel', () => {
    navigateTo('design-notebook')

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('design-notebook')
  })

  it('returns to the canvas-only layout when navigating home', () => {
    navigateTo('favorites')
    navigateTo('canvas')

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
  })

  it('selects a sidebar panel idempotently for route-like callers', () => {
    selectPanel('calendar')
    selectPanel('calendar')

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('calendar')

    selectPanel('canvas')
    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
  })
})
