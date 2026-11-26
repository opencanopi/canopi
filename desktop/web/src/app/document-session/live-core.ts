// app/document-session/live-core.ts
// Live Session Core installation and JSON codec bridge for Desktop, Web and Gallery (2b-3; contracts §4, ADR 0024).

import { signal, type ReadonlySignal } from '@preact/signals'
import type { ReadOnlyDesign } from '../../generated/contracts'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { DesignCore } from '../../platform/design-core'
import { CanopiDesignIngestionError } from '../contracts/canopi-design-errors'
import {
  flattenDocumentForJson,
  isCurrentCanopiDocument,
  isSavedByNewerCanopi,
  normalizeLoadedDocument,
  parseCanopiJsonText,
  v10ToSessionCanopiFile,
} from '../contracts/document'
import { mapViewProblem, viewsAndStoriesProblem } from '../contracts/views-admission'
import {
  createSessionCore,
  type DecodedDesignPayload,
  type SessionCore,
  type SessionCoreCodec,
} from './core'
import { installSessionCoreEditAuthority } from './edit-authority'
import type { DesignSaveStatus } from './save-status'

export {
  createSessionCore,
  type DecodedDesignPayload,
  type DesignSaveStatus,
  type SessionCore,
  type SessionCoreCodec,
}

const activeSessionCoreSignal = signal<SessionCore | null>(null)

export const activeSessionCore: ReadonlySignal<SessionCore | null> = activeSessionCoreSignal

export function getLiveSessionCore(): SessionCore | null {
  return activeSessionCoreSignal.peek()
}

export function requireLiveSessionCore(): SessionCore {
  const core = activeSessionCoreSignal.peek()
  if (!core) throw new Error('No live Session Core installed')
  return core
}

/**
 * Installs the active edition's live Session Core and binds the Design Edit authority to it.
 * Returns a disposer that tears down the authority and core.
 */
export function installLiveSessionCore(core: SessionCore): () => void {
  const previous = activeSessionCoreSignal.peek()
  if (previous && previous !== core) previous.dispose()
  activeSessionCoreSignal.value = core
  const disposeAuthority = installSessionCoreEditAuthority(core)

  return () => {
    disposeAuthority()
    if (activeSessionCoreSignal.peek() === core) activeSessionCoreSignal.value = null
    core.dispose()
  }
}

async function decodeWithDesignCore(
  designCore: DesignCore,
  bytes: Uint8Array,
  decoder: TextDecoder,
  readNewerDesign?: (text: string) => Promise<ReadOnlyDesign>,
): Promise<DecodedDesignPayload> {
  const answer = await designCore.decode(bytes)
  if ('ok' in answer) {
    return { file: v10ToSessionCanopiFile(answer.ok.design) }
  }
  const refusal = answer.err
  if (refusal.kind === 'newer_version' && readNewerDesign) {
    const readOnly = await readNewerDesign(decoder.decode(bytes))
    return {
      file: readOnly.view,
      readOnly: true,
      savedByVersion: readOnly.saved_by_version,
    }
  }
  const ingestionKind =
    refusal.kind === 'older_version' || refusal.kind === 'newer_version'
      ? 'unsupported_version'
      : 'invalid_document'
  const versionHint =
    refusal.kind === 'newer_version'
      ? CURRENT_CANOPI_FILE_VERSION + 1
      : refusal.kind === 'older_version'
        ? CURRENT_CANOPI_FILE_VERSION - 1
        : null
  throw new CanopiDesignIngestionError(ingestionKind, refusal.message, versionHint)
}

async function decodeFallbackJson(
  bytes: Uint8Array,
  decoder: TextDecoder,
  readNewerDesign?: (text: string) => Promise<ReadOnlyDesign>,
): Promise<DecodedDesignPayload> {
  const text = decoder.decode(bytes)
  const raw = parseCanopiJsonText(text)
  if (isSavedByNewerCanopi(raw)) {
    if (readNewerDesign) {
      const readOnly = await readNewerDesign(text)
      return {
        file: readOnly.view,
        readOnly: true,
        savedByVersion: readOnly.saved_by_version,
      }
    }
    const version = (raw as { readonly version?: unknown }).version
    throw new CanopiDesignIngestionError(
      'unsupported_version',
      `$.version: unsupported Canopi Design version ${String(version)}; saved by a newer Canopi`,
      typeof version === 'number' ? version : undefined,
    )
  }
  if (!isCurrentCanopiDocument(raw)) {
    const version = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { readonly version?: unknown }).version
      : undefined
    if (typeof version === 'number' && Number.isInteger(version) && version !== CURRENT_CANOPI_FILE_VERSION) {
      throw new CanopiDesignIngestionError(
        'unsupported_version',
        `$.version: unsupported Canopi Design version ${version}`,
        version,
      )
    }
    throw new CanopiDesignIngestionError('invalid_document', '$: expected a valid Canopi Design')
  }
  return { file: normalizeLoadedDocument(raw) }
}

/** Production `.canopi` codec shared by Desktop, Web and Gallery Session Cores (D3, ADR 0021, contracts §4, §10). */
export function createJsonSessionCodec(options?: {
  readonly designCore?: DesignCore
  readonly decode?: (bytes: Uint8Array) => Promise<DecodedDesignPayload>
  readonly readNewerDesign?: (text: string) => Promise<ReadOnlyDesign>
}): SessionCoreCodec {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return {
    async decode(bytes) {
      if (options?.decode) return options.decode(bytes)
      if (options?.designCore) {
        return decodeWithDesignCore(options.designCore, bytes, decoder, options.readNewerDesign)
      }
      return decodeFallbackJson(bytes, decoder, options?.readNewerDesign)
    },
    admitWrite(file) {
      if (file.version !== CURRENT_CANOPI_FILE_VERSION) {
        return `unsupported_version:${file.version}`
      }
      const duplicateProblem = duplicateObjectIdProblem(file)
      if (duplicateProblem) return duplicateProblem
      const views = (file.views ?? []) as Parameters<typeof viewsAndStoriesProblem>[0]
      const stories = (file.stories ?? []) as Parameters<typeof viewsAndStoriesProblem>[1]
      return viewsAndStoriesProblem(views, stories) ?? mapViewProblem(file.map_view)
    },
    async encode(file) {
      const text = JSON.stringify(flattenDocumentForJson(file))
      const bytes = encoder.encode(text)
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
      const version = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
      return { bytes, version }
    },
  }
}

function duplicateObjectIdProblem(file: {
  readonly plants: readonly { readonly id: string }[]
  readonly zones: readonly { readonly id: string }[]
  readonly annotations?: readonly { readonly id: string }[]
  readonly groups?: readonly { readonly id: string }[]
  readonly measurement_guides?: readonly { readonly id: string }[]
}): string | null {
  const lists = [
    ['plants', file.plants],
    ['zones', file.zones],
    ['annotations', file.annotations ?? []],
    ['groups', file.groups ?? []],
    ['measurement_guides', file.measurement_guides ?? []],
  ] as const
  for (const [field, items] of lists) {
    const seen = new Set<string>()
    for (let i = 0; i < items.length; i += 1) {
      const id = items[i]?.id
      if (!id) return `$.${field}[${i}].id: expected a non-empty id`
      if (seen.has(id)) return `$.${field}[${i}].id: expected a unique id`
      seen.add(id)
    }
  }
  return null
}
