import { effect } from '@preact/signals'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { consortiumTarget, getConsortiumCanonicalName } from '../../target'
import { reconcileCurrentDesign } from '../design-edit'
import { currentDesign } from '../document-session/store'
import type { DesignSessionWorkflow } from '../document-session/workflow-runner'
import type { Consortium } from '../../generated/contracts'
import { DEFAULT_CONSORTIUM_END_PHASE, DEFAULT_CONSORTIUM_START_PHASE, DEFAULT_CONSORTIUM_STRATUM } from '../../planning/time-model'

function createDefaultConsortiumEntry(canonicalName: string): Consortium {
  return {
    target: consortiumTarget(canonicalName),
    stratum: DEFAULT_CONSORTIUM_STRATUM,
    start_phase: DEFAULT_CONSORTIUM_START_PHASE,
    end_phase: DEFAULT_CONSORTIUM_END_PHASE,
  }
}

let disposer: (() => void) | null = null

function installConsortiumSync(): void {
  disposer?.()
  disposer = effect(() => {
    const session = currentCanvasQuerySurface.value
    void session?.revision.scene.value
    const design = currentDesign.value
    const currentPlants = design && session?.getSettledPlacedPlants()
    if (!design || !currentPlants) return
    const existing = new Set(design.consortiums.map(getConsortiumCanonicalName))
    const toAdd = [...new Set(currentPlants.map((p) => p.canonical_name))].filter((n) => !existing.has(n))
    if (toAdd.length === 0) return
    reconcileCurrentDesign((d) => ({ ...d, consortiums: [...d.consortiums, ...toAdd.map(createDefaultConsortiumEntry)] }))
  })
}

function disposeConsortiumSync(): void {
  disposer?.()
  disposer = null
}

export const consortiumSyncWorkflow: DesignSessionWorkflow = {
  id: 'consortium-sync',
  install: () => {
    installConsortiumSync()
    return disposeConsortiumSync
  },
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeConsortiumSync()
  })
}

/** @testonly */
export function createDefaultConsortiumEntryForTests(
  canonicalName: string,
): ReturnType<typeof createDefaultConsortiumEntry> {
  return createDefaultConsortiumEntry(canonicalName)
}
