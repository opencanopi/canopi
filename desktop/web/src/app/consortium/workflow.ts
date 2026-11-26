import { effect } from '@preact/signals'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { consortiumTarget, getConsortiumCanonicalName } from '../../target'
import { reconcileCurrentDesign } from '../design-edit'
import { currentDesign } from '../document-session/store'
import type { Consortium } from '../../types/design'
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

export function installConsortiumSync(): () => void {
  disposer?.()
  const stop = effect(() => {
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
  disposer = stop
  return () => {
    stop()
    if (disposer === stop) disposer = null
  }
}

function disposeConsortiumSync(): void {
  disposer?.()
  disposer = null
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
