// @vitest-environment jsdom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesignNotebookWorkbench } from '../../app/design-notebook'
import { DesignNotebookPanel } from './DesignNotebookPanel'

describe('DesignNotebookPanel section rename errors', () => {
  let root: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      render(null, root)
      root.remove()
      root = null
    }
  })

  it('keeps the section rename field open with a translated error and styled alert when renameSection rejects (#924 T-2)', async () => {
    const renameAdapter = vi.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked'))
    const noop = vi.fn()
    const workbench = createDesignNotebookWorkbench({
      loadNotebook: async () => ({
        entries: [],
        sections: [{ id: 'sec-orchard', name: 'Orchard', sort_order: 0, created_at: '', updated_at: '' }],
      }),
      renameSection: renameAdapter,
      openDesign: noop,
      createSection: noop,
      deleteSection: noop,
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    await act(async () => { render(<DesignNotebookPanel workbench={workbench} />, root!) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    await act(async () => {
      root!.querySelector<HTMLElement>('[data-notebook-section-id="sec-orchard"] h3')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    const input = root.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!
    await act(async () => {
      input.value = '  North\tOrchard  '
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(renameAdapter).toHaveBeenCalledWith('sec-orchard', 'North Orchard')
    const reopened = root.querySelector<HTMLInputElement>('input[aria-label="Section name"]')
    expect(reopened?.value).toBe('  North\tOrchard  ')
    const alert = root.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toBe("Canopi couldn't rename this section. Try again.")
    expect(alert?.textContent).not.toContain('SQLITE_BUSY')
    expect(alert?.className).toBeTruthy()
  })
})
