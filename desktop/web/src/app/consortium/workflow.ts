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
    if (!design) return

    if (!session) return
    const currentPlants = session.getSettledPlacedPlants()
    if (!currentPlants) return
    const currentConsortiums = design.consortiums
    const currentNames = new Set<string>()
    for (const plant of currentPlants) currentNames.add(plant.canonical_name)

    const existingConsortiumNames = new Set<string>()
    for (const consortium of currentConsortiums) {
      existingConsortiumNames.add(getConsortiumCanonicalName(consortium))
    }

    const toAdd: string[] = []
    for (const name of currentNames) {
      if (!existingConsortiumNames.has(name)) {
        toAdd.push(name)
      }
    }

    if (toAdd.length === 0) return

    reconcileCurrentDesign((nextDesign) => {
      const newEntries = toAdd.map(createDefaultConsortiumEntry)
      const consortiums = [...nextDesign.consortiums, ...newEntries]
      return { ...nextDesign, consortiums }
    })
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
