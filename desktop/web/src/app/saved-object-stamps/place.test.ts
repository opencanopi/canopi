import { afterEach, describe, expect, it } from 'vitest'
import { placeStampThroughCore } from './place'
import { SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION, type SavedObjectStampPayload } from '../../canvas/saved-object-stamp-payload'
import type { SceneCommand } from '../../canvas/runtime/scene-commands'
import { resetToastsForTests, toasts } from '../../failures/toasts'

afterEach(() => {
  resetToastsForTests()
})

const NOOP_COMMAND = {} as SceneCommand

function makeEmptyStamp(overrides: Partial<SavedObjectStampPayload> = {}): SavedObjectStampPayload {
  return {
    version: SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
    anchor: { x: 0, y: 0 },
    plants: [],
    zones: [],
    annotations: [],
    groups: [],
    ...overrides,
  }
}

describe('placeStampThroughCore', () => {
  it('returns null without raising a toast when core.place declines the fragment', () => {
    const summary = placeStampThroughCore(
      { place: () => null },
      makeEmptyStamp(),
      () => ({ command: NOOP_COMMAND, rollback: () => {} }),
    )
    expect(summary).toBeNull()
    expect(toasts.peek()).toHaveLength(0)
  })

  it('skips duplicate species in consortiums and budget, remaps plant/zone targets, and avoids colliding action IDs', () => {
    let mergedPatch: Partial<Record<string, unknown>> | null = null
    const stamp = makeEmptyStamp({
      consortiums: [
        { canonicalName: 'Malus domestica', stratum: 'canopy', startPhase: 1, endPhase: 5 },
        { canonicalName: 'Castanea sativa', stratum: 'emergent', startPhase: 1, endPhase: 7 },
        { canonicalName: 'Castanea sativa', stratum: 'emergent', startPhase: 2, endPhase: 6 },
      ],
      budget: [
        { canonicalName: 'Malus domestica', unitCost: 15 },
        { canonicalName: 'Castanea sativa', unitCost: 30 },
        { canonicalName: 'Castanea sativa', unitCost: 35 },
      ],
      timeline: [
        {
          title: 'Prune apple',
          category: 'pruning',
          offsetDays: null,
          recurrence: { frequency: 'yearly', interval: 1 },
          targets: [
            { kind: 'placed_plant', plant_id: 'p-1' },
            { kind: 'placed_plant', plant_id: 'p-missing' },
            { kind: 'zone', zone_id: 'z-1' },
            { kind: 'zone', zone_id: 'z-missing' },
            { kind: 'species', canonical_name: 'Castanea sativa' },
          ],
        },
        {
          title: 'General mulch',
          category: 'mulching',
          offsetDays: 7,
        },
      ],
    })

    const summary = placeStampThroughCore(
      {
        place: (fragment, applyScene) => {
          applyScene(fragment.sceneObjects)
          mergedPatch = fragment.mergeDocument?.({
            consortiums: [
              { target: { kind: 'species', canonical_name: 'Malus domestica' } },
              { target: { kind: 'group', canonical_name: null } },
            ],
            budget: [
              { target: { kind: 'species', canonical_name: 'Malus domestica' } },
              { target: { kind: 'custom' } },
            ],
            timeline: [
              { id: 'stamp-action-3' },
              null,
            ],
          }) ?? null
          return 'entry-1'
        },
      },
      stamp,
      () => ({
        command: NOOP_COMMAND,
        rollback: () => {},
        idRemap: new Map([
          ['plant:p-1', 'new-p-1'],
          ['zone:z-1', 'new-z-1'],
        ]),
      }),
    )

    expect(summary).toEqual({ plants: 0, zones: 0, annotations: 0, guides: 0, careActions: 2 })
    expect(toasts.peek().some((t) => t.key === 'saved-object-stamp-placed')).toBe(true)

    const patch = mergedPatch!
    expect(patch.consortiums).toHaveLength(3)
    expect(patch.budget).toHaveLength(3)
    const timeline = patch.timeline as Array<{ id: string; targets: unknown[]; offset_days?: number }>
    expect(timeline).toHaveLength(4)
    expect(timeline[2]!.id).toBe('stamp-action-4')
    expect(timeline[2]!.offset_days).toBeUndefined()
    expect(timeline[2]!.targets).toEqual([
      { kind: 'placed_plant', plant_id: 'new-p-1' },
      { kind: 'placed_plant', plant_id: 'p-missing' },
      { kind: 'zone', zone_id: 'new-z-1' },
      { kind: 'zone', zone_id: 'z-missing' },
      { kind: 'species', canonical_name: 'Castanea sativa' },
    ])
    expect(timeline[3]!.id).toBe('stamp-action-5')
    expect(timeline[3]!.offset_days).toBe(7)
    expect(timeline[3]!.targets).toEqual([])
  })

  it('emits an empty document patch when all stamp consortiums and budget entries already exist', () => {
    let mergedPatch: Partial<Record<string, unknown>> | null = null
    const stamp = makeEmptyStamp({
      consortiums: [{ canonicalName: 'Malus domestica', stratum: 'canopy', startPhase: 1, endPhase: 5 }],
      budget: [{ canonicalName: 'Malus domestica', unitCost: 15 }],
    })

    const summary = placeStampThroughCore(
      {
        place: (fragment, applyScene) => {
          applyScene(fragment.sceneObjects)
          mergedPatch = fragment.mergeDocument?.({
            consortiums: [{ target: { kind: 'species', canonical_name: 'Malus domestica' } }],
            budget: [{ target: { kind: 'species', canonical_name: 'Malus domestica' } }],
            timeline: [],
          }) ?? null
          return 'entry-2'
        },
      },
      stamp,
      () => ({ command: NOOP_COMMAND, rollback: () => {} }),
    )

    expect(summary).toEqual({ plants: 0, zones: 0, annotations: 0, guides: 0, careActions: 0 })
    expect(mergedPatch).toEqual({})
  })
})
