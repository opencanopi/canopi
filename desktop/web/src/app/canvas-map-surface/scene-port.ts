/**
 * app/canvas-map-surface/scene-port.ts: Neutral ScenePort adapter over CanvasDocumentSurface
 * shared by Desktop, Web and Gallery (C3, ADR 0024, contracts §4).
 */
import {
  createCanvasDocumentReplacementToken,
  type CanvasDocumentSurface,
} from '../../canvas/runtime/runtime'
import type { CanopiFile } from '../../types/design'
import type { SceneKey, ScenePort } from '../document-session/core'

export function scenePortOf(documents: CanvasDocumentSurface): ScenePort {
  return {
    serialize: () => documents.serializeSceneFields() as Pick<CanopiFile, SceneKey>,
    load: (file) => {
      documents.replaceDocument(
        file as Parameters<CanvasDocumentSurface['replaceDocument']>[0],
        createCanvasDocumentReplacementToken(),
        () => {},
      )
      documents.zoomToFit()
    },
    replay: (command, direction) => {
      documents.replaySceneCommand(command, direction)
    },
  }
}
