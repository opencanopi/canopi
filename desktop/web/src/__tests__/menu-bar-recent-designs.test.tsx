// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../app/settings/state'

vi.mock('../ipc/design', async (importOriginal) => {
  const original = await importOriginal<typeof IpcDesignModule>()
  return {
    ...original,
    getRecentFiles: vi.fn(),
  }
})

vi.mock('../app/document-session/actions', async (importOriginal) => {
  const original = await importOriginal<typeof DocumentSessionActionsModule>()
  return {
    ...original,
    openDesignFromPath: vi.fn().mockResolvedValue(undefined),
  }
})

import { getRecentFiles } from '../ipc/design'
import { openDesignFromPath } from '../app/document-session/actions'
import { designNotebookWorkbench } from '../app/design-notebook'
import { TitleBar } from '../components/shared/TitleBar'
import type * as IpcDesignModule from '../ipc/design'
import type * as DocumentSessionActionsModule from '../app/document-session/actions'

describe('Title bar menu: Open recent', () => {
  let container: HTMLDivElement

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    vi.mocked(getRecentFiles).mockResolvedValue([])
    await designNotebookWorkbench.loadRecentDesigns()
    vi.mocked(getRecentFiles).mockReset()
    vi.mocked(openDesignFromPath).mockClear()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  async function renderAndOpenFileMenu(): Promise<void> {
    await act(async () => {
      render(<TitleBar />, container)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const fileTrigger = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'File')
    if (!fileTrigger) throw new Error('Missing File menu trigger')
    await act(async () => {
      fileTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('shows Open Recent as a disabled File menu item when there are no recent designs', async () => {
    vi.mocked(getRecentFiles).mockResolvedValue([])

    await renderAndOpenFileMenu()

    const openRecent = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Open recent'))
    if (!openRecent) throw new Error('Missing Open Recent item')

    expect(openRecent.getAttribute('aria-disabled')).toBe('true')
    expect(openRecent.getAttribute('aria-haspopup')).toBe('menu')
    expect(container.textContent).not.toContain('Forest Edge')
  })

  it('refreshes Open Recent when the File menu opens after mount', async () => {
    vi.mocked(getRecentFiles)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { path: '/designs/new.canopi', name: 'Newly Saved', updated_at: '2026-06-25T00:00:00.000Z' },
      ])

    await renderAndOpenFileMenu()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const openRecent = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Open recent'))
    if (!openRecent) throw new Error('Missing Open Recent item')

    expect(getRecentFiles).toHaveBeenCalledTimes(2)
    expect(openRecent.getAttribute('aria-disabled')).toBeNull()

    await act(async () => {
      openRecent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    })

    expect(container.textContent).toContain('Newly Saved')
  })

  it('opens recent designs from an Open Recent submenu capped to five entries', async () => {
    vi.mocked(getRecentFiles).mockResolvedValue([
      { path: '/designs/forest.canopi', name: 'Forest Edge', updated_at: '2026-06-20T00:00:00.000Z' },
      { path: '/designs/home.canopi', name: 'Home Guild', updated_at: '2026-06-21T00:00:00.000Z' },
      { path: '/designs/client-a.canopi', name: 'Client A', updated_at: '2026-06-22T00:00:00.000Z' },
      { path: '/designs/client-b.canopi', name: 'Client B', updated_at: '2026-06-23T00:00:00.000Z' },
      { path: '/designs/client-c.canopi', name: 'Client C', updated_at: '2026-06-24T00:00:00.000Z' },
      { path: '/designs/client-d.canopi', name: 'Client D', updated_at: '2026-06-25T00:00:00.000Z' },
    ])

    await renderAndOpenFileMenu()

    const openRecent = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Open recent'))
    if (!openRecent) throw new Error('Missing Open Recent item')

    expect(openRecent.getAttribute('aria-disabled')).toBeNull()
    expect(openRecent.getAttribute('aria-haspopup')).toBe('menu')
    expect(container.textContent).not.toContain('Forest Edge')

    await act(async () => {
      openRecent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    })

    expect(container.textContent).toContain('Forest Edge')
    expect(container.textContent).toContain('Client C')
    expect(container.textContent).not.toContain('Client D')

    await act(async () => {
      openRecent.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
    })

    expect(openRecent.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      openRecent.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    })

    // The submenu moves focus to its first item on the next frame.
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain('Forest Edge'))

    const forest = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes('Forest Edge'))
    if (!forest) throw new Error('Missing Forest Edge recent item')

    await act(async () => {
      forest.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(openDesignFromPath).toHaveBeenCalledWith('/designs/forest.canopi')
  })
})
