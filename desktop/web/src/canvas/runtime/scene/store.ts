import type { GeoPoint, CanopiFile } from '../../../types/design'
import { signal, type ReadonlySignal, type Signal } from '@preact/signals'
import {
  type ScenePersistedState,
  type SceneSessionState,
} from './types'
import { allocateSpeciesCodes } from '../species-key'
import {
  cloneScenePersistedState,
  cloneSceneSessionState,
  hydrateSceneFromDesign,
  type SceneSerializeOptions,
  serializeScenePersistedState,
} from './codec'
import { ScenePlaneReprojector } from './geo-frame'
import { createSessionPlane, DEFAULT_NEW_DESIGN_VIEW, type SessionPlane } from '../../../geo/session-plane'
import {
  createDefaultScenePersistedState,
  createDefaultSceneSessionState,
} from './defaults'
import {
  cloneSceneDesignObjectTarget,
  normalizeSceneDesignObjectTargets,
  type SceneDesignObjectTarget,
} from './design-object-targets'

/** Whether a Scene holds any plant, note, measurement guide, or zone with a point. */
function sceneHasObjects(scene: ScenePersistedState): boolean {
  return scene.plants.length > 0
    || scene.annotations.length > 0
    || scene.measurementGuides.length > 0
    || scene.zones.some((zone) => zone.points.length > 0)
}

/** Deep-freezes a state the store now holds (or a read model of it), in dev builds only, so a write into it throws. */
export function freezeInDev<T extends object>(state: T): T {
  if (import.meta.env.DEV) deepFreeze(state)
  return state
}

function deepFreeze(value: object): void {
  if (Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') deepFreeze(child)
  }
}

/**
 * Holds the Scene as immutable state: reads hand out the stored object (frozen in dev builds), and each update copies
 * it once, lets the mutator write into the copy and keeps that copy, so a Scene read before an edit (undo's
 * before-state included) never changes.
 */
export class SceneStore {
  private _persisted: ScenePersistedState
  private _session: SceneSessionState
  private readonly _plane: Signal<SessionPlane>
  private readonly _resolveEmptyOrigin: () => GeoPoint

  /** `emptyOrigin` places the session plane of a Design without objects; a Design loads through hydrate. */
  constructor(emptyOrigin: () => GeoPoint = () => DEFAULT_NEW_DESIGN_VIEW) {
    this._resolveEmptyOrigin = emptyOrigin
    this._persisted = freezeInDev(createDefaultScenePersistedState())
    this._plane = signal(createSessionPlane(this._resolveEmptyOrigin()))
    this._session = freezeInDev(createDefaultSceneSessionState())
  }

  get persisted(): Readonly<ScenePersistedState> {
    return this._persisted
  }

  // The runtime's metre frame for this Design, which serialization and re-origin use; replaced on hydrate and re-origin.
  get sessionPlane(): SessionPlane {
    return this._plane.peek()
  }

  // Published on hydrate and re-origin for map and LiDAR consumers.
  get sessionPlaneSignal(): ReadonlySignal<SessionPlane | null> {
    return this._plane
  }

  /** sceneHasObjects of the Scene, read without copying it. */
  get hasObjects(): boolean {
    return sceneHasObjects(this._persisted)
  }

  get session(): Readonly<SceneSessionState> {
    return this._session
  }

  hydrate(file: CanopiFile): this {
    const hydrated = hydrateSceneFromDesign(file, this._resolveEmptyOrigin())
    this._persisted = freezeInDev(hydrated.persisted)
    this._session = freezeInDev(createDefaultSceneSessionState())
    this._plane.value = hydrated.plane
    return this
  }

  /**
   * Starts a re-origin at `origin`; commitReorigin moves the scene, and the caller re-projects history with the same
   * reprojector.
   */
  beginReorigin(origin: GeoPoint): ScenePlaneReprojector {
    return new ScenePlaneReprojector(this.sessionPlane, origin)
  }

  commitReorigin(reprojector: ScenePlaneReprojector): this {
    this._persisted = freezeInDev(reprojector.persisted(this._persisted))
    this._plane.value = reprojector.next
    return this
  }

  /** A new species gets its code here, at commit. */
  updatePersisted(mutator: (draft: ScenePersistedState) => void): this {
    const draft = cloneScenePersistedState(this._persisted)
    mutator(draft)
    draft.plantSpeciesCodes = allocateSpeciesCodes(draft.plantSpeciesCodes, draft.plants.map((plant) => plant.canonicalName))
    this._persisted = freezeInDev(draft)
    return this
  }

  updateSession(mutator: (draft: SceneSessionState) => void): this {
    const draft = cloneSceneSessionState(this._session)
    mutator(draft)
    this._session = freezeInDev(draft)
    return this
  }

  setSelection(targets: Iterable<SceneDesignObjectTarget>): this {
    this._session = freezeInDev({
      ...this._session,
      selectedTargets: normalizeSceneDesignObjectTargets(targets),
    })
    return this
  }

  setHoveredTarget(target: SceneDesignObjectTarget | null): this {
    this._session = freezeInDev({
      ...this._session,
      hoveredTarget: target ? cloneSceneDesignObjectTarget(target) : null,
    })
    return this
  }

  toCanopiFile(options: SceneSerializeOptions = {}): CanopiFile {
    return serializeScenePersistedState(this._persisted, this.sessionPlane, options)
  }
}

export type SceneStateReader = Pick<
  SceneStore,
  'persisted' | 'session' | 'hasObjects' | 'sessionPlane' | 'sessionPlaneSignal'
>
export type SceneDocumentReader = Pick<SceneStore, 'toCanopiFile'>
export type SceneSessionWriter = Pick<
  SceneStore,
  'setSelection' | 'setHoveredTarget'
>
