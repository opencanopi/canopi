// canvas/runtime/tools/object-stamp.ts
//
// Owns the Object stamp (K, spec §3.2). The first press on a plant, zone, note or group copies it: the pick, anchored where
// it was pressed (today's hitTestTopLevel: guides and object-locked objects are not picked, a group needs a member). Every
// later press places the pick with that anchor at the snapped point, turned by the held angle, as one
// 'interaction-object-stamp' edit that selects the copies, while the source is still unlocked on open layers. The ghost of
// what a press would place follows the pointer from the pick on and stays when the pointer leaves the map; the tool card
// names the pick. A pick starts at 0, so copies keep their source's orientation like Paste and Duplicate (spec §4.7); `[`
// and `]` turn it (rotate-held commands), and the tool card shows that turn. The pick is the tool's transient: it holds
// re-origin, it keeps Delete and Ctrl+X from deleting the selection, and Esc drops it first, the card asking for a pick
// again; with nothing held Esc leaves through the Esc chain's tool layer (spec §3.7). A release and every other
// cancellation (a blur, K again, overview) hide the ghost until the next hover and keep the pick.

import type { CanvasStampGuidance } from '../../session-state'
import type { SceneDesignObjectTarget } from '../scene/design-object-targets'
import { resolveSceneObjectGroupMembers, sceneObjectGroupMemberLayerName } from '../scene/group-members'
import { isSceneDesignObjectLocked } from '../scene/locks'
import type { ScenePersistedState, ScenePlantEntity } from '../scene/types'
import {
  createSceneArrangementPlacement,
  type SceneArrangementPlacement,
  type SceneArrangementTemplate,
} from '../scene-runtime/arrangement-placement'
import type { WorldPoint } from '../../../geo/view/types'
import { stampGhostShapes, stampTemplateAt, turnStampRotation } from './stamp-rotation'
import type { CanvasTool, HitTarget, ToolContext } from './tool'

/** The pick: what was pressed, where, and the objects a press places, read once at the pick. */
interface ObjectStampPick {
  readonly target: SceneDesignObjectTarget
  readonly anchorWorld: WorldPoint
  readonly template: SceneArrangementTemplate
}

const ORIGIN: WorldPoint = Object.freeze({ x: 0, y: 0 })

/** The layer a single picked object is placed on. */
const SOURCE_LAYER = { plant: 'plants', zone: 'zones', annotation: 'annotations' } as const

export function createObjectStampTool(): CanvasTool {
  let ctx: ToolContext | null = null
  let placement: SceneArrangementPlacement | null = null
  let pick: ObjectStampPick | null = null
  let rotationDeg = 0
  /** Where the ghost's anchor was last drawn: `[` and `]` redraw it there. */
  let lastAnchor: WorldPoint | null = null
  /** Whether the ghost is drawn now (a release or a cancellation hides it until the next hover). */
  let ghostShown = false

  function context(): ToolContext {
    if (!ctx) throw new Error('The Object stamp is not active.')
    return ctx
  }

  /** A press with nothing picked: `hit` is the host's unfiltered hit under the raw point (today's hitTestTopLevel). */
  function pickAt(world: WorldPoint, hit: HitTarget | null): void {
    rotationDeg = 0
    if (hit?.kind !== 'object') return
    const persisted = context().scene.persisted
    if (isSceneDesignObjectLocked(persisted, hit.target)) return
    const picked = objectStampPickAt(persisted, hit.target, world)
    if (!picked) return
    pick = picked
    showGhostAt(world)
    publishGuidance()
  }

  function placeObjectStamp(anchorWorld: WorldPoint): void {
    const held = pick
    if (!held || !placement || !canPlace(held)) return
    placement.place({
      template: stampTemplateAt(held.template, held.anchorWorld, anchorWorld, rotationDeg),
      translateBy: ORIGIN,
      historyType: 'interaction-object-stamp',
      onCommitted: () => showGhostAt(anchorWorld),
    })
  }

  /** The check at each placement: the source is not locked now and every layer it adds to is open. A group resolves its
   *  picked entity's members against the scene now, so a pick whose members were all removed (an undo) refuses, and only
   *  the surviving members' layers are checked. */
  function canPlace(held: ObjectStampPick): boolean {
    const { scene } = context()
    const persisted = scene.persisted
    if (isSceneDesignObjectLocked(persisted, held.target)) return false
    const group = held.template.groups[0]?.entity
    if (!group) return scene.isLayerOpenForCreation(SOURCE_LAYER[held.target.kind as keyof typeof SOURCE_LAYER])
    const members = resolveSceneObjectGroupMembers(persisted, group)
    return members.length > 0
      && members.every((member) => scene.isLayerOpenForCreation(sceneObjectGroupMemberLayerName(member)))
  }

  /** Ghosts of what a press would place, the stamp's anchor at `anchorWorld`, turned by the held angle. */
  function showGhostAt(anchorWorld: WorldPoint): void {
    lastAnchor = anchorWorld
    const held = pick
    if (!held) {
      hideGhost()
      return
    }
    const shapes = stampGhostShapes(stampTemplateAt(held.template, held.anchorWorld, anchorWorld, rotationDeg))
    ghostShown = true
    context().effects.setDraft({ shapes })
  }

  function hideGhost(): void {
    ghostShown = false
    context().effects.setDraft(null)
  }

  /** The tool card's pick, a plant's name in the scene's current language. */
  function describePick(): CanvasStampGuidance | null {
    const held = pick
    if (!held) return null
    const plants = held.template.plants.map(({ entity }) => entity)
    const kind = held.target.kind
    if (kind === 'plant') {
      return { kind: 'plant', name: context().scene.plantPresentation(plants[0]!).commonName, plants: 1, species: 1 }
    }
    if (kind === 'group') {
      return {
        kind: 'group',
        name: held.template.groups[0]?.entity.name?.trim() || null,
        plants: plants.length,
        species: new Set(plants.map((plant) => plant.canonicalName)).size,
      }
    }
    return { kind: kind === 'zone' ? 'zone' : 'annotation', name: null, plants: 0, species: 0 }
  }

  function publishGuidance(): void {
    context().effects.setGuidance({
      stamp: describePick(),
      stampRotationDeg: pick ? rotationDeg : null,
    })
  }

  function clear(): void {
    pick = null
    rotationDeg = 0
    lastAnchor = null
    ghostShown = false
  }

  return {
    id: 'object-stamp',
    activate(next) {
      ctx = next
      placement = createSceneArrangementPlacement({ sceneEdits: next.effects.edits })
      clear()
    },
    gesture(g) {
      switch (g.kind) {
        case 'press':
          // Every press acts, so a double-click places twice (today).
          if (pick) placeObjectStamp(g.point.snapped)
          else pickAt(g.point.world, g.hit)
          return 'handled'
        case 'hover':
        case 'drag-start':
        case 'drag-move':
          // While a pick is held the ghost is the hover: the passive hover stays off.
          if (!pick) return 'pass'
          showGhostAt(g.point.snapped)
          return 'handled'
        case 'tap':
        case 'drag-end':
          // The press acted; the release hides the ghost until the next hover (today's pointerup ran the cancellation).
          if (ghostShown) hideGhost()
          return 'pass'
        default:
          // The ghost stays when the pointer leaves the map, and a cancelled press leaves it too: today's stamp press let
          // go of the pointer gesture, so a pointercancel or a lost capture after it cancelled nothing.
          return 'pass'
      }
    },
    command(c) {
      if (c.kind === 'rotate-held') {
        if (!pick) return 'pass'
        rotationDeg = turnStampRotation(rotationDeg, c.stepDeg)
        if (lastAnchor) showGhostAt(lastAnchor)
        publishGuidance()
        return 'handled'
      }
      if (c.kind === 'escape') {
        if (!pick) return 'pass'
        clear()
        hideGhost()
        publishGuidance()
        return 'handled'
      }
      return 'pass'
    },
    sceneChanged() {
      // The tool card names the pick in the scene's current language.
      if (pick) publishGuidance()
    },
    hasTransient: () => pick !== null,
    cancelTransient() {
      // The pick and its angle outlive every cancellation, as today; each hides the ghost until the next hover, as today's
      // cancellation and overview reset hid the preview element.
      if (ghostShown) hideGhost()
    },
    deactivate() {
      clear()
      ctx?.effects.setDraft(null)
    },
  }
}

