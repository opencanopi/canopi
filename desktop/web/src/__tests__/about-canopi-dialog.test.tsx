// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  // 2.1-Q221: one code path on Desktop and Web, the shipped file from a lazy `?raw` chunk (no fetch, no command, no
  // second window). Focus moves once, as the view opens; the text arriving later moves none.
  it('Open-source notices link opens the notices view on both editions (2.1-Q221)', async () => {
    aboutCanopiDialogOpen.value = true
    await act(async () => { render(<AboutCanopiDialog />, container) })
    const link = () => [...container.querySelectorAll<HTMLElement>('button, a')]
      .find((element) => element.textContent === 'Open-source notices')
    expect(link()).toBeTruthy()
    act(() => { link()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const view = container.querySelector<HTMLElement>('[role="dialog"]')!
    const focused = document.activeElement
    expect(view.contains(focused)).toBe(true)
    await vi.waitFor(() => expect(view.textContent).toContain('GeoLibre'))
    expect(view.textContent).toContain('Third-party notices')
    expect(view.textContent).toContain('Open-source notices')
    expect(document.activeElement).toBe(focused)
    // Escape returns to About, focus on the link, the dialog still open.
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(aboutCanopiDialogOpen.value).toBe(true)
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('About Canopi')
    expect(document.activeElement).toBe(link())
    // So does the view's close button.
    act(() => { link()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const close = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Close')!
    await act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(aboutCanopiDialogOpen.value).toBe(true)
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('About Canopi')
    expect(document.activeElement).toBe(link())
  })

  it('uses the Tauri app version as About metadata', () => {
    expect(CANOPI_VERSION).toBe(readTauriConfigVersion())
  })
})
