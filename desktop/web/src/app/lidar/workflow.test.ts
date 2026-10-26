import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { librarySnapshot, sourceItem } from '../../__tests__/support/library-fixtures'
import type { CanopiFile } from '../../types/design'

// The real Design Edit, counted: the workflow's name reconcile writes through it.
const reconcile = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../design-edit/lidar', async (importOriginal) => {
  const actual = await importOriginal<typeof DesignEditLidarModule>()
  return {
    ...actual,
    reconcileLidarEntryNames: (names: ReadonlyMap<string, string>) => {
      reconcile.calls += 1
      actual.reconcileLidarEntryNames(names)
    },
  }
})

// No library polling: the snapshot is set by hand.
vi.mock('./library-store', async (importOriginal) => ({
  ...(await importOriginal<typeof LibraryStoreModule>()),
  ensureLidarPolling: () => {},
  stopLidarPolling: () => {},
}))

import { designSessionStore } from '../document-session/store'
import { setSiteDataVisible } from '../design-edit/lidar'
import { lidarLibrary } from './library-store'
import { disposeLidarWorkflow, installLidarWorkflow } from './workflow'
import type * as DesignEditLidarModule from '../design-edit/lidar'
import type * as LibraryStoreModule from './library-store'

function openDesign(name: string, entryName: string): void {
  designSessionStore.replaceCurrentDesignState({
    name,
    lidar: {
      visible: true,
      entries: [{ kind: 'Source', id: 'a', name: entryName, order: 0, visible: true, opacity: 1, ramp: null, reversed: false, range: null }],
    },
  } as unknown as CanopiFile, null, name)
}

function storedName(): string | undefined {
  return designSessionStore.currentDesign.value?.lidar?.entries[0]?.name
}

describe('the Desktop data workflow (canopi-f47t.42)', () => {
  beforeEach(() => {
    lidarLibrary.value = null
    openDesign('Orchard', 'Ground')
    reconcile.calls = 0
    installLidarWorkflow()
  })

  afterEach(() => {
    disposeLidarWorkflow()
    lidarLibrary.value = null
  })

  it('refreshes the open Design\'s stored names once from a library rename, without dirtying it', () => {
    lidarLibrary.value = librarySnapshot([sourceItem('a', 'Ground')])
    const calls = reconcile.calls
    lidarLibrary.value = librarySnapshot([sourceItem('a', 'Bare earth')])
    expect(storedName()).toBe('Bare earth')
    expect(reconcile.calls).toBe(calls + 1)
    expect(designSessionStore.designDirty.value).toBe(false)
  })

  it('refreshes a newly opened Design from the snapshot it opens with', () => {
    lidarLibrary.value = librarySnapshot([sourceItem('a', 'Bare earth')])
    openDesign('Hedges', 'Old name')
    expect(storedName()).toBe('Bare earth')
    expect(designSessionStore.designDirty.value).toBe(false)
  })

  it('does not run again for a plain Design edit', () => {
    const snapshot = librarySnapshot([sourceItem('a', 'Bare earth')])
    lidarLibrary.value = snapshot
    const calls = reconcile.calls
    setSiteDataVisible(false)
    expect(reconcile.calls).toBe(calls)
    expect(designSessionStore.currentDesign.value?.lidar?.visible).toBe(false)
  })
})
