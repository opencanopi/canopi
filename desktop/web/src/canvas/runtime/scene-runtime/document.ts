import type { CanopiFile, SavedViewCamera } from '../../../types/design'
import { DOCUMENT_FILE_FIELD_OWNERS } from '../../../generated/known-canopi-keys'
import type { SceneCommand } from '../scene-commands'
import { serializeScenePersistedState } from '../scene'
import type {
  CanvasPersistenceCapture,
  CanvasDocumentReplacementReceipt,
  CanvasDocumentReplacementToken,
  CanvasRuntimeDocumentMetadata,
} from '../runtime'
import type {
  CanvasRuntimeDocumentCompositionInput,
} from '../app-adapter'
import type { SceneDocumentAuthority, ScenePersistenceAuthority } from './transactions'

const SCENE_FIELD_KEYS = Object.entries(DOCUMENT_FILE_FIELD_OWNERS)
  .filter(([, owner]) => owner === 'scene')
  .map(([key]) => key)

interface SceneRuntimeDocumentBridgeOptions {
  authority: SceneDocumentAuthority & ScenePersistenceAuthority & {
    replayCommand(command: SceneCommand, direction: 'undo' | 'redo'): boolean
  }
  prepareForDocumentReplacement(): void
  clearPanelOriginTargets(): void
  composeDocumentForSave(input: CanvasRuntimeDocumentCompositionInput): CanopiFile
}

export class SceneRuntimeDocumentBridge {
  private readonly _authority: SceneRuntimeDocumentBridgeOptions['authority']
  private readonly _prepareForDocumentReplacement: SceneRuntimeDocumentBridgeOptions['prepareForDocumentReplacement']
  private readonly _clearPanelOriginTargets: SceneRuntimeDocumentBridgeOptions['clearPanelOriginTargets']
  private readonly _composeDocumentForSave: SceneRuntimeDocumentBridgeOptions['composeDocumentForSave']

  constructor(options: SceneRuntimeDocumentBridgeOptions) {
    this._authority = options.authority
    this._prepareForDocumentReplacement = options.prepareForDocumentReplacement
    this._clearPanelOriginTargets = options.clearPanelOriginTargets
    this._composeDocumentForSave = options.composeDocumentForSave
  }

  loadDocument(file: CanopiFile): void {
    this._clearPanelOriginTargets()
    this._authority.hydrate(file)
  }

  replaceDocument(
    file: CanopiFile,
    token: CanvasDocumentReplacementToken,
    finalizeReplacement: () => void,
  ): CanvasDocumentReplacementReceipt {
    const callerFinalizerInvoked = this._authority.replaceDocument(file, {
      token,
      prepare: () => {
        this._prepareForDocumentReplacement()
        this._clearPanelOriginTargets()
      },
      finalizeReplacement,
    })
    return { callerFinalizerInvoked }
  }

  /** `mapView`: the view the Design is saved with, a scene-owned field of the canvas part; none writes no `map_view`. */
  captureForPersistence(
    metadata: CanvasRuntimeDocumentMetadata,
    doc: CanopiFile,
    mapView: SavedViewCamera | null,
  ): CanvasPersistenceCapture {
    const capture = this._authority.capturePersistence()
    const scene = serializeScenePersistedState(capture.scene, capture.plane, { now: new Date() })
    const canvas = mapView ? { ...scene, map_view: mapView } : scene
    const content = this._composeDocumentForSave({ metadata, document: doc, canvas })
    return Object.freeze({
      content,
      isCurrent: () => capture.isCurrent(),
      acknowledgeSaved: () => capture.acknowledgeSaved(),
    })
  }

  serializeSceneFields(mapView: SavedViewCamera | null): Partial<CanopiFile> {
    const capture = this._authority.capturePersistence()
    const serialized: Record<string, unknown> = { ...serializeScenePersistedState(capture.scene, capture.plane, { now: new Date() }) }
    const out: Record<string, unknown> = {}
    for (const key of SCENE_FIELD_KEYS) {
      if (key in serialized) out[key] = serialized[key]
    }
    if (mapView) out.map_view = mapView
    return out
  }

  replaySceneCommand(command: SceneCommand, direction: 'undo' | 'redo'): boolean {
    return this._authority.replayCommand(command, direction)
  }
}
