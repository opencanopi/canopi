import type { Consortium } from '../../generated/contracts'
import { getConsortiumCanonicalName } from '../../target'
import { editDesignArray } from './core'

export function moveConsortiumEntry(
  canonicalName: string,
  updates: { stratum?: string; startPhase: number; endPhase: number },
): void {
  editDesignArray('consortiums', (consortiums) => moveConsortiumEntryInArray(consortiums, canonicalName, updates), 'consortium.move')
}

function moveConsortiumEntryInArray(
  consortiums: Consortium[],
  canonicalName: string,
  updates: { stratum?: string; startPhase: number; endPhase: number },
): Consortium[] {
  const index = consortiums.findIndex((consortium) => getConsortiumCanonicalName(consortium) === canonicalName)
  if (index === -1) return consortiums

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
