import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { exportFile } from '../ipc/export'

describe('text export IPC', () => {
  beforeEach(() => invoke.mockReset())

  it('writes the destination the host Save dialog chose through the focused export command', async () => {
    invoke.mockResolvedValueOnce({ kind: 'picked', path: '/tmp/orchard-budget.csv' })
    invoke.mockResolvedValueOnce('/tmp/orchard-budget.csv')

    await expect(exportFile('Species,Quantity', 'orchard-budget.csv', 'budget-csv-export')).resolves.toBe(
      '/tmp/orchard-budget.csv',
    )

    expect(invoke.mock.calls).toEqual([
      ['pick_save', { kind: 'budget-csv-export', stem: 'orchard-budget.csv' }],
      ['export_file', { data: 'Species,Quantity', path: '/tmp/orchard-budget.csv' }],
    ])
  })

  it('does not invoke the native command when the dialog is cancelled', async () => {
    invoke.mockResolvedValueOnce({ kind: 'cancelled' })

    await expect(exportFile('data', 'budget.csv', 'budget-csv-export')).rejects.toThrow('Dialog cancelled')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
