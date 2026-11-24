import type { ReadonlySignal } from '@preact/signals'
import type { CanopiFile, SavedViewCamera } from '../../types/design'
import { savedViewCameraOf, savedViewZoom } from '../saved-view-framing'
import { geographicViewOfCamera } from '../../geo/session-plane'
import {
  CanvasAuthorityBusyError,
  CanvasDocumentReplacementNotAdmittedError,
  type CanvasDocumentReplacementReceipt,
  type CanvasDocumentReplacementToken,
  type CanvasDocumentSurface,
  type CanvasPersistenceCapture,
  type CanvasRuntimeDocumentMetadata,
} from './runtime'
import type { SceneRuntimeDocumentBridge } from './scene-runtime/document'
import type { SceneRuntimeRenderScheduler } from './scene-runtime/render-scheduler'
import { runCanvasRuntimeCleanups } from './cleanup'
import type { CanvasInspectionHandle } from '../inspection'
import type { SceneCanvasInspectionOwner } from './inspection-lens'
import type { CameraDriverHost } from '../../geo/view/camera-driver'
import type { ViewNavigation } from '../../geo/view/navigation'
import type { ViewCamera } from '../../geo/view/types'

interface SceneCanvasDocumentSurfaceOptions {
  readonly inspection: Pick<SceneCanvasInspectionOwner, 'mount' | 'reset' | 'dispose'>
  readonly documents: Pick<
    SceneRuntimeDocumentBridge,
    'loadDocument' | 'replaceDocument' | 'captureForPersistence'
  >
  /** The runtime's camera: a resize reaches its live driver; a save reads its live frame. */
  readonly cameraHost: Pick<CameraDriverHost, 'current' | 'frames'>
  readonly viewNavigation: Pick<ViewNavigation, 'openAt' | 'clearTemporaryFocus'>
  readonly rendering: Pick<
    SceneRuntimeRenderScheduler,
    'container' | 'invalidate' | 'unmount' | 'presented' | 'awaitPresentation'
  >
  /** Shows (true) or hides the Design's canvas chrome: the grid draws only while it shows. */
  readonly setChromeShown: (shown: boolean) => void
  readonly clearHoveredEntity: () => void
  readonly disposeRuntime: () => void
  readonly disposeInteraction: () => void
  readonly disposeCamera: () => void
  readonly disposeEffects: () => void
}

/** The runtime's document role: the app's surface, and the open fit's step in the scene render (construction.ts). */
export interface SceneCanvasDocumentSurface extends CanvasDocumentSurface {
  /** The scene render's first step (render-scheduler.ts): places the camera for a waiting open fit. */
  applyPendingOpen(): void
}

export function createSceneCanvasDocumentSurface(
  options: SceneCanvasDocumentSurfaceOptions,
): SceneCanvasDocumentSurface {
  return new SceneCanvasDocumentRole(options)
}

class SceneCanvasDocumentRole implements SceneCanvasDocumentSurface {
  private _documentState: 'absent' | 'settling' | 'loaded' = 'absent'
  /** The view the open Design's file was saved with (`map_view`), or null. */
  private _savedMapView: SavedViewCamera | null = null
  /** The open fit has placed the camera for the open Design: from then on the live view is the Design's view. */
  private _placed = false
  /** An open fit waits for the next scene render's publish step. */
  private _openPending = false

  constructor(private readonly options: SceneCanvasDocumentSurfaceOptions) {}

  get presented(): ReadonlySignal<boolean> {
    return this.options.rendering.presented
  }

  attachInspectionTo(element: HTMLElement): CanvasInspectionHandle {
    return this.options.inspection.mount(element)
  }

  showCanvasChrome(): void {
    this.options.setChromeShown(true)
  }

  hideCanvasChrome(): void {
    this.options.setChromeShown(false)
  }

  /**
   * The open fit: every open path (the first load, a replace, the first generation) ends here, never Fit to Design. A Design
   * saved with its view (`map_view`, U28) opens at that view's centre and bearing, its framed ground fitted into the whole map
   * by the saved-view rule; any other opens on the fit at the opening bearing (spec §4.15). An empty scene, and the first
   * frame before any Design, open north up (openAt). With a renderer mounted the placement waits for the next scene render,
   * which applies it first (applyPendingOpen), so it frames inside the chrome the opened Design mounts meanwhile and the
   * camera and the scene land in one frame; with none, nothing draws and it places now.
   */
  zoomToFit(): void {
    if (this.options.rendering.container === null) {
      this._open()
      return
    }
    this._openPending = true
    this.options.rendering.invalidate()
  }

