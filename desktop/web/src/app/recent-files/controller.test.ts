// @vitest-environment jsdom

import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PATH = '/home/someone/designs/Orchard.canopi'

const ipc = vi.hoisted(() => ({
  reveal: (async () => {}) as (path: string) => Promise<void>,
}))

vi.mock('../../ipc/design', async (importOriginal) => ({
  ...(await importOriginal<typeof IpcDesignModule>()),
  getRecentFiles: vi.fn(async () => [{ path: '/home/someone/designs/Orchard.canopi', name: 'Orchard', updated_at: new Date().toISOString() }]),
  getRecentDesignPreviews: vi.fn(async () => []),
  listDesignDrafts: vi.fn(async () => []),
  showRecentDesignInFolder: vi.fn((path: string) => ipc.reveal(path)),
}))

import type * as IpcDesignModule from '../../ipc/design'
import { locale } from '../settings/state'
import { WelcomeScreen } from '../../components/shared/WelcomeScreen'
import { createRecentFilesController } from './controller'

describe('Show in folder on a Recent Design (canopi-zhv0, 2.1-Q227)', () => {
  it('a failed reveal raises the reveal failure, and dismissing it clears it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = createRecentFilesController({
      showRecentFileInFolder: vi.fn().mockRejectedValue(new Error(`no file manager for ${PATH}`)),
    })

    await controller.showInFolder(PATH)

    const failure = controller.revealFailure.value
    expect(failure).not.toBeNull()
    controller.dismissRevealFailure(failure!)
    expect(controller.revealFailure.value).toBeNull()
    warn.mockRestore()
  })

  it('a reveal that works raises nothing', async () => {
    const controller = createRecentFilesController({ showRecentFileInFolder: vi.fn().mockResolvedValue(undefined) })

    await controller.showInFolder(PATH)

    expect(controller.revealFailure.value).toBeNull()
  })

  it('a second failure replaces the first, so dismissing the old one keeps the new one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = createRecentFilesController({ showRecentFileInFolder: vi.fn().mockRejectedValue(new Error('no')) })

    await controller.showInFolder(PATH)
    const first = controller.revealFailure.value!
    await controller.showInFolder(PATH)
    const second = controller.revealFailure.value!
    controller.dismissRevealFailure(first)

    expect(second).not.toBe(first)
    expect(controller.revealFailure.value).toBe(second)
    warn.mockRestore()
  })

  describe('on the Start screen', () => {
    let container: HTMLDivElement

    beforeEach(() => {
      locale.value = 'en'
      container = document.createElement('div')
      document.body.appendChild(container)
    })

    afterEach(() => {
      render(null, container)
      container.remove()
      ipc.reveal = async () => {}
    })

    async function showInFolder(): Promise<void> {
      await act(async () => { render(h(WelcomeScreen, {}), container) })
      await act(async () => { await Promise.resolve() })
      const more = container.querySelector<HTMLButtonElement>('button[aria-label="More actions for Orchard"]')
      expect(more, 'the Recent Design row').not.toBeNull()
      await act(async () => { more!.click() })
      const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Show in folder"]')
      expect(item, 'the Show in folder item').not.toBeNull()
      await act(async () => { item!.click() })
      await act(async () => { await Promise.resolve() })
    }

    it('a failed reveal shows a toast that names no path', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      ipc.reveal = async (path) => { throw new Error(`no file manager could show ${path}`) }

      await showInFolder()

      const toast = document.querySelector('[role="status"]')
      expect(toast?.textContent).toContain('Can’t show this Design in its folder')
      expect(document.body.textContent).not.toContain(PATH)
      expect(document.body.textContent).not.toContain('/home/someone/designs')
      warn.mockRestore()
    })

    it('a reveal that works shows no toast', async () => {
      await showInFolder()

      expect(document.querySelector('[role="status"]')).toBeNull()
    })
  })
})
