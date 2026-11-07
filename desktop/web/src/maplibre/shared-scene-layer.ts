// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import { reportMapError } from './map-errors'
import 'pixi.js/unsafe-eval'
// The one extension the layer registers itself (skipExtensionImports leaves it out): the plant
// layer's opacity and species dim and the placement ghosts draw through an AlphaFilter.
import 'pixi.js/filters'
import { Container, Text, Ticker, WebGLRenderer, type WebGLOptions } from 'pixi.js'
import type { CustomLayerInterface, CustomRenderMethodInput } from 'maplibre-gl'
import { createPixiScenePresentation, type PixiScenePresentation } from '../canvas/runtime/renderers/pixi-scene'
import type { SceneRendererSnapshot, SceneRenderTarget } from '../canvas/runtime/renderers/scene-types'
import type { ViewFrameSource, ViewTransform } from '../canvas/runtime/view/types'

/** The one production custom layer which all map-owned raster bands sit below. */
export const MAPLIBRE_SHARED_SCENE_LAYER_ID = 'canopi-shared-scene'

export interface SharedMapSceneMap {
  getCanvas(): HTMLCanvasElement
  triggerRepaint(): void
}

/** Pixi's real renderer options, so the layer's choices are checked against them. */
export type SharedPixiRendererInitOptions = Partial<WebGLOptions>

export interface SharedPixiRenderer {
  init(options: SharedPixiRendererInitOptions): Promise<void>
  render(options: { readonly container: Container; readonly clear: false }): void
  resize(width: number, height: number, resolution: number): void
  resetState(): void
  destroy(options: { readonly removeView: false }): void
  readonly context: { readonly extensions: { loseContext?: { loseContext(): void } } }
  /** Pixi's event system, which `init` installs on the canvas; the layer detaches it. */
  readonly events?: { setTargetElement(element: HTMLElement | null): void }
}

export interface SharedPixiRendererView {
  readonly canvas: HTMLCanvasElement
  readonly context: WebGL2RenderingContext
  readonly width: number
  readonly height: number
  readonly resolution: number
}

/**
 * Pixi draws inside MapLibre's context and frame loop (ADR 0004): it imports
 * no extensions but the filters (registered above), clears nothing, collects no GPU resources on a schedule of
 * its own, and its containers take no events. Pixi still installs its
 * EventSystem on the canvas and its scheduler on `Ticker.system` during
 * `init`; `detachPixiFromHost` undoes both right after.
 */
export function sharedPixiRendererInitOptions(view: SharedPixiRendererView): SharedPixiRendererInitOptions {
  return {
    ...view,
    autoDensity: false,
    antialias: true,
    backgroundAlpha: 0,
    clearBeforeRender: false,
    premultipliedAlpha: true,
    skipExtensionImports: true,
    eventMode: 'none',
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    textureGCActive: false,
    renderableGCActive: false,
  }
}

/**
 * Canvas input belongs to `DomInputSource`, the only DOM listener on the map
 * (ADR 0017), and MapLibre runs the only frame loop. Pixi's canvas listeners
 * go, and `Ticker.system`, which Pixi's scheduler started, stops; nothing of
 * ours listens on it.
 */
function detachPixiFromHost(renderer: SharedPixiRenderer): void {
  renderer.events?.setTargetElement(null)
  Ticker.system.stop()
}

interface SharedMapSceneDiagnostics {
  readonly phase: 'new' | 'initializing' | 'initialized' | 'attached' | 'disposing' | 'disposed' | 'failed'
  /** Scene snapshots presented so far: the snapshot map waits for one after its capture's scene. */
  readonly sceneSyncCount: number
}

export interface SharedMapSceneLayerOptions {
  readonly id: string
  /**
   * The camera's frames: the runtime's host for the workspace map, the snapshot map's own driver. The layer reads the latest
   * frame in `render` and never derives a transform from the map (spec §1.5). It presents a view whenever the frame's view is a new
   * object, never by revision: the snapshot map's driver keeps none, so all its frames carry revision 0. Its settled frame,
   * when it has one, repaints once and presents its view as settled, so names are admitted at the exact scale at rest;
   * without one (the snapshot map) every frame is settled, so thumbnails are exact.
   */
  readonly frames: Pick<ViewFrameSource, 'viewFrame'> & Partial<Pick<ViewFrameSource, 'settledViewFrame'>>
  readonly onFailure?: (error: Error) => void
  /**
   * Connects the layer to the runtime's one target slot (`connectRenderTarget`) once MapLibre has attached it, until its
   * disposal begins; the workspace map passes it, the snapshot map does not.
   */
  readonly connect?: (target: SceneRenderTarget) => () => void
  readonly createRenderer?: () => SharedPixiRenderer
  readonly createStage?: () => Container
  readonly createPresentation?: (input: {
    readonly stage: Container
    readonly createText: () => Text
    readonly viewSize: { width: number; height: number }
    readonly requestRepaint: () => void
  }) => PixiScenePresentation
}

