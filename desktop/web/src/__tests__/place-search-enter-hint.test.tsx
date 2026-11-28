// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => vi.fn(async () => [] as unknown))
import { installEditionPorts } from '../platform/edition-ports'
import { createTestEditionPorts } from './support/test-edition-ports'
let disposePorts: (() => void) | null = null

import { resetPlaceSearchPacingForTests } from '../app/geocoding/place-search'
import { placeSearch } from '../app/geocoding/place-search-session'
import { locale } from '../app/settings/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { PlaceSearchField } from '../components/canvas/PlaceSearch'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Place search Enter hint', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    disposePorts = installEditionPorts(createTestEditionPorts({ geocoding: transport }))
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ viewport: { showPlace: vi.fn(() => true) } }),
    }))
  })

  afterEach(() => {
    disposePorts?.(); disposePorts = null
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    placeSearch.clear()
    transport.mockReset()
    transport.mockImplementation(async () => [])
    resetPlaceSearchPacingForTests()
  })

  const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const hint = () => container.querySelector<HTMLElement>('[data-place-search-hint]')

  async function type(text: string) {
    await act(async () => {
      input().focus()
      input().value = text
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('says a place search runs on Enter while a place name waits, and describes the field with it', async () => {
    await act(async () => { render(<PlaceSearchField />, container) })
    expect(hint()).toBeNull()

    await type('Ballon')
    expect(transport).not.toHaveBeenCalled()
    expect(hint()?.textContent).toBe('Press Enter to search')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().getAttribute('aria-describedby')).toBe(hint()!.id)

    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
    })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(hint()).toBeNull()
  })

  it('shows no hint for coordinates, which go straight there', async () => {
    await act(async () => { render(<PlaceSearchField />, container) })
    await type('48.2201, 0.0351')
    expect(hint()).toBeNull()
    expect(container.textContent).toContain('Coordinates · go straight there')
  })

  it('is localized', async () => {
    locale.value = 'fr'
    await act(async () => { render(<PlaceSearchField />, container) })
    await type('Ballon')
    expect(hint()?.textContent).toBe('Appuyez sur Entrée pour rechercher')
  })
})
