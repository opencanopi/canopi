// app/canvas-map-surface/scene-layer-factory.ts  (L3)
//
// Composition helper wiring the L1 MapLibre SceneHostLayer with the L2 Pixi ScenePainter (contracts §6).

import type { ViewFrameSource } from '../../geo/view/types'
import {
  createSceneHostLayer,
  type SceneHostLayer,
  type ScenePainter,
} from '../../maplibre/scene-host-layer'
import { createPixiScenePainter } from '../../canvas/runtime/renderers/pixi-scene-painter'
import type { SceneRendererSnapshot, SceneRenderTarget } from '../../canvas/runtime/renderers/scene-types'
import type { DraftPresentation } from '../../canvas/runtime/tools/draft'

export type PixiSceneHostLayer = SceneHostLayer<SceneRendererSnapshot, DraftPresentation | null>

interface SceneLayerFactoryOptions {
  readonly id: string
  readonly frames: Pick<ViewFrameSource, 'viewFrame'> & Partial<Pick<ViewFrameSource, 'settledViewFrame'>>
  readonly onFailure?: (error: Error) => void
}

export interface SceneLayerFactory {
  createLayer(options: SceneLayerFactoryOptions): PixiSceneHostLayer
}

export function createSceneLayerFactory(
  connectRenderTarget: (target: SceneRenderTarget) => () => void,
): SceneLayerFactory {
  return {
    createLayer(options) {
      const painter: ScenePainter<SceneRendererSnapshot, DraftPresentation | null> = createPixiScenePainter()
      return createSceneHostLayer({
        id: options.id,
        frames: options.frames,
        ...(options.onFailure ? { onFailure: options.onFailure } : {}),
        painter,
        onAttached: (layer) => connectRenderTarget(layer),
      })
    },
  }
}
