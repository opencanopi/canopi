/**
 * app/saved-object-stamps/place.ts: Compound v3 stamp placement through `core.place` (2.1-M88, 2.1-M89, 2.1-Q155,
 * 2.1-Q168, 2.1-Q354). Places all scene objects (plants, zones, annotations, measurement guides, groups, locks, notes,
 * and species codes under the 2.1-Q168 rule) together with care actions, consortiums, and budget lines as ONE
 * compound Undo entry, and raises a placement summary toast.
 */
import { mergeStampSpeciesCodes, type SavedObjectStampPayload } from '../../canvas/saved-object-stamp-payload'
import type { SceneCommand } from '../../canvas/runtime/scene-commands'
import { showToast } from '../../failures/toasts'
import type { BudgetItem, Consortium, TimelineAction } from '../../types/design'

export interface StampPlacementSummary {
  readonly plants: number
  readonly zones: number
  readonly annotations: number
  readonly guides: number
  readonly careActions: number
}

interface StampPlacementDocumentRead {
  readonly consortiums: readonly { readonly target: { readonly kind: string; readonly canonical_name?: string | null } }[]
  readonly budget: readonly { readonly target: { readonly kind: string; readonly canonical_name?: string | null } }[]
  readonly timeline: readonly unknown[]
}

interface StampPlacementCore {
  place<TScene>(
    fragment: {
      readonly label: string
      readonly sceneObjects: readonly TScene[]
      readonly mergeDocument?: (current: StampPlacementDocumentRead) => Partial<Record<string, unknown>> | null
    },
    applySceneObjects: (objects: readonly TScene[]) => { readonly command: SceneCommand; readonly rollback: () => void },
  ): string | null
}

function addOffsetDaysToTodayIso(offsetDays: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + Math.trunc(offsetDays))
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function buildStampDocumentMerge(
  stamp: SavedObjectStampPayload,
  idRemap: ReadonlyMap<string, string> = new Map(),
): (current: StampPlacementDocumentRead) => Partial<Record<string, unknown>> {
  return (current) => {
    const patch: Record<string, unknown> = {}

    if (stamp.consortiums && stamp.consortiums.length > 0) {
      const existingSpecies = new Set(
        current.consortiums.map((c) => (c.target.kind === 'species' && typeof c.target.canonical_name === 'string' ? c.target.canonical_name : '')),
      )
      const added: Consortium[] = []
      for (const entry of stamp.consortiums) {
        if (existingSpecies.has(entry.canonicalName)) continue
        existingSpecies.add(entry.canonicalName)
        added.push({
          target: { kind: 'species', canonical_name: entry.canonicalName },
          stratum: entry.stratum,
          start_phase: entry.startPhase,
          end_phase: entry.endPhase,
        })
      }
      if (added.length > 0) patch.consortiums = [...current.consortiums, ...added]
    }

    if (stamp.budget && stamp.budget.length > 0) {
      const pricedSpecies = new Set<string>()
      for (const item of current.budget) {
        if (item.target.kind === 'species' && typeof item.target.canonical_name === 'string') {
          pricedSpecies.add(item.target.canonical_name)
        }
      }
      const added: BudgetItem[] = []
      for (const line of stamp.budget) {
        if (pricedSpecies.has(line.canonicalName)) continue
        pricedSpecies.add(line.canonicalName)
        added.push({ target: { kind: 'species', canonical_name: line.canonicalName }, unit_cost: line.unitCost })
      }
      if (added.length > 0) patch.budget = [...current.budget, ...added]
    }

    if (stamp.timeline && stamp.timeline.length > 0) {
      const baseOrder = current.timeline.length
      const existingIds = new Set(
        current.timeline.flatMap((entry) =>
          typeof entry === 'object' && entry !== null && 'id' in entry && typeof (entry as { id?: unknown }).id === 'string'
            ? [(entry as { id: string }).id]
            : []),
      )
      let seq = baseOrder + 1
      const nextActionId = (): string => {
        while (existingIds.has(`stamp-action-${seq}`)) seq += 1
        const id = `stamp-action-${seq}`
        existingIds.add(id)
        seq += 1
        return id
      }
      const added: TimelineAction[] = stamp.timeline.map((action, index) => {
        const offset = typeof action.offsetDays === 'number' && Number.isFinite(action.offsetDays) ? action.offsetDays : 0
        const targets = (action.targets ?? []).map((rawTarget) => {
          const target = rawTarget as Record<string, unknown>
          if (target.kind === 'placed_plant' && typeof target.plant_id === 'string') {
            const remapped = idRemap.get(`plant:${target.plant_id}`)
            return remapped ? { kind: 'placed_plant' as const, plant_id: remapped } : target
          }
          if (target.kind === 'zone' && typeof target.zone_id === 'string') {
            const remapped = idRemap.get(`zone:${target.zone_id}`)
            return remapped ? { kind: 'zone' as const, zone_id: remapped } : target
          }
          return target
        })
        return {
          id: nextActionId(),
          action_type: action.category,
          description: action.title,
          start_date: addOffsetDaysToTodayIso(offset),
          end_date: null,
          recurrence: (action.recurrence ?? null) as TimelineAction['recurrence'],
          targets: targets as TimelineAction['targets'],
          depends_on: null,
          completed: false,
          order: baseOrder + index,
          ...(action.offsetDays != null ? { offset_days: action.offsetDays } : {}),
        }
      })
      patch.timeline = [...current.timeline, ...added]
    }

    return patch
  }
}

export function placeStampThroughCore(
  core: StampPlacementCore,
  stamp: SavedObjectStampPayload,
  applyScene: (
    speciesCodeMerger: typeof mergeStampSpeciesCodes,
  ) => { readonly command: SceneCommand; readonly rollback: () => void; readonly idRemap?: ReadonlyMap<string, string> },
): StampPlacementSummary | null {
  let idRemap: ReadonlyMap<string, string> = new Map()
  const entryId = core.place(
    {
      label: 'place-saved-object-stamp',
      sceneObjects: [stamp],
      mergeDocument: (current) => buildStampDocumentMerge(stamp, idRemap)(current),
    },
    () => {
      const staged = applyScene(mergeStampSpeciesCodes)
      if (staged.idRemap) idRemap = staged.idRemap
      return { command: staged.command, rollback: staged.rollback }
    },
  )
  if (!entryId) return null

  const summary: StampPlacementSummary = {
    plants: stamp.plants.length,
    zones: stamp.zones.length,
    annotations: stamp.annotations.length,
    guides: stamp.measurementGuides?.length ?? 0,
    careActions: stamp.timeline?.length ?? 0,
  }
  const objectCount = summary.plants + summary.zones + summary.annotations + summary.guides
  showToast({
    key: 'saved-object-stamp-placed',
    message: 'savedObjectStamps.placedToast',
    params: { objects: objectCount, actions: summary.careActions },
  })
  return summary
}
