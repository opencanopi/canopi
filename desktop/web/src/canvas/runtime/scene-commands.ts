import {
  normalizeSceneDesignObjectTargets,
  sceneDesignObjectTargetsEqual,
  type SceneDesignObjectTarget,
  type ScenePersistedState,
} from './scene'

type PersistedPatchKey = keyof ScenePersistedState

type EntityArrayKey = 'plants' | 'zones' | 'annotations' | 'measurementGuides' | 'groups'
type NonEntityPatchKey = Exclude<PersistedPatchKey, EntityArrayKey>

interface IdEntity {
  readonly id: string
}

/**
 * Entity-level inverse delta for an id-keyed scene collection (2.1-M547):
 * stores only entities that were added, removed, or modified instead of cloning the full array.
 */
interface EntityArrayDelta<T extends IdEntity = IdEntity> {
  /** Entities to upsert (restore or update) when applying this side of the patch. */
  readonly upsert: readonly T[]
  /** Entity ids to remove when applying this side of the patch. */
  readonly removeIds: readonly string[]
  /** Present only when entity ordering or membership changed (omitted for in-place edits). */
  readonly order?: readonly string[]
}

export interface SceneCommandSnapshot {
  persisted: ScenePersistedState
  selectedTargets: readonly SceneDesignObjectTarget[]
}

export interface SceneCommandPatch {
  readonly persisted?: Partial<ScenePersistedState>
  readonly entityDeltas?: { readonly [K in EntityArrayKey]?: EntityArrayDelta<ScenePersistedState[K][number]> }
  readonly selection?: readonly SceneDesignObjectTarget[]
}

export interface SceneCommand {
  readonly type: string
  readonly before: SceneCommandPatch
  readonly after: SceneCommandPatch
}

// Every persisted collection, so a new one gets undo the day it is added: tsc fails until it is listed here.
const PATCH_KEY_SET = {
  plantSpeciesColors: true,
  plantSpeciesSymbols: true,
  plantSpeciesCodes: true,
  layers: true,
  plants: true,
  zones: true,
  annotations: true,
  measurementGuides: true,
  groups: true,
} as const satisfies Record<PersistedPatchKey, true>

const ENTITY_ARRAY_KEYS: readonly EntityArrayKey[] = [
  'plants',
  'zones',
  'annotations',
  'measurementGuides',
  'groups',
]

const NON_ENTITY_PATCH_KEYS: readonly NonEntityPatchKey[] = (
  Object.keys(PATCH_KEY_SET) as PersistedPatchKey[]
).filter((key): key is NonEntityPatchKey => !(ENTITY_ARRAY_KEYS as readonly string[]).includes(key))

function computeEntityArrayDeltas<T extends IdEntity>(
  beforeArr: readonly T[],
  afterArr: readonly T[],
): { readonly before: EntityArrayDelta<T>; readonly after: EntityArrayDelta<T> } | null {
  if (beforeArr === afterArr) return null

  const beforeMap = new Map<string, T>()
  for (const item of beforeArr) beforeMap.set(item.id, item)
  const afterMap = new Map<string, T>()
  for (const item of afterArr) afterMap.set(item.id, item)

  const beforeUpsert: T[] = []
  const beforeRemove: string[] = []
  const afterUpsert: T[] = []
  const afterRemove: string[] = []

  let orderChanged = beforeArr.length !== afterArr.length
  if (!orderChanged) {
    for (let i = 0; i < beforeArr.length; i += 1) {
      if (beforeArr[i]!.id !== afterArr[i]!.id) {
        orderChanged = true
        break
      }
    }
  }

  for (const [id, bItem] of beforeMap) {
    const aItem = afterMap.get(id)
    if (!aItem) {
      beforeUpsert.push(cloneValue(bItem))
      afterRemove.push(id)
    } else if (bItem !== aItem && stableStringify(bItem) !== stableStringify(aItem)) {
      beforeUpsert.push(cloneValue(bItem))
      afterUpsert.push(cloneValue(aItem))
    }
  }

  for (const [id, aItem] of afterMap) {
    if (!beforeMap.has(id)) {
      afterUpsert.push(cloneValue(aItem))
      beforeRemove.push(id)
    }
  }

  if (
    !orderChanged &&
    beforeUpsert.length === 0 &&
    beforeRemove.length === 0 &&
    afterUpsert.length === 0 &&
    afterRemove.length === 0
  ) {
    return null
  }

  return {
    before: orderChanged
      ? { upsert: beforeUpsert, removeIds: beforeRemove, order: beforeArr.map((item) => item.id) }
      : { upsert: beforeUpsert, removeIds: beforeRemove },
    after: orderChanged
      ? { upsert: afterUpsert, removeIds: afterRemove, order: afterArr.map((item) => item.id) }
      : { upsert: afterUpsert, removeIds: afterRemove },
  }
}

