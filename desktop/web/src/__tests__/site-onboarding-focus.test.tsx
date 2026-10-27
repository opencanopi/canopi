// @vitest-environment jsdom

// canopi-f47t.6.1 (canopi-28w8 part 3): the Start card takes focus through the focus owner, and only when the user's own
// answer to "Where is your site?" opened it, never when the chrome mounts again over a card that was already open.
import type { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const onboarding = vi.hoisted(() => ({
  locateOpen: null as unknown as ReturnType<typeof signal<boolean>>,
  cardOpen: null as unknown as ReturnType<typeof signal<boolean>>,
}))

vi.mock('../app/site-onboarding/state', async () => {
  const { signal: makeSignal } = await import('@preact/signals')
  onboarding.locateOpen = makeSignal(false)
  onboarding.cardOpen = makeSignal(false)
  return {
    siteLocateOpen: onboarding.locateOpen,
    startDesignCardOpen: onboarding.cardOpen,
    foundSiteLabel: makeSignal(null),
    finishSiteLocate: () => {
      onboarding.locateOpen.value = false
      onboarding.cardOpen.value = true
    },
    closeStartDesignCard: () => { onboarding.cardOpen.value = false },
    searchSiteAgain: () => {
      onboarding.cardOpen.value = false
      onboarding.locateOpen.value = true
    },
  }
})

// The place search plays no part in focus here.
vi.mock('../components/canvas/PlaceSearch', () => ({ PlaceCombobox: () => null }))

import { SiteOnboarding } from '../components/canvas/SiteOnboarding'
import { t } from '../i18n'
import { beforePaint, holdAfterPaint } from './support/before-paint'

describe('the Start card takes focus through the focus owner', () => {
  let container: HTMLDivElement
  let panelButton: HTMLButtonElement

  beforeEach(() => {
    container = document.createElement('div')
    panelButton = document.createElement('button')
    panelButton.textContent = 'Favorites'
    document.body.append(container, panelButton)
  })

  afterEach(async () => {
    await act(async () => { render(null, container) })
    onboarding.locateOpen.value = false
    onboarding.cardOpen.value = false
    document.body.innerHTML = ''
  })

  function primary(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-start-primary]')
  }

  // canopi-f47t.52.228.20: the card took focus after paint (Preact 11 useEffect), so as it first showed focus sat on the
  // page, where the Skip that opened it had been.
  it('canopi-f47t.52.228.20: the Start card the user opened has focus as it first shows', async () => {
    onboarding.locateOpen.value = true
    await act(async () => { render(<SiteOnboarding />, container) })
    const release = holdAfterPaint()
    try {
      ;[...container.querySelectorAll('button')].find((button) => button.textContent === t('siteOnboarding.skip'))!.click()
      await beforePaint()
      expect(primary()).not.toBeNull()
      expect(document.activeElement, 'the card has focus as it first shows').toBe(primary())
    } finally {
      release()
    }
  })

  it('the Start card takes focus only when the user opened it', async () => {
    // The user answers "Where is your site?" with Skip: the card opens on its first step.
    onboarding.locateOpen.value = true
    await act(async () => { render(<SiteOnboarding />, container) })
    const skip = [...container.querySelectorAll('button')].find((button) => button.textContent === t('siteOnboarding.skip'))!
    await act(async () => { skip.click() })
    expect(primary()).not.toBeNull()
    expect(document.activeElement).toBe(primary())

    // The chrome mounts again over the open card (back from another panel, a story ended): focus stays where it is.
    await act(async () => { render(null, container) })
    panelButton.focus()
    await act(async () => { render(<SiteOnboarding />, container) })
    expect(primary()).not.toBeNull()
    expect(document.activeElement).toBe(panelButton)
  })
})
