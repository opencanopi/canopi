// @vitest-environment jsdom

import i18n from 'i18next'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { plantDbStatus } from '../app/health/state'
import { locale } from '../app/settings/state'
import { commandPaletteOpen } from '../commands/registry'
import { CommandPalette } from '../components/shared/CommandPalette'
import { DegradedBanner } from '../components/shared/DegradedBanner'
import { t } from '../i18n'

describe('application translation authority', () => {
  let container: HTMLDivElement

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    locale.value = 'en'
    await i18n.changeLanguage('en')
    plantDbStatus.value = 'missing'
    commandPaletteOpen.value = false
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    plantDbStatus.value = 'available'
    commandPaletteOpen.value = false
    vi.restoreAllMocks()
    locale.value = 'en'
  })

  it('rerenders mounted degraded chrome when only the locale changes', async () => {
    await act(async () => {
      render(<DegradedBanner />, container)
    })

    expect(container.textContent).toContain("The plant catalog's database file is missing")

    await act(async () => {
      locale.value = 'fr'
    })

    expect(container.textContent).toContain('Le fichier de base de données du catalogue des plantes est introuvable')
  })

  it('pins interpolation, count, and fallback reads to the observed locale synchronously', () => {
    const pendingLanguageChange = new Promise<never>(() => {})
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage')
      .mockImplementation(() => pendingLanguageChange)

    locale.value = 'fr'

    expect(changeLanguage).toHaveBeenCalledWith('fr')
    expect(t('plantDb.placeSpecies', { name: 'Poirier' })).toBe('Placer Poirier')
    expect(t('plantFinder.plants', { count: 4 })).toBe('4 plantes')
    // @ts-expect-error a key English lacks, so the fallback is read
    expect(t('missing.test.key', { defaultValue: 'Fallback label' })).toBe('Fallback label')
  })

  it('updates an open command palette and its command labels when only locale changes', async () => {
    commandPaletteOpen.value = true
    await act(async () => {
      render(<CommandPalette />, container)
    })

    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label'))
      .toBe('Command palette')
    expect(container.textContent).toContain('New Design')
    const shortcutOf = (id: string) => container.querySelector(`[id="cmd-${id}"] span:last-child`)?.textContent
    expect(shortcutOf('file.saveAs')).toBe('Ctrl Shift S')

    await act(async () => {
      locale.value = 'fr'
    })

    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label'))
      .toBe('Palette de commandes')
    expect(container.textContent).toContain('Nouveau Design')
    // Shell shortcuts are read when shown, like canvas ones: "Maj" in French.
    expect(shortcutOf('file.saveAs')).toBe('Ctrl Maj S')
  })
})
