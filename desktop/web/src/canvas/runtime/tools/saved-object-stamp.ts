// canvas/runtime/tools/saved-object-stamp.ts
//
// Owns the saved stamp tool (spec §3.2) and the placement code the ToolHost's drop route calls for a Favorites drop (spec
// §1.4 "Drops", 0B-4). The stamp arrives as the tool's source (the session bridges the saved-stamp read model); a press
// places it once with its anchor at the snapped point, turned by the held angle, as one 'interaction-saved-object-stamp'
// edit that selects the copies, then returns to Select, whose leaving drops the stamp from the read model. Its ghost
// follows the pointer and stays when the pointer leaves the map. A stamp starts level to the screen (its pick starts at the
// bearing when it is chosen, spec §4.7) and keeps that ground angle when the view turns, as an Object stamp pick does; `[`
// and `]` turn it from there (rotate-held commands), and the tool card shows that turn. The held stamp is no transient: Esc
// leaves for Select at once through the Esc chain's tool layer (spec §3.7; a one-shot tool, U34). A release, another stamp and every cancellation (a blur, the tool armed again, overview) hide the
// ghost until the next hover and keep the stamp, as today's pointerup and cancellation hid the preview, and the host hides it
// on a re-origin until the next hover. The ghosts come from tools/stamp-rotation.ts.

import type { SavedObjectStampPayload } from '../../saved-object-stamp-payload'
import type { SceneAnnotationEntity, ScenePlantEntity, SceneZoneEntity } from '../scene/types'
import { createSceneArrangementPlacement, type SceneArrangementTemplate } from '../scene-runtime/arrangement-placement'
import type { SceneEditCoordinator } from '../scene-runtime/transactions'
import type { WorldPoint } from '../../../geo/view/types'
import type { DraftShape } from './draft'
import {
  screenAlignedTemplateCenter,
  stampGhostShapes,
  stampTemplateAt,
  turnStampRotation,
} from './stamp-rotation'
import type { CanvasTool, ToolContext, ToolScene, ToolSource } from './tool'

const ORIGIN: WorldPoint = Object.freeze({ x: 0, y: 0 })

type StampScene = Pick<ToolScene, 'isLayerOpenForCreation'>

export function createSavedObjectStampTool(): CanvasTool {
  let ctx: ToolContext | null = null
  let stamp: SavedObjectStampPayload | null = null
  /** The pick's start: the bearing when the stamp was chosen, so it reads as saved relative to the screen (spec §4.7). */
  let startDeg = 0
  /** The turn `[` and `]` added since the pick, which the tool card shows. */
  let turnDeg = 0
  /** Where the ghost's anchor was last drawn: `[` and `]` redraw it there. */
  let lastAnchor: WorldPoint | null = null
  /** Whether the ghost is drawn now (a release or a cancellation hides it until the next hover). */
  let ghostShown = false

  function context(): ToolContext {
    if (!ctx) throw new Error('The saved stamp tool is not active.')
    return ctx
  }

  /** The stamp held now; choosing another stamp starts it level to the screen. True when the stamp changed. */
  function hold(source: ToolSource | null): boolean {
    const next = source?.kind === 'saved-stamp' ? source.stamp : null
    if (next === stamp) return false
    startDeg = context().view.bearingDeg
    turnDeg = 0
    stamp = next
    return true
  }

  /** The angle the stamp is placed at: the pick's start plus the held turn. */
  function rotationDeg(): number {
    return turnStampRotation(startDeg, turnDeg)
  }

  function publishGuidance(): void {
    context().effects.setGuidance({ stampRotationDeg: stamp ? turnDeg : null })
  }

  function showGhostAt(at: WorldPoint): void {
    lastAnchor = at
    const { effects, scene, view } = context()
    const shapes = stamp ? savedObjectStampGhostShapes(scene, stamp, at, rotationDeg(), view.bearingDeg) : null
    ghostShown = shapes !== null
    effects.setDraft(shapes ? { shapes } : null)
  }

  function hideGhost(): void {
    ghostShown = false
    context().effects.setDraft(null)
  }

  function place(at: WorldPoint): void {
    const held = stamp
    if (!held) return
    const { effects, scene, view } = context()
    placeSavedObjectStamp(effects.edits, scene, held, at, {
      rotationDeg: rotationDeg(),
      bearingDeg: view.bearingDeg,
      onCommitted: () => {
        // One placement, then Select: leaving the tool drops the stamp from the read model (the session's).
        stamp = null
        lastAnchor = null
        hideGhost()
        effects.requestTool('select')
      },
    })
  }

  function reset(): void {
    stamp = null
    startDeg = 0
    turnDeg = 0
    lastAnchor = null
    ghostShown = false
  }

  return {
    id: 'saved-object-stamp',
    activate(next, source) {
      ctx = next
      reset()
      hold(source)
      publishGuidance()
    },
    sourceChanged(source) {
      // A ghost shows only the stamp it was drawn for: the new one shows at the next hover (Favorites arms the tool again,
      // whose cancellation hid today's preview). `[` and `]` still draw it at the last anchor, as today's rotateBy did.
      if (hold(source) && ghostShown) hideGhost()
      publishGuidance()
    },
    gesture(g) {
      switch (g.kind) {
        case 'press':
          place(g.point.snapped)
          return 'handled'
        case 'hover':
        case 'drag-start':
        case 'drag-move':
          // While a stamp is held the ghost is the hover: the passive hover stays off.
          if (!stamp) return 'pass'
          showGhostAt(g.point.snapped)
          return 'handled'
        case 'tap':
        case 'drag-end':
          // A press that placed nothing keeps the stamp; the release hides the ghost until the next hover (today's
          // pointerup ran the cancellation).
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
        if (!stamp) return 'pass'
        turnDeg = turnStampRotation(turnDeg, c.stepDeg)
        if (lastAnchor) showGhostAt(lastAnchor)
        publishGuidance()
        return 'handled'
      }
      return 'pass'
    },
    hasTransient: () => false,
    cancelTransient() {
      // The stamp and its angle outlive every cancellation, as today; each hides the ghost until the next hover, as today's
      // cancellation and overview reset hid the preview element.
      if (ghostShown) hideGhost()
    },
    deactivate() {
      reset()
      ctx?.effects.setDraft(null)
    },
  }
}

