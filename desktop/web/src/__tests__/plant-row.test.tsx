// @vitest-environment jsdom

import { render } from 'preact'
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const plantBrowserMock = vi.hoisted(() => ({
  intent: { value: { text: '' } },
  selectSpecies: vi.fn(),
  toggleFavorite: vi.fn(),
  isActiveSearchText: vi.fn((text: string) => text.trim().length > 1),
}))

vi.mock('../app/plant-browser', () => ({
  speciesCatalogWorkbench: plantBrowserMock,
}))

vi.mock('../canvas/session', async (importOriginal) => ({
  ...await importOriginal<typeof CanvasSessionModule>(),
  currentCanvasToolCommandSurface: signal(null),
}))

import { locale } from '../app/settings/state'
import { PlantRow } from '../components/plant-db/PlantRow'
import { makeSpeciesListItem } from './support/species-catalog-workbench'
import type * as CanvasSessionModule from '../canvas/session'

describe('PlantRow', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    plantBrowserMock.intent.value = { text: '' }
    plantBrowserMock.isActiveSearchText.mockClear()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('shows a distinct matched Common Name during active catalog search', () => {
    plantBrowserMock.intent.value = { text: 'melis' }
    const plant = {
      ...makeSpeciesListItem('Moluccella laevis'),
      common_name: "Clochette d'Irlande",
      common_name_2: 'Moluque verte',
      matched_common_name: 'Mélisse des Moluques',
    }

    render(<PlantRow plant={plant} />, container)

    expect(container.textContent).toContain("Clochette d'Irlande")
    expect(container.textContent).toContain('Mélisse des Moluques')
    expect(container.textContent).not.toContain('Moluque verte')
  })
})