/** The pick of `target` pressed at `world`: its objects read once (a plant's copy never shows its name pinned), or null
 *  for a measurement guide or a group with no members. */
function objectStampPickAt(
  scene: ScenePersistedState,
  target: SceneDesignObjectTarget,
  world: WorldPoint,
): ObjectStampPick | null {
  const anchorWorld = { x: world.x, y: world.y }
  const picked = (entries: Partial<SceneArrangementTemplate>): ObjectStampPick => ({
    target,
    anchorWorld,
    template: { plants: [], zones: [], annotations: [], measurementGuides: [], groups: [], ...entries },
  })
  const stampedPlant = (plant: ScenePlantEntity) => ({ sourceId: plant.id, entity: { ...plant, pinnedName: false } })
  if (target.kind === 'plant') {
    const plant = scene.plants.find((entry) => entry.id === target.id)
    return plant ? picked({ plants: [stampedPlant(plant)] }) : null
  }
  if (target.kind === 'zone') {
    const zone = scene.zones.find((entry) => entry.id === target.id)
    return zone ? picked({ zones: [{ sourceId: zone.id, entity: zone }] }) : null
  }
  if (target.kind === 'annotation') {
    const annotation = scene.annotations.find((entry) => entry.id === target.id)
    return annotation ? picked({ annotations: [{ sourceId: annotation.id, entity: annotation }] }) : null
  }
  if (target.kind === 'group') {
    const group = scene.groups.find((entry) => entry.id === target.id)
    if (!group) return null
    const plants: SceneArrangementTemplate['plants'][number][] = []
    const zones: SceneArrangementTemplate['zones'][number][] = []
    const annotations: SceneArrangementTemplate['annotations'][number][] = []
    for (const member of resolveSceneObjectGroupMembers(scene, group)) {
      const plant = member.kind === 'plant' ? scene.plants.find((entry) => entry.id === member.id) : undefined
      const zone = member.kind === 'zone' ? scene.zones.find((entry) => entry.id === member.id) : undefined
      const annotation = member.kind === 'annotation' ? scene.annotations.find((entry) => entry.id === member.id) : undefined
      if (plant) plants.push(stampedPlant(plant))
      else if (zone) zones.push({ sourceId: zone.id, entity: zone })
      else if (annotation) annotations.push({ sourceId: annotation.id, entity: annotation })
    }
    if (plants.length + zones.length + annotations.length === 0) return null
    return picked({ plants, zones, annotations, groups: [{ sourceId: group.id, entity: group }] })
  }
  // A measurement guide is not stamped.
  return null
}
