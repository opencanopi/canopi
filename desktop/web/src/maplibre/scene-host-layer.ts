// maplibre/scene-host-layer.ts  (L1)
//
// MapLibre custom-layer host for a ScenePainter (contracts §6, ADR 0004, ADR 0022 L7).
// Imports nothing from canvas/ or pixi.js; owns the phase machine, MapLibre canvas size
// contract, one paint per eligible frame, teardown order and presentFor(view).

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl'
import type { ViewFrameSource, ViewTransform } from '../geo/view/types'
import { reportMapError } from './map-errors'

/** The one production custom layer which all map-owned raster bands sit below. */
export const MAPLIBRE_SHARED_SCENE_LAYER_ID = 'canopi-shared-scene'

/** Narrow MapLibre port required by the scene host layer. */
export type SceneHostMap = Pick<MapLibreMap, 'getCanvas' | 'triggerRepaint'> & {
  on?(type: string, listener: (event?: unknown) => void): unknown
  off?(type: string, listener: (event?: unknown) => void): unknown
}

interface ScenePainterSize {
  readonly width: number
  readonly height: number
  readonly resolution: number
}

interface ScenePainterSurface {
  readonly canvas: HTMLCanvasElement
  readonly context: WebGL2RenderingContext
  readonly size: ScenePainterSize
  readonly requestRepaint: () => void
}

interface ScenePainterFrame<Snapshot> {
  readonly view: ViewTransform
  readonly snapshot?: Snapshot
  readonly settled: boolean
}

/**
 * Inversion port between MapLibre's custom layer (L7) and the scene renderer (L8, Pixi).
 * `paint` draws inside MapLibre's frame and never clears; `dispose` releases renderer
 * resources without losing the shared WebGL2 context (ADR 0004).
 */
export interface ScenePainter<Snapshot, Draft = never> {
  init(surface: ScenePainterSurface): Promise<void>
  resize(size: ScenePainterSize): void
  paint(frame: ScenePainterFrame<Snapshot>): void
  setDraft?(draft: Draft): void
  dispose(): void
}

type SceneHostPhase =
  | 'new'
  | 'initializing'
  | 'initialized'
  | 'attached'
  | 'disposing'
  | 'disposed'
  | 'failed'

export interface SceneHostLayerOptions<Snapshot, Draft = never> {
  readonly id: string
  readonly frames: Pick<ViewFrameSource, 'viewFrame'> & Partial<Pick<ViewFrameSource, 'settledViewFrame'>>
  readonly painter: ScenePainter<Snapshot, Draft>
  readonly onAttached?: (layer: SceneHostLayer<Snapshot, Draft>) => (() => void) | void
  readonly onFailure?: (error: Error) => void
}

export interface SceneHostLayer<Snapshot, Draft = never> {
  readonly layer: CustomLayerInterface
  readonly phase: SceneHostPhase
  /** Initialize before adding the custom layer; never runs from onAdd. */
  initialize(map: SceneHostMap, gl: WebGL2RenderingContext): Promise<void>
  /** Stores a scene update and asks MapLibre for the next eligible frame. */
  setSnapshot(snapshot: Snapshot): void
  /** Forwards a live tool draft to the painter and asks for a frame. */
  setDraft(draft: Draft): void
  /** Asks MapLibre for a frame without replacing the current snapshot. */
  requestRender(): void
  /** Resolves on the MapLibre `render` event after this layer has presented `view`; rejects on failure or dispose. */
  presentFor(view: ViewTransform): Promise<void>
  /** True synchronously once the latest snapshot has been painted for `view` in the current frame. */
  hasPresented(view: ViewTransform): boolean
  /** Final owner teardown right before MapLibre removes the map. */
  dispose(): Promise<void>
}

