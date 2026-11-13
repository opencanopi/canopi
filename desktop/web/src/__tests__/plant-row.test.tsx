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
import { resetStoreHealthForTests, writeStoreHealth } from '../failures/health'
import type { StoreId, StoreOpenStatus } from '../generated/contracts'
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

  // Q320 with Q111: the star is off with the same edition-neutral reason on Desktop under a newer user database as on
  // Web under newer species lists; a user database that could not open leaves the star live (its write fails visibly).
  it.each([
    ['Desktop', 'user_db', { kind: 'newer_read_only' }, 'Saved by a newer Canopi'],
    ['Desktop', 'user_db', { kind: 'refused_newer' }, 'Saved by a newer Canopi'],
    ['Desktop', 'user_db', { kind: 'unavailable', code: { kind: 'internal' } }, null],
    ['Web', 'web_species_lists', { kind: 'newer_read_only' }, 'Saved by a newer Canopi'],
    ['Web', 'web_species_lists', { kind: 'unavailable', code: { kind: 'invalid' } }, 'won’t be saved this session'],
  ] satisfies [string, StoreId, StoreOpenStatus, string | null][])('R3 canopi-f47t.52.272: on %s, the favourite star under %s %o is off with its reason, or live (2.1-Q320, Q111)', (_edition, store, status, reason) => {
    writeStoreHealth(store, { status, notice: null })
    try {
      render(<PlantRow plant={makeSpeciesListItem('Malus domestica')} />, container)
      const star = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!
      star.click()
      if (reason === null) {
        expect(star.hasAttribute('aria-disabled')).toBe(false)
        expect(plantBrowserMock.toggleFavorite).toHaveBeenCalledOnce()
      } else {
        expect(star.getAttribute('aria-disabled')).toBe('true')
        expect(document.getElementById(star.getAttribute('aria-describedby') ?? '')?.textContent).toContain(reason)
        expect(plantBrowserMock.toggleFavorite).not.toHaveBeenCalled()
      }
    } finally {
      resetStoreHealthForTests()
      plantBrowserMock.toggleFavorite.mockClear()
    }
  })
})
