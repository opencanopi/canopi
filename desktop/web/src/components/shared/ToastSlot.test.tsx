// @vitest-environment jsdom
// The one window-level toast position (contracts §18 F3, 2.1-Q292): every toast draws in one layer on <body>, above the
// active dialog and outside every chrome region a modal makes inert, so an Undo stays pressable while a dialog is open.
// Stacking-order.test.ts holds the layer above the dialog layers on the z scale.
import { signal } from '@preact/signals'
import { render } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPdfWorkflow } from '../../app/canvas-pdf/workflow'
import { answerSaveProblem, requestSaveProblemDecision, saveProblem } from '../../app/document-session/save-problem'
import type { PresentedStep } from '../../app/story-presentation'
import { dismissNotice, notices, raiseNotice, resetNoticesForTests } from '../../failures/notices'
import { resetToastsForTests, showToast } from '../../failures/toasts'
import { t } from '../../i18n'
import { CanvasPdfDialog } from '../canvas-pdf/CanvasPdfDialog'
import { StoryPresenter } from '../stories/StoryPresenter'
import { NoticeRow } from './NoticeRow'
import { SaveProblemDialog } from './SaveProblemDialog'
import { SlotToast, ToastSlot } from './ToastSlot'
import { WorkspaceDialog } from './WorkspaceDialog'
import { useModalInertRegion, useModalLayer } from './useModalLayer'

vi.mock('../../app/canvas-pdf/live', () => ({ canvasPdf: null }))
// The presenter shows a step set here; leaving clears it (the real controller needs a live canvas).
const presented = vi.hoisted(() => ({ value: null as PresentedStep | null }))
vi.mock('../../app/story-presentation', async (importOriginal) => {
  const step = signal<PresentedStep | null>(null)
  Object.defineProperty(presented, 'value', { get: () => step.value, set: (next: PresentedStep | null) => { step.value = next } })
  return { ...await importOriginal<object>(), presentedStep: step, leaveStoryPresentation: () => { step.value = null } }
})

let container: HTMLDivElement
let toastHost: HTMLDivElement
const closeDialog = vi.fn()
const cleanups: Array<() => void> = []

beforeEach(() => {
  container = document.createElement('div')
  toastHost = document.createElement('div')
  document.body.append(container, toastHost)
  closeDialog.mockClear()
})