interface PresentWaiter {
  readonly view: ViewTransform
  presented: boolean
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

export function createSceneHostLayer<Snapshot, Draft = never>(
  options: SceneHostLayerOptions<Snapshot, Draft>,
): SceneHostLayer<Snapshot, Draft> {
  const { painter } = options
  let phase: SceneHostPhase = 'new'
  let map: SceneHostMap | null = null
  let context: WebGL2RenderingContext | null = null
  let canvas: HTMLCanvasElement | null = null
  let pendingSnapshot: Snapshot | null = null
  let hasRenderedSnapshot = false
  let lastPresentedView: ViewTransform | null = null
  let initializePromise: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null
  let rendererSize: ScenePainterSize | null = null
  let failureReported = false
  let lastError: Error | null = null
  let detachAttached: (() => void) | undefined
  let renderListenerAttached = false
  const presentWaiters: PresentWaiter[] = []

  const stopSettleRepaints = options.frames.settledViewFrame?.subscribe(() => requestRepaint()) ?? (() => {})

  const rejectWaiters = (error: Error): void => {
    while (presentWaiters.length > 0) {
      presentWaiters.shift()!.reject(error)
    }
  }

  const flushPresentedWaiters = (): void => {
    for (let i = presentWaiters.length - 1; i >= 0; i -= 1) {
      if (presentWaiters[i]!.presented) {
        const [waiter] = presentWaiters.splice(i, 1)
        waiter!.resolve()
      }
    }
  }

  const onMapRender = (): void => {
    flushPresentedWaiters()
  }

  const fail = (failure: string | Error): void => {
    const error = failure instanceof Error ? failure : new Error(failure)
    lastError = error
    if (phase === 'disposing' || phase === 'disposed') {
      rejectWaiters(error)
      return
    }
    phase = 'failed'
    rejectWaiters(error)
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
      if (nextMap !== map || gl !== context || phase !== 'initialized') {
        fail('MapLibre attached a layer that was not initialized for this map context.')
        return
      }
      phase = 'attached'
      const cleanup = options.onAttached?.(host)
      if (typeof cleanup === 'function') detachAttached = cleanup
    },
    render(gl: WebGL2RenderingContext, _input: CustomRenderMethodInput) {
      if (gl !== context || phase !== 'attached' || !map) return
      if (pendingSnapshot === null && !hasRenderedSnapshot) return
      const nextSize = syncMapLibreOwnedSize(canvas, painter, rendererSize)
      if (!nextSize) {
        fail('MapLibre canvas backing size changed outside the shared renderer contract.')
        return
      }
      rendererSize = nextSize
      const { view } = options.frames.viewFrame.peek()
      const settled = !options.frames.settledViewFrame || options.frames.settledViewFrame.peek().view === view
      try {
        if (pendingSnapshot !== null) {
          const snapshot = pendingSnapshot
          pendingSnapshot = null
          hasRenderedSnapshot = true
          painter.paint({ view, snapshot, settled })
        } else {
          painter.paint({ view, settled })
        }
        markWaitersPresented(view)
      } catch (error) {
        fail(error instanceof Error ? error : 'Shared map scene rendering failed.')
      }
    },
  } satisfies CustomLayerInterface

