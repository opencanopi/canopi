// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  useConsortiumDockWorkbench,
  type ConsortiumDockWorkbench,
} from '../app/consortium/dock-workbench'
import { disposePlanningViewState } from '../app/planning-view/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { consortiumTarget } from '../target'
import type { CanopiFile, PlacedPlant } from '../types/design'
import {
  currentDesign,
  designDirty,
  designSessionFixture,
} from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'

function plant(canonicalName = 'Malus domestica'): PlacedPlant {
  return {
    id: `plant-${canonicalName}`,
    canonical_name: canonicalName,
    common_name: 'Apple',
    color: null,
    position: { lon: 13, lat: 23 },
    rotation: null,
    scale: null,
    notes: null,
    planted_date: null,
    quantity: 1,
    locked: false,
  }
}

function design(name: string): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [
      { target: consortiumTarget('Malus domestica'), stratum: 'unknown-stratum', start_phase: 0, end_phase: 2 },
      { target: consortiumTarget('Absent species'), stratum: 'high', start_phase: 0, end_phase: 6 },
    ],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '',
    updated_at: '',
  }
}

describe('Consortium dock workbench', () => {
  let container: HTMLDivElement
  let workbench: ConsortiumDockWorkbench

  function Harness() {
    workbench = useConsortiumDockWorkbench()
    return null
  }

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    disposePlanningViewState()
    designSessionFixture.file = design('Consortium one')
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ plants: [plant()] }),
    }))
    await act(async () => { render(<Harness />, container) })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
  })

  it('keeps unknown strata visible and validates inclusive phase order before one edit', () => {
    const row = workbench.projection.rows[0]!
    expect(row.stratum).toBe('unknown-stratum')

    act(() => {
      workbench.openEditor(row)
      workbench.updateDraft({ startPhase: 5, endPhase: 2 })
      expect(workbench.saveEditor()).toBe(false)
    })
    expect(designDirty.value).toBe(false)

    act(() => {
      workbench.updateDraft({ stratum: 'high', startPhase: 2, endPhase: 5 })
      expect(workbench.saveEditor()).toBe(true)
    })
    expect(currentDesign.value?.consortiums[0]).toMatchObject({
      stratum: 'high', start_phase: 2, end_phase: 5,
    })
    expect(currentDesign.value?.consortiums[1]?.target).toEqual(consortiumTarget('Absent species'))
    expect(designDirty.value).toBe(true)
  })

  it('reports a successful move outside the active filter and keeps cancellation clean', () => {
    const row = workbench.projection.rows[0]!
    act(() => {
      workbench.setFilter({ stratum: 'unknown-stratum', phase: 1 })
      workbench.openEditor(row)
      workbench.cancelEditor()
    })
    expect(designDirty.value).toBe(false)

    act(() => {
      workbench.openEditor(row)
      workbench.updateDraft({ stratum: 'medium' })
      expect(workbench.saveEditor()).toBe(true)
    })
    expect(workbench.movedOutsideFilter).toBe(true)
    expect(workbench.list.visibleCount).toBe(0)
  })

  it('does not dirty the Design when saving an unchanged row', () => {
    act(() => {
      workbench.openEditor(workbench.projection.rows[0]!)
      expect(workbench.saveEditor()).toBe(true)
    })

    expect(designDirty.value).toBe(false)
  })

  it('cancels a draft when another Design with the same species replaces the session', async () => {
    act(() => workbench.openEditor(workbench.projection.rows[0]!))
    await act(async () => { designSessionFixture.file = design('Consortium two') })

    expect(workbench.editor).toBeNull()
    expect(workbench.saveEditor()).toBe(false)
    expect(currentDesign.value?.consortiums[0]?.stratum).toBe('unknown-stratum')
  })
})
