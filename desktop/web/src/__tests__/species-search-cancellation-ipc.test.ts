import { describe, expect, it, vi } from 'vitest'
import { supersedeSpeciesSearch } from '../ipc/species'

const invoke = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('Species Search cancellation IPC', () => {
  it('invokes the dedicated backend supersession command', async () => {
    await supersedeSpeciesSearch()

    expect(invoke).toHaveBeenCalledWith('supersede_species_search', { operation: expect.stringMatching(/^u-/) })
  })
})
