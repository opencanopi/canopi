import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesignWriteAdmission } from '../app/document-session/write-admission'
import { DesignHomeConflictError } from '../app/document-session/continuous-save'
import {
  deleteDesignDraft,
  listDesignDrafts,
  loadDesign,
  loadDesignDraft,
  openDesignDialog,
  prepareDesignWrite,
  prepareDraftWrite,
  selectDesignSavePath,
} from '../ipc/design'
import { exportSavedObjectStampFile } from '../app/saved-object-stamps/workbench'
import type { CanopiFile } from '../types/design'

const invoke = vi.hoisted(() => vi.fn(async (
  _command: string,
  _args?: Record<string, unknown>,
): Promise<unknown> => ({ kind: 'saved', path: '/designs/garden.canopi', fingerprint: 'fp-2' })))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('the Design dialogs go through the host (canopi-f47t.52.228.14, 2.1-M81)', () => {
  beforeEach(() => invoke.mockReset())

  it('opens through pick_open, naming only the kind, then loads the chosen Design', async () => {
    const loaded = { file: testDesign(), fingerprint: 'fp-1' }
    invoke.mockResolvedValueOnce({ kind: 'picked', paths: ['/designs/orchard.canopi'] }).mockResolvedValueOnce(loaded)

    await expect(openDesignDialog()).resolves.toEqual({ design: loaded, path: '/designs/orchard.canopi' })
    expect(invoke.mock.calls).toEqual([
      ['pick_open', { kind: 'design-open' }],
      ['load_design', { path: '/designs/orchard.canopi' }],
    ])
  })

  it('a cancelled Open loads nothing', async () => {
    invoke.mockResolvedValueOnce({ kind: 'cancelled' })

    await expect(openDesignDialog()).rejects.toThrow('Dialog cancelled')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['/home/ana/Designs/orchard.canopi', 'orchard.canopi'],
    ['C:\\Users\\Ana\\Designs\\orchard.canopi', 'orchard.canopi'],
    [null, 'Hedgerow'],
  ])('Save As from %s suggests %s in the host Save dialog', async (currentPath, stem) => {
    invoke.mockResolvedValueOnce({ kind: 'picked', path: '/designs/chosen.canopi' })

    await expect(selectDesignSavePath({ currentPath, suggestedName: 'Hedgerow' })).resolves.toBe(
      '/designs/chosen.canopi',
    )
    expect(invoke).toHaveBeenCalledWith('pick_save', { kind: 'design-save', stem })
  })

  it('a cancelled Save throws the cancel the save flow expects', async () => {
    invoke.mockResolvedValueOnce({ kind: 'cancelled' })

    await expect(selectDesignSavePath({ currentPath: null, suggestedName: '' })).rejects.toThrow('Dialog cancelled')
    expect(invoke).toHaveBeenCalledWith('pick_save', { kind: 'design-save', stem: 'Untitled' })
  })
})

describe('native Design IPC wire format', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ kind: 'saved', path: '/designs/garden.canopi', fingerprint: 'fp-2' })
  })

  it('sends canonical root unknown fields and the expected fingerprint to Design saves', async () => {
    const admission = createDesignWriteAdmission()
    const onWritten = vi.fn()
    const content = testDesign({
      extra: {
        future_top_level: { keep: true },
        name: 'Nested Name',
        version: 6,
      },
    })

    await admission.execute(
      prepareDesignWrite('/designs/garden.canopi', 'fp-1', onWritten),
      content,
      () => true,
      () => undefined,
    )

    expect(invoke).toHaveBeenCalledWith('save_design', {
      path: '/designs/garden.canopi',
      content: expect.objectContaining({
        name: 'Garden',
        version: 9,
        future_top_level: { keep: true },
      }),
      expectedFingerprint: 'fp-1',
    })
    expect(invokedContent()).not.toHaveProperty('extra')
    expect(onWritten).toHaveBeenCalledWith('fp-2')
  })

  it('refuses a Design save that finds the file changed or gone', async () => {
    const admission = createDesignWriteAdmission()
    const onWritten = vi.fn()
    invoke.mockResolvedValueOnce({ kind: 'conflict', current_fingerprint: 'fp-other' })
    await expect(admission.execute(
      prepareDesignWrite('/designs/garden.canopi', 'fp-1', onWritten),
      testDesign(),
      () => true,
      () => undefined,
    )).rejects.toEqual(new DesignHomeConflictError(false))

    invoke.mockResolvedValueOnce({ kind: 'conflict', current_fingerprint: null })
    const gone = admission.execute(
      prepareDesignWrite('/designs/garden.canopi', null, onWritten),
      testDesign(),
      () => true,
      () => undefined,
    )
    await expect(gone).rejects.toMatchObject({ fileGone: true })
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({ expectedFingerprint: null })
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('sends canonical root unknown fields to Design Draft writes', async () => {
    const admission = createDesignWriteAdmission()
    invoke.mockResolvedValueOnce(undefined)
    const content = testDesign({
      extra: {
        future_top_level: { keep: true },
      },
    })

    await admission.execute(
      prepareDraftWrite('2f7c3c7e-0d4b-4a4f-9a51-2b1c0f6f9e11'),
      content,
      () => true,
      () => undefined,
    )

    expect(invoke).toHaveBeenCalledWith('save_design_draft', {
      id: '2f7c3c7e-0d4b-4a4f-9a51-2b1c0f6f9e11',
      content: expect.objectContaining({
        future_top_level: { keep: true },
      }),
    })
    expect(invokedContent()).not.toHaveProperty('extra')
  })

  it('names the load, list and delete Design Draft commands', async () => {
    invoke.mockResolvedValue(undefined)
    await loadDesign('/designs/garden.canopi')
    await loadDesignDraft('draft-id')
    await listDesignDrafts()
    await deleteDesignDraft('draft-id')

    expect(invoke.mock.calls).toEqual([
      ['load_design', { path: '/designs/garden.canopi' }],
      ['load_design_draft', { id: 'draft-id' }],
      ['list_design_drafts'],
      ['delete_design_draft', { id: 'draft-id' }],
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

    expect(invoke).toHaveBeenCalledWith('pick_save', { kind: 'stamp-export', stem: 'tree.canopi' })
    expect(invoke).toHaveBeenCalledWith('export_saved_object_stamp_canopi_file', {
      path: '/stamps/tree.canopi',
      content: expect.objectContaining({
        future_top_level: { keep: true },
      }),
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