/** Whether the saved stamp can be placed now: it holds an object, and every layer it adds to is visible and unlocked. */
export function canPlaceSavedObjectStamp(scene: StampScene, stamp: SavedObjectStampPayload): boolean {
  if (stamp.plants.length + stamp.zones.length + stamp.annotations.length + (stamp.measurementGuides?.length ?? 0) === 0) return false
  return requiredLayers(stamp).every((layer) => scene.isLayerOpenForCreation(layer))
}

/**
 * The saved stamp's ghosts with its anchor at `at` (a snapped point), turned by `rotationDeg`; null when it cannot be
 * placed there. The tool's preview, and the drop route's dragover preview.
 */
export function savedObjectStampGhostShapes(
  scene: StampScene,
  stamp: SavedObjectStampPayload,
  at: WorldPoint,
  rotationDeg: number,
  bearingDeg: number,
): DraftShape[] | null {
  if (!canPlaceSavedObjectStamp(scene, stamp)) return null
  const template = savedObjectStampArrangementTemplate(stamp)
  const pivot = savedObjectStampPivot(stamp, template, rotationDeg, bearingDeg)
  return stampGhostShapes(stampTemplateAt(template, pivot, at, rotationDeg))
}

/**
 * Places the saved stamp with its anchor at `at` (snapped by the caller), turned by `rotationDeg`, as one
 * 'interaction-saved-object-stamp' edit that selects the copies; `onCommitted` runs once the edit commits, and nothing
 * happens when the stamp cannot be placed. The tool's press, and the drop route's drop.
 */
export function placeSavedObjectStamp(
  edits: SceneEditCoordinator,
  scene: StampScene,
  stamp: SavedObjectStampPayload,
  at: WorldPoint,
  options: { readonly rotationDeg: number; readonly bearingDeg: number; readonly onCommitted: () => void },
): void {
  if (!canPlaceSavedObjectStamp(scene, stamp)) return
  const template = savedObjectStampArrangementTemplate(stamp)
  const pivot = savedObjectStampPivot(stamp, template, options.rotationDeg, options.bearingDeg)
  createSceneArrangementPlacement({ sceneEdits: edits }).place({
    template: stampTemplateAt(template, pivot, at, options.rotationDeg),
    translateBy: ORIGIN,
    historyType: 'interaction-saved-object-stamp',
    onCommitted: options.onCommitted,
  })
}