function applyEntityArrayDelta<T extends IdEntity>(
  current: readonly T[],
  delta: EntityArrayDelta<T>,
): T[] {
  const removeSet = delta.removeIds.length > 0 ? new Set(delta.removeIds) : null
  const upsertMap = new Map<string, T>()
  for (const item of delta.upsert) upsertMap.set(item.id, cloneValue(item))

  if (delta.order) {
    const byId = new Map<string, T>()
    for (const item of current) {
      if (!removeSet?.has(item.id)) byId.set(item.id, item)
    }
    for (const [id, item] of upsertMap) byId.set(id, item)
    const ordered: T[] = []
    for (const id of delta.order) {
      const item = byId.get(id)
      if (item) ordered.push(item)
    }
    return ordered
  }

  // Fast path: in-place property edits with unchanged order/membership.
  return current.map((item) => upsertMap.get(item.id) ?? item)
}

export function createScenePatchCommand(
  type: string,
  before: SceneCommandSnapshot,
  after: SceneCommandSnapshot,
): SceneCommand | null {
  const beforePatch: MutableSceneCommandPatch = {}
  const afterPatch: MutableSceneCommandPatch = {}

  for (const key of ENTITY_ARRAY_KEYS) {
    const deltas = computeEntityArrayDeltas<IdEntity>(
      before.persisted[key],
      after.persisted[key],
    )
    if (!deltas) continue
    beforePatch.entityDeltas ??= {}
    afterPatch.entityDeltas ??= {}
    ;(beforePatch.entityDeltas as Record<EntityArrayKey, EntityArrayDelta>)[key] = deltas.before
    ;(afterPatch.entityDeltas as Record<EntityArrayKey, EntityArrayDelta>)[key] = deltas.after
  }

  for (const key of NON_ENTITY_PATCH_KEYS) {
    const beforeValue = before.persisted[key]
    const afterValue = after.persisted[key]
    if (beforeValue === afterValue || stableStringify(beforeValue) === stableStringify(afterValue)) continue
    beforePatch.persisted ??= {}
    afterPatch.persisted ??= {}
    ;(beforePatch.persisted as Record<NonEntityPatchKey, unknown>)[key] = cloneValue(beforeValue)
    ;(afterPatch.persisted as Record<NonEntityPatchKey, unknown>)[key] = cloneValue(afterValue)
  }

  const beforeSelection = normalizeSceneDesignObjectTargets(before.selectedTargets)
  const afterSelection = normalizeSceneDesignObjectTargets(after.selectedTargets)
  if (!sceneDesignObjectTargetsEqual(beforeSelection, afterSelection)) {
    beforePatch.selection = beforeSelection
    afterPatch.selection = afterSelection
  }

  if (!afterPatch.persisted && !afterPatch.entityDeltas && !afterPatch.selection) return null

  return {
    type,
    before: beforePatch,
    after: afterPatch,
  }
}

interface MutableSceneCommandPatch {
  persisted?: Partial<ScenePersistedState>
  entityDeltas?: { [K in EntityArrayKey]?: EntityArrayDelta<ScenePersistedState[K][number]> }
  selection?: SceneDesignObjectTarget[]
}

export function applySceneCommandPersistedPatch(
  draft: ScenePersistedState,
  patch: SceneCommandPatch,
): void {
  if (patch.persisted) {
    Object.assign(draft, cloneValue(patch.persisted))
  }
  if (patch.entityDeltas) {
    for (const key of ENTITY_ARRAY_KEYS) {
      const delta = patch.entityDeltas[key]
      if (!delta) continue
      ;(draft as unknown as Record<EntityArrayKey, unknown>)[key] = applyEntityArrayDelta(
        draft[key] as readonly IdEntity[],
        delta as EntityArrayDelta,
      )
    }
  }
}

export function remapSceneCommandPatch(
  patch: SceneCommandPatch,
  remapPersisted: (persisted: Partial<ScenePersistedState>) => Partial<ScenePersistedState>,
): SceneCommandPatch {
  if (!patch.persisted && !patch.entityDeltas) return patch
  let nextEntityDeltas = patch.entityDeltas
  if (patch.entityDeltas) {
    const remapped: MutableSceneCommandPatch['entityDeltas'] = {}
    for (const key of ENTITY_ARRAY_KEYS) {
      const delta = patch.entityDeltas[key]
      if (!delta) continue
      const remappedUpsert = delta.upsert.length > 0
        ? (remapPersisted({ [key]: delta.upsert })[key] as readonly IdEntity[] | undefined)
          ?? delta.upsert
        : delta.upsert
      ;(remapped as Record<EntityArrayKey, EntityArrayDelta>)[key] = {
        ...delta,
        upsert: remappedUpsert,
      }
    }
    nextEntityDeltas = remapped
  }
  return {
    ...patch,
    ...(patch.persisted ? { persisted: remapPersisted(patch.persisted) } : {}),
    ...(nextEntityDeltas ? { entityDeltas: nextEntityDeltas } : {}),
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}
