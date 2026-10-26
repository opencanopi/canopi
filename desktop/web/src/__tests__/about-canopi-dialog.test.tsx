// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aboutCanopiDialogOpen, closeAboutCanopiDialog } from '../app/about/state'
import { CANOPI_LICENSE, CANOPI_VERSION } from '../app/about/metadata'
import { locale } from '../app/settings/state'
import { appCommandGraphChromeProjection } from '../commands/registry'
import { AboutCanopiDialog } from '../components/shared/AboutCanopiDialog'
import tauriConfigText from '../../../tauri.conf.json?raw'

function readTauriConfigVersion(): string {
  const config = JSON.parse(tauriConfigText) as { version?: unknown }
  if (typeof config.version !== 'string') throw new Error('Missing Tauri version')
  return config.version
}

describe('AboutCanopiDialog', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    closeAboutCanopiDialog()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    closeAboutCanopiDialog()
  })

  it('opens from the Help command and shows standard app information', async () => {
    const help = appCommandGraphChromeProjection.value.menus.find((menu) => menu.id === 'help')!
    const about = help.items.find((entry) => entry.type === 'action' && entry.id === 'help.aboutCanopi')
    if (about?.type !== 'action') throw new Error('Missing About Canopi menu action')
    about.action()

    await act(async () => {
      render(<AboutCanopiDialog />, container)
      await Promise.resolve()
    })

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.textContent).toContain('About Canopi')
    expect(dialog?.textContent).toContain(`Version ${CANOPI_VERSION}`)
    expect(dialog?.textContent).toContain(CANOPI_LICENSE)
    expect(container.querySelector('img')).toBeTruthy()

    const closeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Close')
    expect(closeButton).toBeTruthy()

    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(aboutCanopiDialogOpen.value).toBe(false)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('stays open when a press inside the dialog is released on the backdrop', async () => {
    aboutCanopiDialogOpen.value = true
    await act(async () => { render(<AboutCanopiDialog />, container) })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const overlay = dialog.parentElement!
    await act(async () => {
      dialog.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      overlay.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(aboutCanopiDialogOpen.value).toBe(true)
    await act(async () => {
      overlay.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      overlay.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(aboutCanopiDialogOpen.value).toBe(false)
  })

  // The notices view (2.1-Q20, Q221) arrives with F3c-c3: one code path on Desktop and Web, a lazy `?raw` chunk.
  it.fails('Open-source notices link opens the notices view on both editions (F3c-c3, canopi-f47t.52.228.11)', async () => {
    aboutCanopiDialogOpen.value = true
    await act(async () => { render(<AboutCanopiDialog />, container) })
    const link = [...container.querySelectorAll<HTMLElement>('button, a')]
      .find((element) => element.textContent === 'Open-source notices')
    expect(link).toBeTruthy()
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const view = container.querySelector('[role="dialog"]')
    expect(view?.textContent).toContain('Third-party notices')
    expect(view?.textContent).toContain('GeoLibre')
  })

  it('uses the Tauri app version as About metadata', () => {
    expect(CANOPI_VERSION).toBe(readTauriConfigVersion())
  })
})
