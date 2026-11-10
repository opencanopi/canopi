// @vitest-environment jsdom
// The one window-level toast position (contracts §18 F3, 2.1-Q292): every toast draws in one layer on <body>, above the
// active dialog and outside every chrome region a modal makes inert, so an Undo stays pressable while a dialog is open.
// Stacking-order.test.ts holds the layer above the dialog layers on the z scale.
import { render } from 'preact'
import { useRef } from 'preact/hooks'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotToast } from './ToastSlot'
import { useModalInertRegion, useModalLayer } from './useModalLayer'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

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
})
