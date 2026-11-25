import { describe, expect, it, vi } from 'vitest'
import { disposeDesignEditAuthorityForTests } from '../app/design-edit/authority-capability'
import { createDesignSessionPersistence } from '../app/document-session/persistence'
import { captureDesignSessionPersistenceState } from '../app/document-session/persistence-capability'
import {
  createDesignSessionStoreTestFixture,
  createDesignSessionStore,
} from '../app/document-session/store'
import { prepareDesignWriteDestination } from '../app/document-session/write-admission'
import type { CanopiFile } from '../types/design'
import { editDesignSessionForTest } from './support/design-session-edit'

describe('Design Edit authority', () => {
  it('resets one store lifetime without reviving predecessor captures', () => {
    const predecessor = design('Predecessor')
    const successor = design('Successor')
    const store = createDesignSessionStore({
      file: predecessor,
      path: '/predecessor.canopi',
      name: predecessor.name,
    })
    const fixture = createDesignSessionStoreTestFixture(store)
    const capture = captureDesignSessionPersistenceState(store)
    fixture.setState({
      nonCanvasRevision: 2,
      nonCanvasSavedRevision: 1,
      persistenceDiverged: true,
      canvasClean: false,
      detachedCanvasDirty: true,
      pendingDesignPath: '/queued.canopi',
    })

    fixture.reset({
      file: successor,
      path: '/successor.canopi',
      name: successor.name,
    })

    expect(capture.isCurrent()).toBe(false)
    expect(capture.acknowledgeSaved()).toBe('stale')
    expect(store.readIdentity()).toEqual({
      file: successor,
      path: '/successor.canopi',
      name: 'Successor',
    })
    expect(store.isDesignDirty()).toBe(false)
    expect(store.committedDesignRevision.value).toBe(0)
    expect(store.readPendingDesignPath()).toBe(null)

    editDesignSessionForTest(store, (current) => ({ ...current, description: 'committed' }))
    expect(store.readCurrentDesign()?.description).toBe('committed')
    expect(store.isDesignDirty()).toBe(true)
  })

  it('invalidates captures, guards and pending writes across an authority lifetime rollover', async () => {
    const original = design('Original')
    const store = createDesignSessionStore({ file: original, name: original.name })
    const persistence = createDesignSessionPersistence({ store })
    const capture = captureDesignSessionPersistenceState(store)
    const guard = persistence.beginReplacementGuard().guard
    const pendingWrite = persistence.beginBrowserDownload()

    disposeDesignEditAuthorityForTests(store)

    expect(store.readCurrentDesign()).toBe(original)
    expect(capture.isCurrent()).toBe(false)
    expect(guard?.isCurrent()).toBe(false)
    expect(store.isDesignDirty()).toBe(false)

    const write = vi.fn()
    await expect(pendingWrite.execute(
      prepareDesignWriteDestination({
        resource: 'browser-download:authority-disposal',
        blocksReplacement: false,
        write,
      }),
    )).resolves.toMatchObject({ status: 'stale' })
    expect(write).not.toHaveBeenCalled()

    editDesignSessionForTest(store, (current) => ({ ...current, description: 'committed later' }))
    expect(store.readCurrentDesign()?.description).toBe('committed later')
  })
})

function design(name: string): CanopiFile {
  return {
    version: 9,
    name,
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
    created_at: '',
    updated_at: '',
    extra: {},
  }
}