export interface SharedMapSceneLayer {
  readonly layer: CustomLayerInterface
  readonly diagnostics: SharedMapSceneDiagnostics
  /** Initialize before adding the custom layer; it never runs from onAdd. */
  initialize(map: SharedMapSceneMap, gl: WebGL2RenderingContext): Promise<void>
  /** Stores a scene update and asks MapLibre for the only eligible frame. */
  setSnapshot(snapshot: SceneRendererSnapshot): void
  /**
   * Final owner teardown, right before MapLibre removes the map (nothing reloads its style, ADR 0004): it destroys the
   * renderer at once, after a pending initialization settles, without waiting for a frame.
   */
  dispose(): Promise<void>
}

type Phase = SharedMapSceneDiagnostics['phase']

/**
 * The layer is also the runtime's scene render target (its one slot, `SceneCanvasRuntime.connectRenderTarget`): it keeps
 * the latest snapshot until it draws it, and drops it on dispose. `connect` runs once MapLibre has attached it, so a draft
 * always finds its presentation.
 */
export function createSharedMapSceneLayer(options: SharedMapSceneLayerOptions): SharedMapSceneLayer & SceneRenderTarget {
  let phase: Phase = 'new'
  let map: SharedMapSceneMap | null = null
  let context: WebGL2RenderingContext | null = null
  let canvas: HTMLCanvasElement | null = null
  let renderer: SharedPixiRenderer | null = null
  let stage: Container | null = null
  let presentation: PixiScenePresentation | null = null
  let pendingSnapshot: SceneRendererSnapshot | null = null
  let renderedSnapshot: SceneRendererSnapshot | null = null
  /** The view last given to the presentation, compared by identity (see `frames`), and whether it was settled. */
  let presentedView: ViewTransform | null = null
  let presentedSettled = false
  let initializePromise: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null
  let rendererSize: { width: number; height: number; resolution: number } | null = null
  let sceneSyncCount = 0
  let failureReported = false
  let disconnect: (() => void) | undefined

  // The settled frame keeps the view of the last move, which the layer presented already: one repaint presents it as settled.
  const stopSettleRepaints = options.frames.settledViewFrame?.subscribe(() => requestRepaint()) ?? (() => {})

  const diagnostics = (): SharedMapSceneDiagnostics => ({
    phase,
    sceneSyncCount,
  })

  const fail = (failure: string | Error): void => {
    const error = failure instanceof Error ? failure : new Error(failure)
    phase = 'failed'
    if (failureReported) return
    failureReported = true
    try {
      options.onFailure?.(error)
    } catch (observerError) {
      reportMapError('Shared map scene failure observer failed:', observerError)
    }
  }

  const layer = {
    id: options.id,
    type: 'custom' as const,
    renderingMode: '2d' as const,
    onAdd(nextMap: unknown, gl: WebGL2RenderingContext) {
      if (disposePromise) return
      if (nextMap !== map || gl !== context || !renderer || !presentation) {
        fail('MapLibre attached a layer that was not initialized for this map context.')
        return
      }
      phase = 'attached'
      disconnect ??= options.connect?.(target)
    },
    render(gl: WebGL2RenderingContext, _input: CustomRenderMethodInput) {
      if (gl !== context || !renderer) return
      if (phase !== 'attached' || !map || !stage || !presentation || (!pendingSnapshot && !renderedSnapshot)) return
      const nextSize = syncMapLibreOwnedSize(canvas, renderer, rendererSize)
      if (!nextSize) {
        fail('MapLibre canvas backing size changed outside the shared renderer contract.')
        return
      }
      rendererSize = nextSize
      // The camera published this frame before MapLibre drew (its driver reads the map on 'move'); a resize publishes one too.
      const { view } = options.frames.viewFrame.peek()
      const settled = !options.frames.settledViewFrame || options.frames.settledViewFrame.peek().view === view
      try {
        renderer.resetState()
        presentation.resize(rendererSize.width, rendererSize.height)
        // One present per frame: a new view, the view settling, a new snapshot, or several at once.
        if (pendingSnapshot) {
          renderedSnapshot = pendingSnapshot
          pendingSnapshot = null
          presentation.present(view, renderedSnapshot, settled)
          sceneSyncCount += 1
        } else if (view !== presentedView || (settled && !presentedSettled)) {
          presentation.present(view, undefined, settled)
        }
        presentedView = view
        presentedSettled = settled
        renderer.render({ container: stage, clear: false })
      } catch (error) {
        fail(error instanceof Error ? error : 'Shared map scene rendering failed.')
      }
    },
  } satisfies CustomLayerInterface

  const target: SharedMapSceneLayer & SceneRenderTarget = {
    layer,
    get diagnostics() { return diagnostics() },
    async initialize(nextMap, gl) {
      if (phase === 'disposed') throw new Error('Cannot initialize a disposed shared map scene layer.')
      if (initializePromise) {
        if (nextMap !== map || gl !== context) throw new Error('Shared map scene layer is already bound to another map context.')
        return initializePromise
      }
      map = nextMap
      context = gl
      canvas = nextMap.getCanvas()
      const size = getMapLibreCanvasSize(canvas)
      if (!size) {
        const error = new Error('MapLibre canvas has no stable CSS-pixel backing size for shared rendering.')
        fail(error)
        throw error
      }
      phase = 'initializing'
      const nextRenderer = (options.createRenderer ?? (() => new WebGLRenderer()))()
      renderer = nextRenderer
      const initialBackingSize = { width: canvas.width, height: canvas.height }
      initializePromise = nextRenderer.init(sharedPixiRendererInitOptions({
        canvas,
        context: gl,
        width: size.width,
        height: size.height,
        resolution: size.resolution,
      })).then(() => {
        detachPixiFromHost(nextRenderer)
        if (canvas?.width !== initialBackingSize.width || canvas.height !== initialBackingSize.height) {
          throw new Error('Pixi initialization changed MapLibre canvas backing dimensions.')
        }
        rendererSize = size
        if (disposePromise) return
        stage = (options.createStage ?? (() => new Container()))()
        presentation = (options.createPresentation ?? createPixiScenePresentation)(
          {
            stage,
            createText: () => new Text({ resolution: size.resolution * 2 }),
            viewSize: { width: size.width, height: size.height },
            requestRepaint,
          },
        )
        phase = 'initialized'
      }).catch((error: unknown) => {
        fail(error instanceof Error ? error : 'Shared map scene initialization failed.')
        throw error
      })
      return initializePromise
    },
    setSnapshot(nextSnapshot) {
      if (phase === 'disposed') return
      pendingSnapshot = nextSnapshot
      requestRepaint()
    },
    requestRender() {
      if (phase === 'disposed') return
      requestRepaint()
    },
    setDraft(nextDraft) {
      if (phase === 'disposed') return
      presentation?.setDraft(nextDraft)
      requestRepaint()
    },
    dispose() {
      // Leave the slot first: a disposal that fails must not keep a dead layer as the runtime's target.
      disconnect?.()
      disconnect = undefined
      if (disposePromise) return disposePromise
      phase = 'disposing'
      disposePromise = (initializePromise ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          // A teardown that throws (a lost context) still releases the map and the settle subscription.
          try {
            destroyOwnedResources()
          } finally {
            finishDispose()
          }
        })
      return disposePromise
    },
  }
  return target

  function requestRepaint(): void {
    if (!map) return
    map.triggerRepaint()
  }

  function destroyOwnedResources(): void {
    presentation?.dispose()
    presentation = null
    stage?.destroy({ children: true })
    stage = null
    if (renderer) {
      // Pixi's GlContextSystem.destroy() always calls loseContext(). This is
      // Pixi's own extension registry, so suppress that one teardown action
      // before releasing resources from the MapLibre-owned shared context.
      renderer.context.extensions.loseContext = undefined
      renderer.destroy({ removeView: false })
    }
  }

  function finishDispose(): void {
    phase = 'disposed'
    renderer = null
    pendingSnapshot = null
    renderedSnapshot = null
    presentedView = null
    stopSettleRepaints()
    map = null
    context = null
    canvas = null
    rendererSize = null
  }
}

