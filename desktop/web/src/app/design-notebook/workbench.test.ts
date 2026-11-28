import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { makeTestDesign } from '../../__tests__/support/session-core-fixture'
import { createDesignNotebookWorkbench } from './workbench'

describe('DesignNotebookWorkbench file-home identity (#588 B1)', () => {
  it('matches active row by recent_id, opens non-Recents rows with host grant, and moves newly added rows by stored path', async () => {
    const realPath = '/designs/orchard.canopi'
    const recentId = 'a'.repeat(64)
    const entry = {
      path: realPath,
      name: 'Orchard',
      updated_at: '2026-09-25T00:00:00Z',
      plant_count: 1,
      section_id: null as string | null,
      sort_order: 0,
      grant: 'grant:9',
      recent_id: recentId,
    }
    const storedEntries: Array<typeof entry> = []
    const openDesign = vi.fn(async () => undefined)
    const addDesignReference = vi.fn(async (key: string) => {
      // Host resolves grant:4 to realPath before storing in SQLite.
      expect(key).toBe('grant:4')
      storedEntries.push({ ...entry, grant: 'grant:4' })
    })
    const moveEntryToSection = vi.fn(async () => undefined)
    const activePath = signal<string | null>('grant:4')
    const activeRecentId = signal<string | null>(recentId)
    const currentDesign = signal(makeTestDesign({ name: 'Orchard' }))

    const wb = createDesignNotebookWorkbench({
      loadNotebook: async () => ({
        entries: storedEntries.map((item) => ({ ...item })),
        sections: [{ id: 'sec-1', name: 'Farms', sort_order: 0, created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z' }],
      }),
      loadRecentDesigns: async () => [],
      openDesign,
      saveCurrent: async () => true,
      addDesignReference,
      moveEntryToSection,
      activePath,
      activeRecentId,
      currentDesign,
    })

    await wb.load()
    expect(wb.view.value.canAddCurrentDesign).toBe(true)

    const added = await wb.addCurrentDesignToNotebook('sec-1')
    expect(added).toBe(true)
    expect(moveEntryToSection).toHaveBeenCalledWith(realPath, 'sec-1')
    expect(wb.view.value.activePath).toBe(realPath)
    expect(wb.view.value.canAddCurrentDesign).toBe(false)

    // Simulate restart: host mints a new grant:9 for the Notebook row, Recents is empty.
    storedEntries[0] = { ...entry, grant: 'grant:9', section_id: 'sec-1' }
    await wb.load()
    await wb.openEntry(realPath)
    expect(openDesign).toHaveBeenCalledWith('grant:9', {
      grant: 'grant:9',
      displayName: 'orchard.canopi',
      recentId,
    })

    // #631 F5: a row without a host grant never falls back to openDesign(rawPath); it refreshes instead.
    openDesign.mockClear()
    storedEntries[0] = { ...entry, grant: undefined as unknown as string }
    await wb.load()
    await wb.openEntry(realPath)
    expect(openDesign).not.toHaveBeenCalled()
    wb.dispose()
  })
})
