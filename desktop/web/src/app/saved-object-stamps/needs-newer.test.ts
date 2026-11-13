// A saved stamp a newer Canopi wrote (a payload above v2) as the reader release meets it (Step 2.0.4 R2-5,
// canopi-f47t.52.271; 2.1-M88): the store lists it with `needs_newer`, and the workbench never places it nor sends a
// rename, delete or reorder naming it, while a stamp from before 2.0 stays deletable.
import { describe, expect, it, vi } from 'vitest'
import { createSavedObjectStampWorkbench } from './workbench'
import { savedObjectStampRowState } from '../../canvas/saved-object-stamp-payload'
import type { SavedObjectStamp } from '../../types/saved-object-stamps'

const stamp = (id: string, payload: Record<string, unknown>, sortOrder: number, needsNewer = false): SavedObjectStamp => ({
  id,
  name: id,
  payload_json: JSON.stringify(payload),
  sort_order: sortOrder,
  created_at: `2026-11-0${sortOrder + 1}T00:00:00Z`,
  updated_at: `2026-11-0${sortOrder + 1}T00:00:00Z`,
  needs_newer: needsNewer,
})

const V2 = { version: 2, anchor: { x: 0, y: 0 }, plants: [], zones: [], annotations: [], groups: [] }
const v2 = stamp('v2', V2, 0)
const v3 = stamp('v3', { ...V2, version: 3, guides: [] }, 1, true)
const v1 = stamp('v1', { version: 1, plants: [] }, 2)

async function loadedWorkbench() {
  const ipc = {
    getSavedObjectStamps: vi.fn(async () => [v2, v3, v1]),
    renameSavedObjectStamp: vi.fn(async (id: string, name: string) => ({ ...v2, id, name })),
    deleteSavedObjectStamp: vi.fn(async () => true),
    reorderSavedObjectStamps: vi.fn(async () => [v1, v3, v2]),
    arm: vi.fn(() => true),
  }
  const workbench = createSavedObjectStampWorkbench(ipc)
  await workbench.loadLibrary()
  return { workbench, ipc }
}

describe('a saved stamp needing a newer Canopi (canopi-f47t.52.271)', () => {
  it('classifies the listed row by the store’s needs_newer, a v1 payload as before 2.0 and a v2 one as ready', () => {
    expect([v2, v3, v1].map(savedObjectStampRowState)).toEqual(['ready', 'needs-newer', 'before-2-0'])
    expect(savedObjectStampRowState({ payload_json: JSON.stringify(V2) }), 'absent reads as false').toBe('ready')
  })

  it('canopi-f47t.52.271: renaming or deleting a v3 row sends nothing and settles unchanged', async () => {
    const { workbench, ipc } = await loadedWorkbench()

    await expect(workbench.renameStamp('v3', 'Hedge')).resolves.toBeNull()
    await expect(workbench.deleteStamp('v3')).resolves.toBe(false)

    expect(ipc.renameSavedObjectStamp).not.toHaveBeenCalled()
    expect(ipc.deleteSavedObjectStamp).not.toHaveBeenCalled()
    expect(workbench.library.value.items).toEqual([v2, v3, v1])
  })

  it('canopi-f47t.52.271: a reorder including a v3 id sends only the older ids, the v3 row keeping its place', async () => {
    const { workbench, ipc } = await loadedWorkbench()

    await workbench.reorderStamps(['v1', 'v3', 'v2'])

    expect(ipc.reorderSavedObjectStamps).toHaveBeenCalledWith(['v1', 'v2'])
  })

  it('canopi-f47t.52.271: a v3 stamp is never placed', async () => {
    const { workbench, ipc } = await loadedWorkbench()

    expect(workbench.placeStamp(v3, 'panel')).toBe(false)
    expect(workbench.placeStamp(v2, 'panel')).toBe(true)
    expect(ipc.arm).toHaveBeenCalledTimes(1)
  })

  it('canopi-f47t.52.271: a v1 row beside a v3 row is still deleted', async () => {
    const { workbench, ipc } = await loadedWorkbench()

    await expect(workbench.deleteStamp('v1')).resolves.toBe(true)

    expect(ipc.deleteSavedObjectStamp).toHaveBeenCalledWith('v1')
    expect(workbench.library.value.items.map((item) => item.id)).toEqual(['v2', 'v3'])
  })
})
