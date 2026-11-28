import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown, _options?: unknown): Promise<unknown> => undefined))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { createDesktopFileDelivery } from './file-delivery'

describe('text export IPC', () => {
  beforeEach(() => invoke.mockReset())

  it('writes the destination the host Save dialog chose through the focused export command', async () => {
    invoke.mockResolvedValueOnce({ kind: 'picked', path: '/tmp/orchard-budget.csv' })
    invoke.mockResolvedValueOnce('/tmp/orchard-budget.csv')

    await expect(createDesktopFileDelivery().deliverFile('budget-csv', 'orchard-budget.csv', { text: 'Species,Quantity' })).resolves.toBe(
      'saved',
    )

    expect(invoke.mock.calls).toEqual([
      ['pick_save', { kind: 'budget-csv-export', stem: 'orchard-budget.csv', operation: expect.stringMatching(/^u-/) }],
      ['deliver_file', new TextEncoder().encode('Species,Quantity'), {
        headers: {
          'x-canopi-delivery-kind': 'csv',
          'x-canopi-delivery-path': encodeURIComponent('/tmp/orchard-budget.csv'),
          'x-canopi-operation': expect.stringMatching(/^u-/),
        },
      }],
    ])
  })

  it('does not invoke the native command when the dialog is cancelled', async () => {
    invoke.mockResolvedValueOnce({ kind: 'cancelled' })

    await expect(createDesktopFileDelivery().deliverFile('budget-csv', 'budget.csv', { text: 'data' })).resolves.toBe('cancelled')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
