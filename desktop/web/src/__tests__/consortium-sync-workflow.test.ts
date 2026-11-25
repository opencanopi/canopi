// @vitest-environment jsdom

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  designDirty,
  designSessionFixture,
  currentDesign,
} from './support/design-session-state'
import { setCurrentCanvasSession } from '../canvas/session'
import { installConsortiumSync } from '../app/consortium/workflow'
import type { CanopiFile, PlacedPlant } from '../types/design'
import { consortiumTarget, getConsortiumCanonicalName } from '../target'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'

function makeDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '',
    updated_at: '',
    extra: {},
    ...overrides,
  }
}

function makePlant(canonical_name: string): PlacedPlant {
  return {
    id: `plant-${canonical_name}`,
    canonical_name,
    common_name: null,
    color: null,
    position: { lon: 13, lat: 23 },
    rotation: null,
    scale: null,
    notes: null,
    planted_date: null,
    quantity: null,
    locked: false,
  }
}

function mockSession(plants: PlacedPlant[]) {
  return createTestCanvasQuerySurface({ plants })
}

function mountQuerySurface(session: ReturnType<typeof mockSession>): void {
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: session }))
}

describe('consortium-sync-workflow', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    dispose = null
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    setCurrentCanvasSession(null)
  })

  it('adds consortium entries for new plant species', () => {
    const plants = [makePlant('Quercus robur'), makePlant('Acer campestre')]
    const session = mockSession(plants)
    designSessionFixture.file = makeDesign()
    mountQuerySurface(session)

    dispose = installConsortiumSync()
    session.bumpSceneRevision()

    const consortiums = currentDesign.value!.consortiums
    expect(consortiums).toHaveLength(2)
    expect(consortiums.map(getConsortiumCanonicalName).sort()).toEqual(['Acer campestre', 'Quercus robur'])
    expect(consortiums[0]!.stratum).toBe('unassigned')
  })

  it('preserves inactive consortium entries when species are deleted', () => {
    designSessionFixture.file = makeDesign({
      consortiums: [
        { target: consortiumTarget('Quercus robur'), stratum: 'high', start_phase: 0, end_phase: 3 },
        { target: consortiumTarget('Acer campestre'), stratum: 'medium', start_phase: 0, end_phase: 2 },
      ],
    })
    // Only Quercus remains on canvas
    const session = mockSession([makePlant('Quercus robur')])
    mountQuerySurface(session)

    dispose = installConsortiumSync()
    session.bumpSceneRevision()

    const consortiums = currentDesign.value!.consortiums
    expect(consortiums).toHaveLength(2)
    expect(consortiums).toContainEqual({ target: consortiumTarget('Acer campestre'), stratum: 'medium', start_phase: 0, end_phase: 2 })
  })

  it('does not record derived reconciliation as user intent', () => {
    const session = mockSession([makePlant('Quercus robur')])
    designSessionFixture.file = makeDesign()
    mountQuerySurface(session)

    dispose = installConsortiumSync()
    session.bumpSceneRevision()

    expect(designDirty.value).toBe(false)
  })

  it('retries skipped derivation when Scene admission settles without a Scene revision', () => {
    const session = mockSession([makePlant('Quercus robur')])
    session.setSettled(false)
    const sceneRevision = session.revision.scene.value
    designSessionFixture.file = makeDesign()
    mountQuerySurface(session)

    dispose = installConsortiumSync()
    expect(currentDesign.value!.consortiums).toEqual([])

    session.setSettled(true)

    expect(session.revision.scene.value).toBe(sceneRevision)
    expect(currentDesign.value!.consortiums.map(getConsortiumCanonicalName))
      .toEqual(['Quercus robur'])
  })

  it('is a no-op when plant set has not changed', () => {
    const plants = [makePlant('Quercus robur')]
    designSessionFixture.file = makeDesign({
      consortiums: [{ target: consortiumTarget('Quercus robur'), stratum: 'high', start_phase: 0, end_phase: 3 }],
    })
    const session = mockSession(plants)
    mountQuerySurface(session)

    dispose = installConsortiumSync()
    // First tick — names match existing consortiums
    session.bumpSceneRevision()
    const snapshotAfterFirst = currentDesign.value

    // Second tick — no change
    session.bumpSceneRevision()
    expect(currentDesign.value).toBe(snapshotAfterFirst)
  })

  it('stops deriving consortiums once disposed, and a second dispose is harmless', () => {
    const session = mockSession([makePlant('Quercus robur')])
    session.setSettled(false)
    designSessionFixture.file = makeDesign()
    mountQuerySurface(session)

    dispose = installConsortiumSync()
    dispose()
    dispose()

    session.setSettled(true)
    session.bumpSceneRevision()
    expect(currentDesign.value!.consortiums).toEqual([])
  })
})
