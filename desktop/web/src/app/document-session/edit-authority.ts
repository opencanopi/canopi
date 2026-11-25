/**
 * app/document-session/edit-authority.ts: Registers the Design Edit authority capability backed
 * exclusively by the active SessionCore (C2, ADR 0024, contracts §4).
 */
import { DOCUMENT_FILE_FIELD_OWNERS } from '../../generated/known-canopi-keys'
import type { CanopiFile } from '../../types/design'
import {
  registerDesignEditAuthorityCapability,
  type DesignEditAuthorityCapability,
} from '../design-edit/authority-capability'
import type { DeepReadonly, SessionCore } from './core'

const DOCUMENT_OWNER_KEYS: ReadonlySet<string> = new Set(
  Object.entries(DOCUMENT_FILE_FIELD_OWNERS)
    .filter(([, owner]) => owner === 'document')
    .map(([key]) => key),
)

const SCENE_OWNER_KEYS: ReadonlySet<string> = new Set(
  Object.entries(DOCUMENT_FILE_FIELD_OWNERS)
    .filter(([, owner]) => owner === 'scene')
    .map(([key]) => key),
)

const IDLE_SESSION_IDENTITY = Object.freeze({})

function asMutableDesign(doc: DeepReadonly<CanopiFile>): CanopiFile {
  return doc as unknown as Readonly<CanopiFile>
}

function asMutableDesignOrNull(doc: DeepReadonly<CanopiFile> | null | undefined): CanopiFile | null {
  return doc ? asMutableDesign(doc) : null
}

function buildDocumentPatch(
  prev: DeepReadonly<CanopiFile>,
  next: CanopiFile,
): Partial<DeepReadonly<CanopiFile>> | null {
  const prevRecord = prev as unknown as Record<string, unknown>
  const nextRecord = next as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  let changed = false

  for (const key of Object.keys(nextRecord)) {
    if (prevRecord[key] === nextRecord[key]) continue
    if (SCENE_OWNER_KEYS.has(key)) {
      if (import.meta.env.DEV) {
        throw new Error(`Design Edit authority cannot modify Scene-owned key "${key}"`)
      }
      continue
    }
    if (DOCUMENT_OWNER_KEYS.has(key)) {
      patch[key] = nextRecord[key]
      changed = true
    }
  }
  return changed ? patch : null
}

function createSessionCoreEditAuthority(core: SessionCore): DesignEditAuthorityCapability {
  return {
    editCommitted(projector, label = 'edit') {
      const open = core.currentDesign.peek()
      if (!open || open.readOnly) return null
      const before = asMutableDesign(open.document)
      const next = projector(before)
      if (next === before) return before
      const patch = buildDocumentPatch(open.document, next)
      if (!patch) return before
      core.document(label, () => patch)
      return asMutableDesignOrNull(core.currentDesign.peek()?.document)
    },
    reconcileCommitted(projector) {
      const open = core.currentDesign.peek()
      if (!open || open.readOnly) return null
      const before = asMutableDesign(open.document)
      const next = projector(before)
      if (next === before) return before
      const patch = buildDocumentPatch(open.document, next)
      if (!patch) return before
      core.reconcile(() => patch)
      return asMutableDesignOrNull(core.currentDesign.peek()?.document)
    },
    readCommitted() {
      return asMutableDesignOrNull(core.currentDesign.peek()?.document)
    },
    readSessionIdentity() {
      return core.currentDesign.peek()?.scope ?? IDLE_SESSION_IDENTITY
    },
    readDesignName() {
      return core.currentDesign.peek()?.document.name ?? ''
    },
    renameDesign(name, label = 'rename') {
      const open = core.currentDesign.peek()
      if (!open || open.readOnly) return false
      const id = core.document(label, () => ({ name }))
      return id !== null
    },
  }
}

export function installSessionCoreEditAuthority(core: SessionCore): () => void {
  const owner = core
  let disposed = false
  const dispose = () => {
    disposed = true
  }
  registerDesignEditAuthorityCapability(owner, createSessionCoreEditAuthority(core), dispose, true)
  return () => {
    if (!disposed) dispose()
  }
}