/**
 * 2.1-Q89: On a turned map, saved stamps pivot and anchor on the centre of the turned template's
 * screen-aligned box at `bearingDeg` (equivalently, the unturned template's box at
 * `bearingDeg - rotationDeg`, which returns `stamp.anchor` when the stamp is level to the screen).
 */
function savedObjectStampPivot(
  stamp: SavedObjectStampPayload,
  template: SceneArrangementTemplate,
  rotationDeg: number,
  bearingDeg: number,
): WorldPoint {
  const relativeBearing = turnStampRotation(bearingDeg, -rotationDeg)
  if (relativeBearing <= 1e-6 || Math.abs(relativeBearing - 360) <= 1e-6) return stamp.anchor
  return screenAlignedTemplateCenter(template, relativeBearing) ?? stamp.anchor
}

function requiredLayers(stamp: SavedObjectStampPayload): string[] {
  const layers: string[] = []
  if (stamp.plants.length > 0) layers.push('plants')
  if (stamp.zones.length > 0) layers.push('zones')
  if (stamp.annotations.length > 0) layers.push('annotations')
  if ((stamp.measurementGuides?.length ?? 0) > 0) layers.push('measurement-guides')
  return layers
}

function savedObjectStampArrangementTemplate(stamp: SavedObjectStampPayload): SceneArrangementTemplate {
  return {
    plants: stamp.plants.map((plant) => ({
      sourceId: plant.id,
      entity: scenePlantFromSavedPlant(plant),
    })),
    zones: stamp.zones.map((zone) => ({
      sourceId: zone.id,
      entity: sceneZoneFromSavedZone(zone),
    })),
    annotations: stamp.annotations.map((annotation) => ({
      sourceId: annotation.id,
      entity: sceneAnnotationFromSavedAnnotation(annotation),
    })),
    measurementGuides: (stamp.measurementGuides ?? []).map((guide) => ({
      sourceId: guide.id,
      entity: {
        kind: 'measurement-guide',
        id: guide.id,
        locked: guide.locked === true,
        start: { ...guide.start },
        end: { ...guide.end },
      },
    })),
    groups: stamp.groups.map((group) => ({
      sourceId: group.id,
      entity: {
        kind: 'group',
        id: group.id,
        locked: false,
        name: group.name,
        members: group.members.map((member) => ({ ...member })),
      },
    })),
  }
}

function scenePlantFromSavedPlant(
  plant: SavedObjectStampPayload['plants'][number],
): ScenePlantEntity {
  return {
    kind: 'plant',
    id: plant.id,
    locked: plant.locked === true,
    canonicalName: plant.canonicalName,
    commonName: plant.commonName,
    color: plant.color,
    symbol: plant.symbol ?? null,
    canopySpreadM: plant.scale,
    position: { ...plant.position },
    rotationDeg: plant.rotationDeg,
    notes: plant.notes ?? null,
    plantedDate: plant.plantedDate ?? null,
    quantity: plant.quantity ?? 1,
    pinnedName: plant.pinnedName === true,
  }
}

function sceneZoneFromSavedZone(
  zone: SavedObjectStampPayload['zones'][number],
): SceneZoneEntity {
  return {
    kind: 'zone',
    id: zone.id,
    name: zone.name,
    locked: zone.locked === true,
    zoneType: zone.zoneType,
    points: zone.points.map((point) => ({ ...point })),
    rotationDeg: zone.rotationDeg,
    fillColor: zone.fillColor,
    ...(zone.strokeColor !== undefined ? { strokeColor: zone.strokeColor } : {}),
    ...(zone.opacity !== undefined ? { opacity: zone.opacity } : {}),
    notes: zone.notes ?? null,
  }
}

function sceneAnnotationFromSavedAnnotation(
  annotation: SavedObjectStampPayload['annotations'][number],
): SceneAnnotationEntity {
  return {
    kind: 'annotation',
    id: annotation.id,
    locked: annotation.locked === true,
    annotationType: annotation.annotationType,
    position: { ...annotation.position },
    text: annotation.text,
    fontSize: annotation.fontSize,
    rotationDeg: annotation.rotationDeg,
    ...(annotation.color !== undefined ? { color: annotation.color } : {}),
  }
}