  const host: SceneHostLayer<Snapshot, Draft> = {
    layer,
    get phase() { return phase },
    async initialize(nextMap, gl) {
      if (phase === 'failed') {
        throw lastError ?? new Error('Cannot initialize a failed shared map scene layer.')
      }
      if (phase === 'disposed' || phase === 'disposing') {
        throw new Error('Cannot initialize a disposed shared map scene layer.')
      }
      if (initializePromise) {
        if (nextMap !== map || gl !== context) {
          throw new Error('Shared map scene layer is already bound to another map context.')
        }
        return initializePromise
      }
      map = nextMap
      context = gl
      canvas = nextMap.getCanvas()
      if (typeof nextMap.on === 'function') {
        nextMap.on('render', onMapRender)
        renderListenerAttached = true
      }
      const size = getMapLibreCanvasSize(canvas)
      if (!size) {
        const error = new Error('MapLibre canvas has no stable CSS-pixel backing size for shared rendering.')
        fail(error)
        throw error
      }
      phase = 'initializing'
      const initialBackingSize = { width: canvas.width, height: canvas.height }
      initializePromise = painter.init({
        canvas,
        context: gl,
        size,
        requestRepaint,
      }).then(() => {
        if (canvas?.width !== initialBackingSize.width || canvas.height !== initialBackingSize.height) {
          throw new Error('Scene painter initialization changed MapLibre canvas backing dimensions.')
        }
        rendererSize = size
        if (disposePromise) return
        phase = 'initialized'
      }).catch((error: unknown) => {
        fail(error instanceof Error ? error : 'Shared map scene initialization failed.')
        throw error
      })
      return initializePromise
    },
    setSnapshot(nextSnapshot) {
      if (phase === 'disposed' || phase === 'disposing' || phase === 'failed') return
      pendingSnapshot = nextSnapshot
      lastPresentedView = null
      requestRepaint()
    },
    setDraft(nextDraft) {
      if (phase === 'disposed' || phase === 'disposing' || phase === 'failed') return
      painter.setDraft?.(nextDraft)
      requestRepaint()
    },
    requestRender() {
      if (phase === 'disposed' || phase === 'disposing' || phase === 'failed') return
      requestRepaint()
    },
    presentFor(view) {
      if (phase === 'failed') {
        return Promise.reject(lastError ?? new Error('Shared map scene layer has failed.'))
      }
      if (phase === 'disposing' || phase === 'disposed') {
        return Promise.reject(new Error('Shared map scene layer was disposed before presenting.'))
      }
      return new Promise<void>((resolve, reject) => {
        presentWaiters.push({ view, presented: false, resolve, reject })
        requestRepaint()
      })
    },
    hasPresented(view) {
      return lastPresentedView === view && pendingSnapshot === null && hasRenderedSnapshot
    },
    dispose() {
      detachAttached?.()
      detachAttached = undefined
      if (disposePromise) return disposePromise
      phase = 'disposing'
      rejectWaiters(new Error('Shared map scene layer was disposed before presenting.'))
      disposePromise = (initializePromise ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          try {
            painter.dispose()
          } finally {
            finishDispose()
          }
        })
      return disposePromise
    },
  }
  return host

  function markWaitersPresented(view: ViewTransform): void {
    lastPresentedView = view
    let anyMarked = false
    for (const waiter of presentWaiters) {
      if (waiter.view === view) {
        waiter.presented = true
        anyMarked = true
      }
    }
    if (anyMarked && !renderListenerAttached) {
      queueMicrotask(flushPresentedWaiters)
    }
  }

  function requestRepaint(): void {
    if (!map) return
    map.triggerRepaint()
  }

  function finishDispose(): void {
    phase = 'disposed'
    if (renderListenerAttached && map && typeof map.off === 'function') {
      map.off('render', onMapRender)
    }
    renderListenerAttached = false
    pendingSnapshot = null
    hasRenderedSnapshot = false
    lastPresentedView = null
    stopSettleRepaints()
    map = null
    context = null
    canvas = null
    rendererSize = null
  }
}

function getMapLibreCanvasSize(canvas: HTMLCanvasElement): ScenePainterSize | null {
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

function syncMapLibreOwnedSize<Snapshot, Draft>(
  canvas: HTMLCanvasElement | null,
  painter: ScenePainter<Snapshot, Draft>,
  current: ScenePainterSize | null,
): ScenePainterSize | null {
  const size = canvas ? getMapLibreCanvasSize(canvas) : null
  if (!canvas || !size) return null
  if (sameSize(current, size)) return size
  const expectedWidth = Math.round(size.width * size.resolution)
  const expectedHeight = Math.round(size.height * size.resolution)
  if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) return null
  const before = { width: canvas.width, height: canvas.height }
  painter.resize(size)
  return canvas.width === before.width && canvas.height === before.height ? size : null
}

function sameSize(left: ScenePainterSize | null, right: ScenePainterSize): boolean {
  return left?.width === right.width
    && left.height === right.height
    && left.resolution === right.resolution
}