function getMapLibreCanvasSize(canvas: HTMLCanvasElement): { width: number; height: number; resolution: number } | null {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const widthRange = resolutionRange(width, canvas.width)
  const heightRange = resolutionRange(height, canvas.height)
  const lower = Math.max(widthRange.lower, heightRange.lower)
  const upper = Math.min(widthRange.upper, heightRange.upper)
  if (!(lower < upper)) return null
  const resolution = (lower + upper) / 2
  if (Math.round(width * resolution) !== canvas.width || Math.round(height * resolution) !== canvas.height) return null
  return { width, height, resolution }
}

function resolutionRange(cssPixels: number, backingPixels: number): { lower: number; upper: number } {
  return {
    lower: Math.max(0, (backingPixels - 0.5) / cssPixels),
    upper: (backingPixels + 0.5) / cssPixels,
  }
}

function syncMapLibreOwnedSize(
  canvas: HTMLCanvasElement | null,
  renderer: SharedPixiRenderer,
  current: { width: number; height: number; resolution: number } | null,
): { width: number; height: number; resolution: number } | null {
  const size = canvas ? getMapLibreCanvasSize(canvas) : null
  if (!canvas || !size) return null
  if (sameRendererSize(current, size)) return size
  const expectedWidth = Math.round(size.width * size.resolution)
  const expectedHeight = Math.round(size.height * size.resolution)
  if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) return null
  const before = { width: canvas.width, height: canvas.height }
  renderer.resize(size.width, size.height, size.resolution)
  return canvas.width === before.width && canvas.height === before.height ? size : null
}

function sameRendererSize(
  left: { width: number; height: number; resolution: number } | null,
  right: { width: number; height: number; resolution: number },
): boolean {
  return left?.width === right.width
    && left.height === right.height
    && left.resolution === right.resolution
}
