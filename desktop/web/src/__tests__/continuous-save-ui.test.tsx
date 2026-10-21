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
    // P3-2: the reason is the dialog's accessible description, heard before its buttons.
    expect(describedBy(details), 'the failure reason describes the dialog').toContain('No space left on device')
    expect(describedBy(details)).toContain('Your work is safe in Canopi while it stays open.')
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

  it('Q194: a Draft the browser may clear shows a muted warning with an alert icon, and keeps its link', async () => {
    const run = vi.fn()
    await act(async () => {
      render(label({
        status: 'draft',
        draftLabel: 'Saved in this browser',
        draftAction: { label: 'Download a copy', style: 'link', run },
        draftWarning: { label: 'May be cleared by this browser', details: 'Why it may be cleared.' },
      }), container)
    })
    const warning = container.querySelector<HTMLElement>('[data-draft-warning]')!
    expect(warning.textContent).toBe('May be cleared by this browser')
    expect(warning.querySelector('svg')).not.toBeNull()
    expect(warning.closest('[role="status"]'), 'the warning is announced politely').not.toBeNull()
    expect(container.querySelector('[role="alert"]'), 'red stays the write-failure signal').toBeNull()
    expect(labels()).toEqual(['May be cleared by this browser', 'Download a copy'])
  })

  it('2.1-Q198: the warning opens a popover with the reason, Keep my Drafts and Download a copy; focus goes in and comes back', async () => {
    const download = vi.fn()
    const keep = vi.fn()
    const hide = vi.fn()
    const whileShown = vi.fn(() => hide)
    await act(async () => {
      render(label({
        status: 'draft',
        draftLabel: 'Saved in this browser',
        draftAction: { label: 'Download a copy', style: 'link', run: download },
        draftWarning: {
          label: 'May be cleared by this browser',
          details: 'Canopi asks this browser to keep your Drafts.',
          detailsId: 'draft-persistence-reason',
          keep: { label: 'Keep my Drafts', run: keep },
          whileShown,
        },
      }), container)
    })
    const trigger = container.querySelector<HTMLButtonElement>('button[data-draft-warning]')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { trigger.click() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.querySelector('[data-notice="draft-persistence-reason"]')?.textContent).toBe('Canopi asks this browser to keep your Drafts.')
    expect(describedBy(dialog), 'P3-2: the reason is the dialog\'s accessible description').toBe('Canopi asks this browser to keep your Drafts.')
    expect(Array.from(dialog.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Download a copy', 'Keep my Drafts'])
    expect(document.activeElement?.textContent, 'focus moves into the popover').toBe('Download a copy')
    expect(whileShown).toHaveBeenCalledOnce()

    // Escape closes and returns focus to the warning.
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(hide).toHaveBeenCalledOnce()

    // Keep my Drafts asks in its click, then closes back to the warning.
    await act(async () => { trigger.click() })
    const keepButton = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === 'Keep my Drafts')!
    await act(async () => { keepButton.click() })
    expect(keep).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('2.1-Q198: once asked, or refused, the popover offers only Download a copy, with the warning details', async () => {
    const download = vi.fn()
    await act(async () => {
      render(label({
        status: 'draft',
        draftLabel: 'Saved in this browser',
        draftAction: { label: 'Download a copy', style: 'link', run: download },
        draftWarning: { label: 'May be cleared by this browser', details: 'This browser may clear your Drafts.' },
      }), container)
    })
    await act(async () => { container.querySelector<HTMLButtonElement>('button[data-draft-warning]')!.click() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('This browser may clear your Drafts.')
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['Download a copy'])
    await act(async () => { buttons[0]!.click() })
    expect(download).toHaveBeenCalledOnce()
  })

  // canopi-eon8.15 (S5): a keyboard user who tabs out of the warning's popover (on to New version: Reload) leaves it
  // closed, and a save problem dialog never sits over an open popover.
  it('canopi-eon8.15: the warning popover closes when focus leaves it and when a save problem asks', async () => {
    const warningProps = label({
      status: 'draft',
      draftLabel: 'Saved in this browser',
      draftAction: { label: 'Download a copy', style: 'link', run: vi.fn() },
      draftWarning: { label: 'May be cleared by this browser', details: 'Why.', keep: { label: 'Keep my Drafts', run: vi.fn() } },
    })
    await act(async () => { render(<>{warningProps}<button type="button" data-outside>Reload</button></>, container) })
    const trigger = container.querySelector<HTMLButtonElement>('button[data-draft-warning]')!
    const outside = container.querySelector<HTMLButtonElement>('[data-outside]')!

    await act(async () => { trigger.click() })
    const keep = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).at(-1)!
    // Tab within the popover keeps it open.
    await act(async () => { keep.focus() })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    // Back to its own warning keeps it open too (Shift+Tab from the first button).
    await act(async () => { trigger.focus() })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { keep.focus() })
    await act(async () => { outside.focus() })
    expect(container.querySelector('[role="dialog"]'), 'focus left: the popover closed').toBeNull()
    expect(document.activeElement, 'closing leaves focus where the user went').toBe(outside)

    await act(async () => { trigger.click() })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { void requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'reload', conflict: false }) })
    expect(container.querySelector('[role="dialog"]'), 'the save problem closes the popover').toBeNull()
  })

  it('canopi-eon8.15: the Details… popover closes when focus leaves it', async () => {
    await act(async () => {
      render(<>{label({ status: 'error', failureReason: 'No space left on device' })}<button type="button" data-outside>Reload</button></>, container)
    })
    const details = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Details…')!
    await act(async () => { details.click() })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-outside]')!.focus() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('L18: a failed write wins over the may-be-cleared warning', async () => {
    await act(async () => {
      render(label({ status: 'error', draftWarning: { label: 'May be cleared by this browser', details: 'Why.' } }), container)
    })
    expect(container.querySelector('[data-draft-warning]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t save')
  })

  it('L17: Desktop passes no warning, so its Draft status renders as before', async () => {
    await act(async () => { render(label({ status: 'draft' }), container) })
    expect(container.querySelector('[data-draft-warning]')).toBeNull()
    expect(container.textContent).toBe('DraftSave as…')
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

  it('canopi-eon8.14.1: offers Retry, Close anyway and Cancel when settings cannot be saved, and Escape keeps the window open', async () => {
    let decision: Promise<string> | null = null
    await act(async () => {
      render(<SaveProblemDialog />, container)
      decision = requestSaveProblemDecision({ kind: 'settings-failed', designSaved: true })
    })
    const dialog = container.querySelector('[role="alertdialog"]')!
    expect(dialog.getAttribute('data-save-problem')).toBe('settings-failed')
    expect(container.querySelector('#save-problem-title')?.textContent).toBe("Couldn't save your settings")
    expect(container.querySelector('#save-problem-message')?.textContent).toBe(
      "Your Design is saved. Canopi couldn't save your latest settings changes. Try again, or close anyway and lose them.",
    )
    expect(labels()).toEqual(['Retry', 'Close anyway', 'Cancel'])
    expect(document.activeElement?.textContent).toBe('Retry')

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(decision).resolves.toBe('cancel')
  })

  it('canopi-eon8.14.1: the settings dialog never claims a Design closed without saving is saved', async () => {
    await act(async () => {
      render(<SaveProblemDialog />, container)
      void requestSaveProblemDecision({ kind: 'settings-failed', designSaved: false })
    })
    expect(container.querySelector('#save-problem-title')?.textContent).toBe("Couldn't save your settings")
    expect(container.querySelector('#save-problem-message')?.textContent).toBe(
      "Canopi couldn't save your latest settings changes. Try again, or close anyway and lose them.",
    )
    expect(labels()).toEqual(['Retry', 'Close anyway', 'Cancel'])
    await act(async () => {
      answerSaveProblem('cancel')
    })
  })

  it('canopi-eon8.14.1: Cancel on the settings dialog keeps the window open, as Escape does', async () => {
    let decision: Promise<string> | null = null
    await act(async () => {
      render(<SaveProblemDialog />, container)
      decision = requestSaveProblemDecision({ kind: 'settings-failed', designSaved: true })
    })
    const cancel = container.querySelector<HTMLButtonElement>('[data-save-problem-choice="cancel"]')
    expect(cancel?.textContent).toBe('Cancel')
    await act(async () => {
      cancel!.click()
    })
    await expect(decision).resolves.toBe('cancel')
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('cancels an older request when a newer one arrives', async () => {
    const older = requestSaveProblemDecision({ kind: 'conflict', fileGone: false })
    const newer = requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'close', conflict: false })
    await expect(older).resolves.toBe('cancel')
    answerSaveProblem('retry')
    await expect(newer).resolves.toBe('retry')
  })
})

