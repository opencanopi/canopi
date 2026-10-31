import { beforeEach, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
import { createPdfDelivery } from '../app/canvas-pdf/platform.desktop'
beforeEach(() => { invoke.mockReset() })
it('writes the prepared bytes after the host Save dialog chooses a PDF destination', async () => {
  invoke.mockResolvedValueOnce({ kind: 'picked', path: '/chosen/garden.pdf' })
  const result = await createPdfDelivery().save(new Uint8Array([1, 2, 3]), 'Garden: plan', new AbortController().signal)
  expect(result).toBe('saved')
  expect(invoke.mock.calls).toEqual([
    ['pick_save', { kind: 'pdf-export', stem: 'Garden_ plan' }],
    ['save_canvas_pdf', { data: [1, 2, 3], path: '/chosen/garden.pdf' }],
  ])
})
it('does not write when the dialog is cancelled or the captured session becomes stale', async () => {
  const delivery = createPdfDelivery(), abort = new AbortController()
  invoke.mockResolvedValueOnce({ kind: 'cancelled' })
  expect(await delivery.save(new Uint8Array([1]), 'Garden', abort.signal)).toBe('cancelled')
  invoke.mockImplementationOnce(async () => { abort.abort(); return { kind: 'picked', path: '/chosen/stale.pdf' } })
  expect(await delivery.save(new Uint8Array([1]), 'Garden', abort.signal)).toBe('cancelled')
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(['pick_save', 'pick_save'])
})
it('does not open a native destination dialog after cancellation', async () => {
  expect(await createPdfDelivery().save(new Uint8Array([1]), 'Garden', AbortSignal.abort())).toBe('cancelled')
  expect(invoke).not.toHaveBeenCalled()
})
