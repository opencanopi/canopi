// canvas/runtime/renderers/pixi-scene-painter.ts  (L2)
//
// The one PixiJS ScenePainter implementation (contracts §6, ADR 0004, ADR 0022 L8).
// Draws inside MapLibre's shared WebGL2 context and frame loop, never clears the context,
// stops Pixi's system ticker and canvas event listeners, and suppresses loseContext on dispose.

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
// The one extension registered here (skipExtensionImports leaves it out): plant layer opacity,
// species dim and placement ghosts draw through an AlphaFilter.
import 'pixi.js/filters'
import { Container, Text, Ticker, WebGLRenderer, type WebGLOptions } from 'pixi.js'
import type { ViewTransform } from '../../../geo/view/types'
import type { DraftPresentation } from '../tools/draft'
import { createPixiScenePresentation, type PixiScenePresentation } from './pixi-scene'
import type { SceneRendererSnapshot } from './scene-types'

interface PixiScenePainterSize {
  readonly width: number
  readonly height: number
  readonly resolution: number
}

interface PixiScenePainterSurface {
  readonly canvas: HTMLCanvasElement
  readonly context: WebGL2RenderingContext
  readonly size: PixiScenePainterSize
  readonly requestRepaint: () => void
}

interface PixiScenePainterFrame {
  readonly view: ViewTransform
  readonly snapshot?: SceneRendererSnapshot
  readonly settled: boolean
}

interface PixiScenePainter {
  init(surface: PixiScenePainterSurface): Promise<void>
  resize(size: PixiScenePainterSize): void
  paint(frame: PixiScenePainterFrame): void
  setDraft(draft: DraftPresentation | null): void
  dispose(): void
}

/** Pixi's real renderer options, so the painter's choices are checked against them. */
type SharedPixiRendererInitOptions = Partial<WebGLOptions>

interface SharedPixiRenderer {
  init(options: SharedPixiRendererInitOptions): Promise<void>
  render(options: { readonly container: Container; readonly clear: false }): void
  resize(width: number, height: number, resolution: number): void
  resetState(): void
  destroy(options: { readonly removeView: false }): void
  readonly context: { readonly extensions: { loseContext?: { loseContext(): void } } }
  readonly events?: { setTargetElement(element: HTMLElement | null): void }
}

interface SharedPixiRendererView {
  readonly canvas: HTMLCanvasElement
  readonly context: WebGL2RenderingContext
  readonly width: number
  readonly height: number
  readonly resolution: number
}

/**
 * Pixi draws inside MapLibre's context and frame loop (ADR 0004): it imports no extensions
 * except filters, clears nothing, collects no GPU resources on a schedule of its own, and
 * takes no DOM events.
 */
function sharedPixiRendererInitOptions(view: SharedPixiRendererView): SharedPixiRendererInitOptions {
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

function detachPixiFromHost(renderer: SharedPixiRenderer): void {
  renderer.events?.setTargetElement(null)
  Ticker.system.stop()
}

export function createPixiScenePainter(): PixiScenePainter {
  let renderer: SharedPixiRenderer | null = null
  let stage: Container | null = null
  let presentation: PixiScenePresentation | null = null
  let pendingDraft: DraftPresentation | null = null
  let hasPendingDraft = false
  let presentedView: ViewTransform | null = null
  let presentedSettled = false
  let currentSize: PixiScenePainterSize | null = null

  return {
    async init(surface: PixiScenePainterSurface): Promise<void> {
      const nextRenderer: SharedPixiRenderer = new WebGLRenderer()
      renderer = nextRenderer
      try {
        await nextRenderer.init(sharedPixiRendererInitOptions({
          canvas: surface.canvas,
          context: surface.context,
          width: surface.size.width,
          height: surface.size.height,
          resolution: surface.size.resolution,
        }))
      } finally {
        detachPixiFromHost(nextRenderer)
      }
      currentSize = surface.size
      stage = new Container()
      presentation = createPixiScenePresentation({
        stage,
        createText: () => new Text({ resolution: surface.size.resolution * 2 }),
        viewSize: { width: surface.size.width, height: surface.size.height },
        requestRepaint: surface.requestRepaint,
      })
      if (hasPendingDraft) {
        presentation.setDraft(pendingDraft)
      }
    },
    resize(size: PixiScenePainterSize): void {
      currentSize = size
      renderer?.resize(size.width, size.height, size.resolution)
      presentation?.resize(size.width, size.height)
    },
    paint(frame: PixiScenePainterFrame): void {
      if (!renderer || !stage || !presentation) return
      renderer.resetState()
      if (currentSize) presentation.resize(currentSize.width, currentSize.height)
      if (frame.snapshot !== undefined) {
        presentation.present(frame.view, frame.snapshot, frame.settled)
      } else if (frame.view !== presentedView || (frame.settled && !presentedSettled)) {
        presentation.present(frame.view, undefined, frame.settled)
      }
      presentedView = frame.view
      presentedSettled = frame.settled
      renderer.render({ container: stage, clear: false })
    },
    setDraft(draft: DraftPresentation | null): void {
      pendingDraft = draft
      hasPendingDraft = true
      presentation?.setDraft(draft)
    },
    dispose(): void {
      presentation?.dispose()
      presentation = null
      stage?.destroy({ children: true })
      stage = null
      if (renderer) {
        // Pixi's GlContextSystem.destroy() always calls loseContext(). Suppress that
        // one teardown action so MapLibre's shared WebGL2 context survives dispose.
        delete renderer.context.extensions.loseContext
        renderer.destroy({ removeView: false })
        renderer = null
      }
      pendingDraft = null
      hasPendingDraft = false
      presentedView = null
      presentedSettled = false
      currentSize = null
    },
  }
}
