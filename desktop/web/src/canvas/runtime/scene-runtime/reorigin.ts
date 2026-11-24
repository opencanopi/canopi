import type { SceneStateReader } from '../scene'
import type { ViewFrame } from '../../../geo/view/types'
import { planarCameraOf } from '../../../geo/view/view-transform'
import type { SceneCommandAdmission, SceneRuntimeEditCoordinator } from './transactions'

interface SceneRuntimeReoriginOptions {
  readonly sceneState: Pick<SceneStateReader, 'sessionPlane'>
  readonly authority: Pick<SceneRuntimeEditCoordinator, 'reoriginSessionPlane'>
  readonly commandAdmission: SceneCommandAdmission
  /** The tool host's hold (ToolHost.holdsReorigin): a live press, a tool transient or an open text entry. */
  readonly held: () => boolean
}

/** Placements this close are the same: a micropixel, and a billionth of the scale. */
const SAME_PLACEMENT_PX = 1e-6
const SAME_SCALE_RATIO = 1e-9

/** What the controller last looked at: a frame that keeps all of it (a hydration, an inset change) is not observed. */
interface ObservedFrame {
  readonly x: number
  readonly y: number
  readonly scale: number
  readonly bearingDeg: number
  readonly width: number
  readonly height: number
  readonly mode: ViewFrame['mode']
}

/**
 * Decides when to rebuild the session plane: once a settled site-scale view
 * centre is more than 10 km from the plane origin. The Settled Scene Authority
 * performs the plane change; while it does, `reoriginating` is true, so the
 * runtime's plane effect moves the camera into the new plane with its ground
 * kept. The clipboard remaps itself on paste. Re-origin waits while the tool
 * host holds it (spec §4.19), so no tool re-projects a world point it keeps;
 * resume() observes the live frame once the hold clears.
 */
export class SceneRuntimeReoriginController {
  private scheduled = false
  private disposed = false
  private _reoriginating = false
  private last: ObservedFrame | null = null
  /** Whether a hold turned a frame away. */
  private waiting = false

  constructor(private readonly options: SceneRuntimeReoriginOptions) {}

  /** True while the authority commits a re-origin's plane. */
  get reoriginating(): boolean {
    return this._reoriginating
  }

  observe(frame: ViewFrame): void {
    if (this.disposed) return
    if (this.options.held()) {
      this.waiting = true
      return
    }
    if (this.unchanged(frame) || this.scheduled || frame.mode !== 'site') return
    const { screen } = frame.view
    // The ground under the screen centre, whatever the bearing.
    const centre = frame.view.screenToWorld({ x: screen.width / 2, y: screen.height / 2 })
    if (![centre.x, centre.y].every(Number.isFinite)) return
    if (!this.options.sceneState.sessionPlane.needsReorigin(centre)) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed) return
      this.options.commandAdmission.runWhenSettled(() => this.reoriginAt(centre), undefined)
    })
  }

  /** The hold may have cleared: after a frame it turned away, the live frame (the camera host's) is observed now, so a long
   *  pan during a draft re-origins at once. */
  resume(frame: ViewFrame): void {
    if (this.disposed || !this.waiting || this.options.held()) return
    this.waiting = false
    this.last = null
    this.observe(frame)
  }

  dispose(): void {
    this.disposed = true
  }

  /**
   * Records the frame and says whether it keeps the placement, screen size and mode of the last one seen. The placement is read
   * back from a geographic camera, so a frame that keeps it (a hydration in another plane) can differ in its last bits.
   */
  private unchanged(frame: ViewFrame): boolean {
    const { x, y, scale, bearingDeg } = planarCameraOf(frame.view)
    const { width, height } = frame.view.screen
    const next: ObservedFrame = { x, y, scale, bearingDeg, width, height, mode: frame.mode }
    const last = this.last
    this.last = next
    return last !== null
      && Math.abs(last.x - next.x) <= SAME_PLACEMENT_PX
      && Math.abs(last.y - next.y) <= SAME_PLACEMENT_PX
      && Math.abs(last.scale - next.scale) <= SAME_SCALE_RATIO * last.scale
      && last.bearingDeg === next.bearingDeg
      && last.width === next.width
      && last.height === next.height
      && last.mode === next.mode
  }

  private reoriginAt(centre: { readonly x: number; readonly y: number }): void {
    const plane = this.options.sceneState.sessionPlane
    if (!plane.needsReorigin(centre)) return
    if (this.options.held()) {
      this.waiting = true
      return
    }
    this._reoriginating = true
    try {
      this.options.authority.reoriginSessionPlane(plane.toGeo(centre))
    } finally {
      this._reoriginating = false
    }
  }
}