// canopi-eon8.15 (handoff review): closing the save problem returns focus to the control that opened it, such as New
// version: Reload, even when that control was disabled (and so blurred) while it saved and is enabled again only once
// the answer has been handled.
describe('save problem dialog focus', () => {
  it('canopi-eon8.15: Cancel returns focus to the control that opened the dialog', async () => {
    await act(async () => {
      render(<><button type="button" data-opener>Reload</button><SaveProblemDialog /></>, container)
    })
    const opener = container.querySelector<HTMLButtonElement>('[data-opener]')!
    opener.focus()
    let decision!: Promise<unknown>
    await act(async () => {
      // As Reload does: the button is disabled while it saves, which blurs it in Chromium.
      opener.blur()
      opener.disabled = true
      decision = requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'reload', conflict: false })
    })
    expect(document.activeElement?.getAttribute('data-save-problem-choice'), 'focus moves into the dialog').toBe('retry')
    // Re-enabled only once the answer has been handled, after the dialog unmounts.
    void decision.then(() => { opener.disabled = false })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-save-problem-choice="cancel"]')!.click()
      await decision
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement, 'focus is back on Reload').toBe(opener)
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

/** The dialog's accessible description: the text of the elements its `aria-describedby` names (P3-2). */
function describedBy(dialog: Element): string {
  const ids = dialog.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
}
