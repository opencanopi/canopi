import type { Consortium } from '../../types/design'
import { consortiumTarget, getConsortiumCanonicalName } from '../../target'
import { DEFAULT_CONSORTIUM_STRATUM } from '../../planning/time-model'
import { editCurrentDesign } from './core'

export function moveConsortiumEntry(
  canonicalName: string,
  updates: { stratum?: string; startPhase: number; endPhase: number },
): void {
  editCurrentDesign((design) => {
    const next = moveConsortiumEntryInArray(design.consortiums, design.plants, canonicalName, updates)
    return next === design.consortiums ? design : { ...design, consortiums: next }
  }, 'consortium.move')
}

function moveConsortiumEntryInArray(
  consortiums: Consortium[],
  plants: readonly { readonly canonical_name: string }[],
  canonicalName: string,
  updates: { stratum?: string; startPhase: number; endPhase: number },
): Consortium[] {
  const index = consortiums.findIndex((consortium) => getConsortiumCanonicalName(consortium) === canonicalName)
  if (index === -1) {
    if (!plants.some((plant) => plant.canonical_name === canonicalName)) return consortiums
    return [
      ...consortiums,
      {
        target: consortiumTarget(canonicalName),
        stratum: updates.stratum ?? DEFAULT_CONSORTIUM_STRATUM,
        start_phase: updates.startPhase,
        end_phase: updates.endPhase,
      },
    ]
  }

  const existing = consortiums[index]!
  const nextStratum = updates.stratum ?? existing.stratum
  if (
    existing.start_phase === updates.startPhase &&
    existing.end_phase === updates.endPhase &&
    existing.stratum === nextStratum
  ) {
    return consortiums
  }

  const next = [...consortiums]
  next[index] = {
    ...existing,
    stratum: nextStratum,
    start_phase: updates.startPhase,
    end_phase: updates.endPhase,
  }
  return next
}