afterEach(() => {
  render(null, container)
  render(null, toastHost)
  container.remove()
  toastHost.remove()
  for (const cleanup of cleanups.splice(0)) cleanup()
  resetToastsForTests()
  resetNoticesForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function press(target: Element, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/** A panel in a chrome region a modal makes inert, owning an Undo toast. */
function PanelWithUndo({ onUndo }: { readonly onUndo: () => void }) {
  const region = useRef<HTMLDivElement>(null)
  useModalInertRegion(region)
  return (
    <div ref={region} data-panel="">
      <SlotToast message="Deleted the view" actionLabel="Undo" onAction={onUndo} onDismiss={() => {}} />
    </div>
  )
}

function Modal() {
  useModalLayer()
  return <div role="dialog" aria-modal="true">Manage views</div>
}

describe('ToastSlot', () => {
  it('canopi-f47t.52.36: toast while a modal is open: reachable and above it', async () => {
    const onUndo = vi.fn()
    await act(async () => render(<><PanelWithUndo onUndo={onUndo} /><Modal /></>, container))
    expect(container.querySelector('[data-panel]')!.hasAttribute('inert'), 'the chrome behind the dialog is inert').toBe(true)
    const undo = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Undo')!
    const layer = undo.closest('[data-toast-layer]')
    expect(layer?.parentElement, 'drawn in the window-level layer on <body>').toBe(document.body)
    expect(undo.closest('[inert]'), 'no inert region holds it').toBeNull()
    expect(container.contains(undo)).toBe(false)
    await act(async () => { undo.click() })
    expect(onUndo).toHaveBeenCalledOnce()
  })

  it('canopi-f47t.52.36: two notices queued: Import cancelled still shown as a toast, above them', async () => {
    await act(async () => render(<><NoticeRow /><ToastSlot /></>, container))
    await act(async () => {
      raiseNotice({ key: 'first', message: 'failure.internal' })
      raiseNotice({ key: 'second', message: 'failure.internal' })
      showToast({ key: 'library.import-cancelled:a', message: 'canvas.lidar.library.importCancelled' })
    })
    expect(document.querySelector('[data-toast-layer]')!.textContent).toContain(t('canvas.lidar.library.importCancelled'))
    expect(container.querySelector('[data-notice-count]')?.textContent, 'the notices still wait in the row').toBe('1 of 2')
  })

  it('a transient toast leaves by itself, and the same key raised again restarts it as one toast', async () => {
    vi.useFakeTimers()
    await act(async () => render(<ToastSlot />, container))
    const show = () => showToast({ key: 'k', message: 'canvas.lidar.library.importCancelled', timeoutMs: 4000 })
    const shown = () => document.querySelectorAll('[data-toast-layer] [role="status"]')
    await act(async () => { show() })
    await act(async () => { vi.advanceTimersByTime(3000) })
    await act(async () => { show() })
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(shown()).toHaveLength(1)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(shown()).toHaveLength(0)
  })

  it('canopi-f47t.52.36: a toast while the Desktop notice row shows stacks above the row, never over its actions', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-notice-row') ? 56 : 0
    })
    const clearance = () => document.documentElement.style.getPropertyValue('--notice-row-clearance')
    await act(async () => render(<><NoticeRow /><ToastSlot /></>, container))
    await act(async () => {
      raiseNotice({ key: 'update', message: 'failure.internal' })
      showToast({ key: 'library.import-cancelled:a', message: 'canvas.lidar.library.importCancelled' })
    })
    expect(clearance(), 'the foot row publishes the room it takes').toBe('calc(56px + var(--space-2))')
    await act(async () => { dismissNotice(notices.value[0]!.id) })
    expect(clearance(), 'the foot is the toast\'s again once the row goes').toBe('')
  })

  it('canopi-f47t.52.36: Web\'s notice row below the title bar leaves the toast at the foot', async () => {
    await act(async () => render(<><NoticeRow belowTitleBar={{ top: null }} /><ToastSlot /></>, container))
    await act(async () => { raiseNotice({ key: 'update', message: 'failure.internal' }) })
    expect(container.querySelector('[data-notice-row]')).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--notice-row-clearance')).toBe('')
  })

  it('canopi-f47t.52.36: an Undo toast while a workspace dialog is open sits in its Tab cycle', async () => {
    await act(async () => render(
      <>
        <WorkspaceDialog title="Manage views" onClose={() => {}}><button type="button">Delete</button></WorkspaceDialog>
        <SlotToast message="View deleted" actionLabel="Undo" onAction={() => {}} onDismiss={() => {}} />
      </>,
      container,
    ))
    const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name)!
    const tab = (from: HTMLElement, shiftKey = false) => act(async () => {
      from.focus()
      from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))
    })
    const close = button(t('window.close'))
    const undo = button('Undo')
    await tab(button('Delete'))
    expect(document.activeElement, 'Tab from the dialog\'s last control reaches Undo').toBe(undo)
    await tab(undo)
    expect(document.activeElement, 'Tab from Undo wraps to the dialog\'s first control').toBe(close)
    await tab(close, true)
    expect(document.activeElement, 'Shift+Tab from the first control reaches Undo').toBe(undo)
    await tab(undo, true)
    expect(document.activeElement, 'Shift+Tab from Undo goes back into the dialog').toBe(button('Delete'))
  })

  it('canopi-f47t.52.36: Undo pressed from the keyboard in a dialog\'s Tab cycle leaves focus in the dialog, so Escape still closes it', async () => {
    const onClose = vi.fn()
    function ManageViews() {
      const [toast, setToast] = useState(true)
      return (
        <>
          <WorkspaceDialog title="Manage views" onClose={onClose}><button type="button">Delete</button></WorkspaceDialog>
          {toast && <SlotToast message="View deleted" actionLabel="Undo" onAction={() => {}} onDismiss={() => setToast(false)} />}
        </>
      )
    }
    await act(async () => render(<ManageViews />, container))
    const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === name)!
    const remove = button('Delete')
    remove.focus()
    await act(async () => { remove.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    const undo = button('Undo')
    expect(document.activeElement).toBe(undo)
    await act(async () => { undo.click() })
    expect(undo.isConnected, 'the toast leaves once its action ran').toBe(false)
    expect(document.activeElement, 'focus goes back to the control it left for the toast').toBe(remove)
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  // One case per modal that keeps focus inside itself: each passes its focus to useModalLayer.
  const trapping: ReadonlyArray<{ name: string, root: string, stops: string, show(): Promise<void>, closed(): boolean }> = [
    {
      name: 'workspace dialog', root: '[role="dialog"]', stops: 'button',
      show: () => act(async () => render(<WorkspaceDialog title="Manage views" onClose={closeDialog}><button type="button">Delete</button></WorkspaceDialog>, container)),
      closed: () => closeDialog.mock.calls.length === 1,
    },
    {
      name: 'PDF dialog', root: '[role="dialog"]', stops: 'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
      show: () => act(async () => {
        const workflow = createPdfWorkflow({ capture: () => null, prepare: vi.fn(), resolveDisplayNames: vi.fn(), resolveHabits: vi.fn(),
          delivery: { save: vi.fn(), dispose: vi.fn() }, labels: vi.fn(), namePrintArea: (number) => `Print area ${number}` })
        cleanups.push(() => workflow.dispose())
        workflow.show()
        render(<CanvasPdfDialog workflow={workflow} />, container)
      }),
      closed: () => container.querySelector('[role="dialog"]') === null,
    },
    {
      name: 'save problem dialog', root: '[role="alertdialog"]', stops: 'button',
      show: async () => {
        await act(async () => render(<SaveProblemDialog />, container))
        await act(async () => { void requestSaveProblemDecision({ kind: 'flush-failed', purpose: 'replace', conflict: false }) })
        cleanups.push(() => answerSaveProblem('cancel'))
      },
      closed: () => saveProblem.value === null,
    },
    {
      name: 'story presenter', root: '[data-story-presenter]', stops: 'button, a[href]',
      show: () => act(async () => {
        const step = { id: 's1', view_id: 'v1', title: 'The site', text: [], images: [] }
        presented.value = { story: { id: 'tour', name: 'Client visit', steps: [step] }, step, view: null, index: 0, count: 1 }
        render(<StoryPresenter />, container)
      }),
      closed: () => presented.value === null,
    },
  ]

  it.each(trapping)('canopi-f47t.52.36: an Undo toast over the $name sits in its Tab cycle, and Escape there is the modal\'s', async (modal) => {
    await modal.show()
    await act(async () => render(<SlotToast message="Deleted" actionLabel="Undo" onAction={() => {}} onDismiss={() => {}} />, toastHost))
    const stops = [...document.querySelector(modal.root)!.querySelectorAll<HTMLElement>(modal.stops)]
    const undo = document.querySelector<HTMLButtonElement>('[data-toast-layer] button')!
    const tab = (from: HTMLElement, shiftKey = false) => act(async () => { from.focus(); press(from, 'Tab', shiftKey) })
    await tab(stops.at(-1)!)
    expect(document.activeElement, 'Tab from the last control reaches Undo').toBe(undo)
    await tab(undo)
    expect(document.activeElement, 'Tab from Undo wraps to the first control').toBe(stops[0])
    await tab(stops[0]!, true)
    expect(document.activeElement, 'Shift+Tab from the first control reaches Undo').toBe(undo)
    let escape!: KeyboardEvent
    await act(async () => { escape = press(undo, 'Escape') })
    expect(modal.closed(), 'Escape in the toast is the modal\'s Escape').toBe(true)
    expect(escape.defaultPrevented, 'no later route takes the key').toBe(true)
  })

  it('canopi-f47t.52.36: Escape in a toast leaves a modal that does not take part to the browser', async () => {
    await act(async () => render(<><Modal /><SlotToast message="Deleted" actionLabel="Undo" onAction={() => {}} onDismiss={() => {}} /></>, container))
    const undo = document.querySelector<HTMLButtonElement>('[data-toast-layer] button')!
    undo.focus()
    let escape!: KeyboardEvent
    await act(async () => { escape = press(undo, 'Escape') })
    expect(escape.defaultPrevented).toBe(false)
  })

  it('canopi-f47t.52.36: Tab in a toast never moves focus into a workspace dialog another modal covers', async () => {
    await act(async () => render(
      <>
        <WorkspaceDialog title="Manage views" onClose={() => {}}><button type="button">Delete</button></WorkspaceDialog>
        <Modal />
        <SlotToast message="View deleted" actionLabel="Undo" onAction={() => {}} onDismiss={() => {}} />
      </>,
      container,
    ))
    const undo = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Undo')!
    undo.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => { undo.dispatchEvent(tab) })
    expect(tab.defaultPrevented, 'the covered dialog\'s trap stands aside').toBe(false)
    expect(document.activeElement).toBe(undo)
  })

  it('a workspace dialog with no toast still wraps Tab inside itself', async () => {
    await act(async () => render(
      <WorkspaceDialog title="Manage views" onClose={() => {}}><button type="button">Delete</button></WorkspaceDialog>,
      container,
    ))
    const close = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('window.close')}"]`)!
    const remove = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Delete')!
    remove.focus()
    await act(async () => { remove.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(close)
  })
})
