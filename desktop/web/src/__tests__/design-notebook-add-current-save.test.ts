// U30: adding the current Design to a notebook makes its file hold every edit, but it is not a Save, so a clean
// Design's file is not rewritten with the live view. The workbench's default wiring is what is checked here.
import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import type { CanopiFile } from '../types/design'
import type * as DocumentSessionActionsModule from '../app/document-session/actions'

const saves = vi.hoisted(() => ({
  saveCurrentDesign: vi.fn(async () => true),
  saveCurrentDesignEdits: vi.fn(async () => true),
}))

vi.mock('../app/document-session/actions', async (importOriginal) => ({
  ...await importOriginal<typeof DocumentSessionActionsModule>(),
  ...saves,
}))

const { createDesignNotebookWorkbench } = await import('../app/design-notebook/workbench')

describe('Add current Design to notebook', () => {
  it('writes a file home only as continuous save would, never as a manual Save', async () => {
    const design = { name: 'Orchard' } as CanopiFile
    const addDesignReference = vi.fn().mockResolvedValue(undefined)
    const workbench = createDesignNotebookWorkbench({
      activePath: signal<string | null>('/designs/orchard.canopi'),
      currentDesign: signal<CanopiFile | null>(design),
      loadNotebook: vi.fn().mockResolvedValue({
        sections: [],
        entries: [{ path: '/designs/orchard.canopi', name: 'Orchard', section_id: null, sort_order: 0, plant_count: 0, updated_at: '' }],
      }),
      addDesignReference,
    })

    await expect(workbench.addCurrentDesignToNotebook(null)).resolves.toBe(true)

    expect(saves.saveCurrentDesignEdits).toHaveBeenCalledTimes(1)
    expect(saves.saveCurrentDesign).not.toHaveBeenCalled()
    expect(addDesignReference).toHaveBeenCalledWith('/designs/orchard.canopi', design)
    workbench.dispose()
  })
})
