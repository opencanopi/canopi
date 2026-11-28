import { beforeEach, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown, _options?: unknown): Promise<unknown> => undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
import { createDesktopFileDelivery } from '../editions/desktop/file-delivery'
beforeEach(() => { invoke.mockReset() })
it('writes the prepared bytes after the host Save dialog chooses a PDF destination', async () => {
  invoke.mockResolvedValueOnce({ kind: 'picked', path: '/chosen/garden.pdf' })
  const result = await createDesktopFileDelivery().deliverFile('pdf', 'Garden: plan', { bytes: new Uint8Array([1, 2, 3]) }, new AbortController().signal)
  expect(result).toBe('saved')
  expect(invoke.mock.calls).toEqual([
    ['pick_save', { kind: 'pdf-export', stem: 'Garden plan.pdf', operation: expect.stringMatching(/^u-/) }],
    ['deliver_file', new Uint8Array([1, 2, 3]), {
      headers: {
        'x-canopi-delivery-kind': 'pdf',
        'x-canopi-delivery-path': encodeURIComponent('/chosen/garden.pdf'),
        'x-canopi-operation': expect.stringMatching(/^u-/),
      },
    }],
  ])
})
it('does not write when the dialog is cancelled or the captured session becomes stale', async () => {
  const delivery = createDesktopFileDelivery(), abort = new AbortController()
  invoke.mockResolvedValueOnce({ kind: 'cancelled' })
  expect(await delivery.deliverFile('pdf', 'Garden', { bytes: new Uint8Array([1]) }, abort.signal)).toBe('cancelled')
  invoke.mockImplementationOnce(async () => { abort.abort(); return { kind: 'picked', path: '/chosen/stale.pdf' } })
  expect(await delivery.deliverFile('pdf', 'Garden', { bytes: new Uint8Array([1]) }, abort.signal)).toBe('cancelled')
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(['pick_save', 'pick_save'])
})
it('does not open a native destination dialog after cancellation', async () => {
  expect(await createDesktopFileDelivery().deliverFile('pdf', 'Garden', { bytes: new Uint8Array([1]) }, AbortSignal.abort())).toBe('cancelled')
  expect(invoke).not.toHaveBeenCalled()
})
