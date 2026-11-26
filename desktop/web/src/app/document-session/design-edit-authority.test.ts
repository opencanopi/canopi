import { afterEach, describe, expect, it } from 'vitest'
import { createTestSessionCore, type TestSessionCoreHandle } from '../../__tests__/support/session-core-fixture'
import type { CanopiFile } from '../../types/design'
import { defaultDesignEditAuthority } from '../design-edit/authority-capability'
import { designSessionStore } from './store'

describe('Design Edit authority', () => {
  let handle: TestSessionCoreHandle | null = null

  afterEach(() => {
    handle?.dispose()
    handle = null
  })

  it('opens a new Design with a fresh scope identity without reviving predecessor state, and routes Document edits through SessionCore', async () => {
    const predecessor = design('Predecessor')
    const successor = design('Successor')
    handle = createTestSessionCore({
      file: predecessor,
      path: '/predecessor.canopi',
      name: predecessor.name,
    })
    const predecessorIdentity = designSessionStore.sessionIdentity.value
    const authority = defaultDesignEditAuthority()

    authority.editCommitted((current) => ({ ...current, description: 'dirty-before-switch' }), 'edit-desc')
    expect(designSessionStore.isDesignDirty()).toBe(true)

    handle.home.seedFile('/successor.canopi', successor, 'v-succ')
    const opened = await handle.core.openFrom({ kind: 'file', grant: '/successor.canopi' })
    expect(opened.status).toBe('opened')

    expect(designSessionStore.sessionIdentity.value).not.toBe(predecessorIdentity)
    expect(designSessionStore.readIdentity()).toEqual({
      file: expect.objectContaining({ name: 'Successor' }),
      path: '/successor.canopi',
      name: 'Successor',
    })
    expect(designSessionStore.isDesignDirty()).toBe(false)
    expect(handle.core.currentDesign.value?.rev).toBe(0)

    authority.editCommitted((current) => ({ ...current, description: 'committed' }), 'edit-desc')
    expect(designSessionStore.readCurrentDesign()?.description).toBe('committed')
    expect(designSessionStore.isDesignDirty()).toBe(true)
    expect(handle.core.currentDesign.value?.rev).toBe(1)

    // Reconcile updates committed Document state without bumping rev.
    authority.reconcileCommitted((current) => ({ ...current, budget_currency: 'USD' }))
    expect(designSessionStore.readCurrentDesign()?.budget_currency).toBe('USD')
    expect(handle.core.currentDesign.value?.rev).toBe(1)

    // Scene-owned keys cannot be mutated through the Design Edit authority.
    expect(() => {
      authority.editCommitted((current) => ({
        ...current,
        plants: [{ id: 'p-1' } as CanopiFile['plants'][number]],
      }))
    }).toThrow(/Scene-owned key "plants"/)
  })
})

function design(name: string): CanopiFile {
  return {
    version: 10,
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