  applyPendingOpen(): void {
    if (!this._openPending) return
    this._openPending = false
    this._open()
  }

  private _open(): void {
    if (this._documentState === 'absent') {
      this.options.viewNavigation.openAt(0)
      return
    }
    // A Design without a saved view opens on the fit at the live bearing: north up on the runtime's first open (spec §4.15).
    this.options.viewNavigation.openAt(this.options.cameraHost.current().bearingTarget(), this._savedCamera())
    this._placed = true
  }

  /** The camera the open Design was saved with, framed for the whole map now; null without one. */
  private _savedCamera(): ViewCamera | null {
    const saved = this._savedMapView
    if (!saved) return null
    const { screen } = this.options.cameraHost.frames.viewFrame.peek().view
    return {
      center: { lon: saved.lon, lat: saved.lat },
      zoom: savedViewZoom(saved, screen),
      bearingDeg: saved.bearing,
      pitchDeg: 0,
    }
  }

  /**
   * The view a save writes (`map_view`): the live view once the open fit has placed the camera on a map with a size, else the
   * view the file was saved with. A camera move never edits the Design: it reaches the file only with the next save.
   */
  private _mapViewForSave(): SavedViewCamera | null {
    const { view } = this.options.cameraHost.frames.viewFrame.peek()
    if (!this._placed) return this._savedMapView
    return savedViewCameraOf(geographicViewOfCamera(view.camera), view.screen) ?? this._savedMapView
  }

  private _opened(file: CanopiFile): void {
    this._documentState = 'loaded'
    this._savedMapView = file.map_view ?? null
    this._placed = false
    this._openPending = false
    this.options.rendering.awaitPresentation()
    this.options.viewNavigation.clearTemporaryFocus()
    this.options.inspection.reset()
  }

  loadDocument(file: CanopiFile): void {
    const previousDocumentState = this._documentState
    this._documentState = 'settling'
    try {
      this.options.documents.loadDocument(file)
    } catch (error) {
      // Refused before touching the Scene (an edit still owns it): the
      // previous document is intact and stays saveable.
      if (error instanceof CanvasAuthorityBusyError) this._documentState = previousDocumentState
      throw error
    }
    this._opened(file)
  }

  replaceDocument(
    file: CanopiFile,
    token: CanvasDocumentReplacementToken,
    finalizeReplacement: () => void,
  ): CanvasDocumentReplacementReceipt {
    const previousDocumentState = this._documentState
    this._documentState = 'settling'
    try {
      const receipt = this.options.documents.replaceDocument(file, token, finalizeReplacement)
      this._opened(file)
      return receipt
    } catch (error) {
      if (error instanceof CanvasDocumentReplacementNotAdmittedError) {
        this._documentState = previousDocumentState
      }
      throw error
    }
  }

  hasLoadedDocument(): boolean {
    return this._documentState !== 'absent'
  }

  captureForPersistence(
    metadata: CanvasRuntimeDocumentMetadata,
    doc: CanopiFile,
  ): CanvasPersistenceCapture {
    if (this._documentState === 'settling') {
      throw new CanvasAuthorityBusyError('document-settlement')
    }
    return this.options.documents.captureForPersistence(metadata, doc, this._mapViewForSave())
  }

  /** The camera takes the new screen; its frame repaints the layer, which MapLibre has already resized. */
  resize(width: number, height: number): void {
    this.options.cameraHost.current().setScreen({ width, height, devicePixelRatio: window.devicePixelRatio })
  }

  destroy(): void {
    runCanvasRuntimeCleanups([
      () => this.options.inspection.dispose(),
      () => this.options.disposeRuntime(),
      () => this.options.clearHoveredEntity(),
      () => this.options.disposeInteraction(),
      () => this.options.disposeEffects(),
      () => this.options.disposeCamera(),
      () => this.options.rendering.unmount(),
    ], 'Scene Canvas document surface disposal failed')
  }
}
