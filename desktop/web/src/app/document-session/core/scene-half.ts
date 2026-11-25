/**
 * app/document-session/core/scene-half.ts: ScenePort contract, Scene-key extraction, and the single
 * Design composition helper (`composeForWrite`) shared by write-lane, saveAs, and core.snapshot()
 * (ADR 0024, contracts §4).
 */
import { DOCUMENT_FILE_FIELD_OWNERS } from '../../../generated/known-canopi-keys'
import type { SceneCommand } from '../../../canvas/runtime/scene-commands'
import type { CanopiFile } from '../../../types/design'
import { deepFreezeDev, type DeepReadonly } from './immutable'

export type SceneKey = {
  [K in keyof typeof DOCUMENT_FILE_FIELD_OWNERS]: (typeof DOCUMENT_FILE_FIELD_OWNERS)[K] extends 'scene' ? K : never
}[keyof typeof DOCUMENT_FILE_FIELD_OWNERS] & keyof CanopiFile

const SCENE_KEYS: readonly SceneKey[] = (
  Object.entries(DOCUMENT_FILE_FIELD_OWNERS)
    .filter(([, owner]) => owner === 'scene')
    .map(([key]) => key)
) as readonly SceneKey[]

export interface ScenePort {
  serialize(): Pick<CanopiFile, SceneKey>
  load(file: DeepReadonly<CanopiFile>): void
  replay(command: SceneCommand, direction: 'undo' | 'redo'): void
}

export function extractSceneFields(file: DeepReadonly<CanopiFile>): DeepReadonly<Partial<CanopiFile>> {
  const out: Record<string, unknown> = {}
  const record = file as Readonly<Record<string, unknown>>
  for (const key of SCENE_KEYS) {
    if (key in record) out[key] = record[key]
  }
  return deepFreezeDev(out as Partial<CanopiFile>)
}

/**
 * The ONE composer for writes, Save As, and `core.snapshot()`: overlays the attached ScenePort's
 * live persisted fields (or the last detached `scene.fields`) onto `design.document`.
 */
export function composeForWrite(design: {
  readonly document: DeepReadonly<CanopiFile>
  readonly scene:
    | { readonly kind: 'attached'; readonly port: ScenePort }
    | { readonly kind: 'detached'; readonly fields: DeepReadonly<Partial<CanopiFile>> }
}): DeepReadonly<CanopiFile> {
  const sceneFields = design.scene.kind === 'attached'
    ? design.scene.port.serialize()
    : design.scene.fields
  return deepFreezeDev(Object.assign({}, design.document, sceneFields))
}
