// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerSaveProblem,
  requestSaveProblemDecision,
  saveProblem,
} from '../app/document-session/save-problem'
import { createDesignDraftsController } from '../app/design-drafts'
import { locale } from '../app/settings/state'
import { StartScreen, type StartScreenDraft } from '../components/shared/StartScreen'
import { SaveProblemDialog } from '../components/shared/SaveProblemDialog'
import { CommandPalette } from '../components/shared/CommandPalette'
import { commandPaletteOpen } from '../commands/registry'
import { SaveStatusLabel } from '../components/shared/SaveStatusLabel'
import { createDesignSessionStore } from '../app/document-session/store'
import { createBrowserAppDataStore } from '../web/browser-app-data'
import { createBrowserDesignSessionController } from '../web/browser-design-session'
import { WebWelcomeScreen } from '../web/WebWelcomeScreen'
import type { CanopiFile } from '../types/design'

let container: HTMLDivElement

beforeEach(() => {
  locale.value = 'en'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  answerSaveProblem('cancel')
  render(null, container)
  container.remove()
})

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

function labels(): string[] {
  return buttons().map((button) => button.textContent ?? '')
}

describe('SaveStatusLabel', () => {
  const draftAction = { label: 'Save as…', style: 'button' as const, run: vi.fn() }
  const saveElsewhere = { label: 'Save as…', run: vi.fn() }
  const label = (props: Partial<Parameters<typeof SaveStatusLabel>[0]> & Pick<Parameters<typeof SaveStatusLabel>[0], 'status'>) => (
    <SaveStatusLabel draftLabel="Draft" draftAction={draftAction} saveElsewhere={saveElsewhere} onRetry={vi.fn()} {...props} />
  )

  it('shows quiet saving and saved text, and never announces Saving', async () => {
    await act(async () => { render(label({ status: 'saving' }), container) })
    expect(container.textContent).toBe('Saving…')
    expect(container.querySelector('span[aria-hidden="true"]')?.textContent).toBe('Saving…')
    expect(buttons()).toHaveLength(0)

    await act(async () => { render(label({ status: 'saved' }), container) })
    expect(container.textContent).toBe('Saved')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved')
  })

  it('shows a Draft with its one action, Save as…', async () => {
    const run = vi.fn()
    await act(async () => {
      render(label({ status: 'draft', draftAction: { label: 'Save as…', style: 'button', run } }), container)
    })
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Draft')
    expect(labels()).toEqual(['Save as…'])
    buttons()[0]!.click()
    expect(run).toHaveBeenCalledOnce()
  })

  it('explains a failed save in Details… with the reason, Retry and Save as…', async () => {
    const onRetry = vi.fn()
    const saveAs = vi.fn()
    await act(async () => {
      render(label({ status: 'error', failureReason: 'No space left on device', onRetry, saveElsewhere: { label: 'Save as…', run: saveAs } }), container)
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t save')
    expect(labels()).toEqual(['Details…'])

    await act(async () => { buttons()[0]!.click() })
    const details = container.querySelector('[role="dialog"]')!
    expect(details.textContent).toContain('Couldn’t save your latest changes')
    expect(details.textContent).toContain('No space left on device')
    expect(details.textContent).toContain('Your work is safe in Canopi while it stays open.')
    expect(labels()).toEqual(['Details…', 'Save as…', 'Retry'])
    expect(document.activeElement?.textContent).toBe('Save as…')

    await act(async () => { buttons()[2]!.click() })
    expect(onRetry).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => { buttons()[0]!.click() })
    await act(async () => {
      container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement?.textContent).toBe('Details…')
    expect(saveAs).not.toHaveBeenCalled()
  })

  it('offers Resolve… for a file changed outside Canopi', async () => {
    const onResolveConflict = vi.fn()
    await act(async () => { render(label({ status: 'conflict', onResolveConflict }), container) })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Changed outside Canopi')
    expect(labels()).toEqual(['Resolve…'])
    buttons()[0]!.click()
    expect(onResolveConflict).toHaveBeenCalledOnce()
  })

  it('says a browser Draft was changed in another tab', async () => {
    const onResolveConflict = vi.fn()
    await act(async () => { render(label({ status: 'conflict', conflictSource: 'another-tab', onResolveConflict }), container) })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Changed in another tab')
    expect(labels()).toEqual(['Resolve…'])
  })

  it('shows "Saved in this browser" with a Download a copy link on the Web', async () => {
    const run = vi.fn()
    await act(async () => {
      render(label({ status: 'draft', draftLabel: 'Saved in this browser', draftAction: { label: 'Download a copy', style: 'link', run } }), container)
    })
    expect(container.textContent).toBe('Saved in this browserDownload a copy')
    buttons()[0]!.click()
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('SaveProblemDialog', () => {
  it('asks Retry, Discard changes or Cancel when a replacement cannot write first', async () => {
    await act(async () => {
      render(<SaveProblemDialog />, container)
    })
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()

    let decision: Promise<string> | null = null
    await act(async () => {
      decision = requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'replace', conflict: false })
    })
    expect(container.textContent).toContain("Couldn't save your changes")
    expect(labels()).toEqual(['Retry', 'Discard changes', 'Cancel'])
    expect(document.activeElement?.textContent).toBe('Retry')

    await act(async () => {
      buttons()[1]?.click()
    })
    await expect(decision).resolves.toBe('discard')
    expect(saveProblem.value).toBeNull()
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('names closing without saving, and hides Retry while a conflict is pending', async () => {
    await act(async () => {
      render(<SaveProblemDialog />, container)
      void requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'close', conflict: false })
    })
    expect(labels()).toEqual(['Retry', 'Close without saving', 'Cancel'])

    await act(async () => {
      void requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'replace', conflict: true })
    })
    expect(labels()).toEqual(['Cancel', 'Discard changes'])
    expect(container.textContent).toContain('changed outside Canopi')
  })

  it('offers every conflict resolution and cancels on Escape', async () => {
    let decision: Promise<string> | null = null
    await act(async () => {
      render(<SaveProblemDialog />, container)
      decision = requestSaveProblemDecision({ kind: 'conflict', fileGone: false })
    })
    expect(container.textContent).toContain('Changed outside Canopi')
    expect(labels()).toEqual([
      'Keep my version',
      "Use the file's version",
      'Save mine as a copy…',
      'Cancel',
    ])

    await act(async () => {
      container.querySelector('[role="alertdialog"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    await expect(decision).resolves.toBe('cancel')
  })

  it('offers keeping this tab\'s version or the other tab\'s for a browser Draft', async () => {
    let decision: Promise<string> | null = null
    await act(async () => {
      render(<SaveProblemDialog />, container)
      decision = requestSaveProblemDecision({ kind: 'conflict', fileGone: false, where: 'another-tab' })
    })
    expect(container.textContent).toContain('Changed in another tab')
    expect(container.textContent).toContain('Another browser tab changed this Design')
    expect(labels()).toEqual(['Keep my version', "Use the other tab's version", 'Cancel'])
    await act(async () => { buttons()[1]?.click() })
    await expect(decision).resolves.toBe('use-file')

    await act(async () => {
      void requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'replace', conflict: true, where: 'another-tab' })
    })
    expect(container.textContent).toContain('another browser tab')
    expect(labels()).toEqual(['Cancel', 'Discard changes'])
  })

  it('offers Save As or recreating the file when it was moved or deleted', async () => {
    let decision: Promise<string> | null = null
    await act(async () => {
      render(<SaveProblemDialog />, container)
      decision = requestSaveProblemDecision({ kind: 'conflict', fileGone: true })
    })
    expect(container.textContent).toContain('File moved or deleted')
    expect(labels()).toEqual(['Save as…', 'Keep my version', 'Cancel'])
    await act(async () => {
      buttons()[1]?.click()
    })
    await expect(decision).resolves.toBe('keep-mine')
  })

  it('keeps focus inside the dialog: Tab wraps and a backdrop press does not take focus away', async () => {
    await act(async () => {
      render(<SaveProblemDialog />, container)
    })
    await act(async () => {
      void requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'replace', conflict: false })
    })
    const [retry, , cancel] = buttons()
    expect(document.activeElement).toBe(retry)

    cancel!.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    cancel!.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(retry)

    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    retry!.dispatchEvent(shiftTab)
    expect(document.activeElement).toBe(cancel)

    const overlay = container.querySelector('[data-save-problem-overlay]')!
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    overlay.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
  })

  // Probe (canopi-eon8.14.1): a further request kind renders through the same
  // title, message and footer; today it falls through to the conflict copy.
  it.fails('canopi-eon8.14.1: offers Retry and Close anyway when settings cannot be saved, and Escape keeps the window open', async () => {
    let decision: Promise<string> | null = null
    await act(async () => {
      render(<SaveProblemDialog />, container)
      decision = requestSaveProblemDecision({ kind: 'settings-failed' } as never)
    })
    const dialog = container.querySelector('[role="alertdialog"]')!
    expect(dialog.getAttribute('data-save-problem')).toBe('settings-failed')
    expect(container.querySelector('#save-problem-title')?.textContent).toBe("Couldn't save your settings")
    expect(container.querySelector('#save-problem-message')?.textContent).toBe(
      "Your Design is saved. Canopi couldn't save your latest settings changes. Try again, or close anyway and lose them.",
    )
    expect(labels()).toEqual(['Retry', 'Close anyway'])
    expect(document.activeElement?.textContent).toBe('Retry')

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(decision).resolves.toBe('cancel')
  })

  it('cancels an older request when a newer one arrives', async () => {
    const older = requestSaveProblemDecision({ kind: 'conflict', fileGone: false })
    const newer = requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'close', conflict: false })
    await expect(older).resolves.toBe('cancel')
    answerSaveProblem('retry')
    await expect(newer).resolves.toBe('retry')
  })
})

