import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteDesignDraft,
  listDesignDrafts,
} from '../ipc/design'
import { exportSavedObjectStampFile } from '../app/saved-object-stamps/workbench'
import type { CanopiFile } from '../types/design'

const invoke = vi.hoisted(() => vi.fn(async (
  _command: string,
  _args?: Record<string, unknown>,
): Promise<unknown> => undefined))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('native Design IPC wire format', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
  })

  it('names the list and delete Design Draft commands', async () => {
    invoke.mockResolvedValue(undefined)
    await listDesignDrafts()
    await deleteDesignDraft('draft-id')

    expect(invoke.mock.calls).toEqual([
      ['list_design_drafts', { operation: expect.stringMatching(/^u-/) }],
      ['delete_design_draft', { id: 'draft-id', operation: expect.stringMatching(/^u-/) }],
    ])
  })

  it('sends canonical root unknown fields when exporting a Saved Object Stamp', async () => {
    const content = testDesign({
      extra: {
        future_top_level: { keep: true },
      },
    })

    invoke.mockResolvedValueOnce({ kind: 'picked', path: '/stamps/tree.canopi' })
    await exportSavedObjectStampFile(content, 'tree.canopi')

    expect(invoke).toHaveBeenCalledWith('pick_save', { kind: 'stamp-export', stem: 'tree.canopi', operation: expect.stringMatching(/^u-/) })
    expect(invoke).toHaveBeenCalledWith('export_saved_object_stamp_canopi_file', {
      path: '/stamps/tree.canopi',
      content: expect.objectContaining({
        future_top_level: { keep: true },
      }),
      operation: expect.stringMatching(/^u-/),
    })
    expect(invokedContent()).not.toHaveProperty('extra')
  })
})

function invokedContent(): unknown {
  return invoke.mock.calls.find(([, args]) => args !== undefined && 'content' in args)?.[1]?.content
}

function testDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Garden',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    extra: {},
    ...overrides,
  }
}