describe('save dialog modality', () => {
  it('hides the command palette while the save dialog asks', async () => {
    commandPaletteOpen.value = true
    await act(async () => {
      render(<><CommandPalette /><SaveProblemDialog /></>, container)
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()

    let decision!: Promise<unknown>
    await act(async () => {
      decision = requestSaveProblemDecision({ kind: 'revert' })
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull()

    await act(async () => {
      answerSaveProblem('cancel')
      await decision
    })
    commandPaletteOpen.value = false
  })
})

describe('StartScreen', () => {
  const action = { label: 'New Design', run: vi.fn() }
  const renderStart = (drafts: StartScreenDraft[], recent: Parameters<typeof StartScreen>[0]['recent'] = null) =>
    render(
      <StartScreen newDesign={action} openDesign={{ label: 'Open Design…', run: vi.fn() }} links={[]} footer="" recent={recent} drafts={drafts} />,
      container,
    )

  function draft(id: string, name: string, overrides: Partial<StartScreenDraft> = {}): StartScreenDraft {
    return { id, name, updatedAt: new Date().toISOString(), open: vi.fn(), delete: vi.fn(), ...overrides }
  }

  it('lists recent Designs as buttons with their date', async () => {
    const open = vi.fn()
    await act(async () => {
      renderStart([], [{ id: '/d/a.canopi', name: 'Orchard', updatedAt: new Date().toISOString(), open, showInFolder: vi.fn(), remove: vi.fn() }])
    })
    expect(container.textContent).toContain('Recent Designs')
    const row = buttons().find((button) => button.textContent?.includes('Orchard'))!
    expect(row.textContent).toMatch(/Today, /)
    row.click()
    expect(open).toHaveBeenCalledOnce()
  })

  it('searches Designs and Drafts, ignoring accents and case', async () => {
    await act(async () => {
      renderStart([draft('d1', 'Haie fruitière'), draft('d2', 'Mare')])
    })
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      search.value = 'FRUITIERE'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('Haie fruitière')
    expect(container.textContent).not.toContain('Mare')
    await act(async () => {
      search.value = 'zzz'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[role="status"]')?.textContent).toBe('No Designs match “zzz”.')
  })

  it('offers Show in folder and Remove from list in a recent Design\'s More menu', async () => {
    const showInFolder = vi.fn()
    const remove = vi.fn()
    const open = vi.fn()
    await act(async () => {
      renderStart([], [{ id: '/d/a.canopi', name: 'Orchard', updatedAt: new Date().toISOString(), open, showInFolder, remove }])
    })
    const choose = async (label: string) => {
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="More actions for Orchard"]')!.click() })
      await act(async () => {
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
          .find((item) => item.textContent === label)!.click()
      })
    }
    await choose('Show in folder')
    expect(showInFolder).toHaveBeenCalledOnce()
    await choose('Remove from list')
    expect(remove).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens a draft and deletes one only after an inline confirmation that names it', async () => {
    const orchard = draft('draft-b', 'Orchard')
    const untitled = draft('draft-a', 'Untitled')
    await act(async () => { renderStart([untitled, orchard]) })
    expect(container.textContent).toContain('Drafts')
    expect(container.textContent).toContain('Untitled Design')
    expect(container.textContent).toContain('Draft, never saved to a file')

    await act(async () => { buttons().find((button) => button.textContent?.includes('Untitled Design'))!.click() })
    expect(untitled.open).toHaveBeenCalledOnce()

    const openDeleteConfirmation = async () => {
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Orchard"]')!.click() })
      await act(async () => {
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
          .find((item) => item.textContent === 'Delete draft…')!.click()
      })
    }
    await openDeleteConfirmation()
    expect(orchard.delete).not.toHaveBeenCalled()
    const confirmation = container.querySelector('[role="alertdialog"]')!
    expect(confirmation.textContent).toContain('Delete “Orchard”? It was never saved to a file and can’t be recovered.')

    await act(async () => { buttons().find((button) => button.textContent === 'Cancel')!.click() })
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()

    await openDeleteConfirmation()
    await act(async () => { buttons().find((button) => button.textContent === 'Delete draft')!.click() })
    expect(orchard.delete).toHaveBeenCalledOnce()
    expect(untitled.delete).not.toHaveBeenCalled()
  })
})

describe('Design Drafts controller', () => {
  it('lists drafts and drops a deleted one', async () => {
    const listDrafts = vi.fn(async () => [
      { id: 'a', name: 'A', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'b', name: 'B', updated_at: '2026-01-02T00:00:00.000Z' },
    ])
    const deleteDraft = vi.fn(async () => undefined)
    const controller = createDesignDraftsController({ listDrafts, deleteDraft })

    await controller.load()
    expect(controller.drafts.value.map((draft) => draft.id)).toEqual(['a', 'b'])

    await controller.remove('a')
    expect(deleteDraft).toHaveBeenCalledWith('a')
    expect(controller.drafts.value.map((draft) => draft.id)).toEqual(['b'])
    controller.dispose()
  })

  it('shows no drafts when listing fails', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = createDesignDraftsController({
      listDrafts: vi.fn(async () => {
        throw new Error('app data unavailable')
      }),
    })
    await controller.load()
    expect(controller.drafts.value).toEqual([])
    logError.mockRestore()
  })
})

describe('WebWelcomeScreen', () => {
  it('lists browser Drafts, opens one and deletes another', async () => {
    const values = new Map<string, string>()
    const appDataStore = createBrowserAppDataStore({
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value) },
        removeItem: (key) => { values.delete(key) },
      },
    })
    for (const name of ['Kitchen Garden', 'Hedge']) {
      appDataStore.saveDraft({ id: `draft-${name}`, file: design(name), now: '2026-01-01T00:00:00.000Z' })
    }
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({ store, appDataStore })

    await act(async () => {
      render(<WebWelcomeScreen controller={controller} />, container)
    })
    expect(container.textContent).toContain('Kitchen Garden')
    expect(container.textContent).toContain('Hedge')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Kitchen Garden"]')?.click()
    })
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((item) => item.textContent === 'Delete draft…')?.click()
    })
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Delete draft')?.click()
    })
    expect(container.textContent).not.toContain('Kitchen Garden')
    expect(appDataStore.listDrafts().map((draft) => draft.id)).toEqual(['draft-Hedge'])

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('li button'))
        .find((button) => button.textContent?.includes('Hedge'))?.click()
    })
    expect(store.readDesignName()).toBe('Hedge')
  })
})

function design(name: string): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}
