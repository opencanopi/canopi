// app/document-session/live-core.ts
// Live Session Core installation and JSON codec bridge for Desktop, Web and Gallery (2b-3; contracts §4, ADR 0024).

import { signal, type ReadonlySignal } from '@preact/signals'
import type { ReadOnlyDesign } from '../../generated/contracts'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import { encodeCanopiDesign } from '../contracts/canopi-design-wire'
import { designIdentitiesAndRangesProblem } from '../contracts/design-admission'
import {
  CanopiDesignIngestionError,
  decodeCanopiDesign,
  isSavedByNewerCanopi,
  parseCanopiText,
} from '../contracts/design-ingestion'
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

/** Production `.canopi` codec shared by Desktop, Web and Gallery Session Cores (D3, ADR 0021, contracts §4). */
export function createJsonSessionCodec(options?: {
  readonly decode?: (bytes: Uint8Array) => Promise<DecodedDesignPayload>
  readonly readNewerDesign?: (text: string) => Promise<ReadOnlyDesign>
}): SessionCoreCodec {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return {
    async decode(bytes) {
      if (options?.decode) return options.decode(bytes)
      const text = decoder.decode(bytes)
      const raw = parseCanopiText(text)
      if (isSavedByNewerCanopi(raw)) {
        if (options?.readNewerDesign) {
          const readOnly = await options.readNewerDesign(text)
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
      return { file: decodeCanopiDesign(raw) }
    },
    admitWrite(file) {
      if (file.version !== CURRENT_CANOPI_FILE_VERSION) {
        return `unsupported_version:${file.version}`
      }
      const doc = file as Parameters<typeof designIdentitiesAndRangesProblem>[0]
      return (
        designIdentitiesAndRangesProblem(doc)
        ?? viewsAndStoriesProblem(doc.views ?? [], doc.stories ?? [])
        ?? mapViewProblem(doc.map_view)
      )
    },
    async encode(file) {
      const text = JSON.stringify(encodeCanopiDesign(file))
      const bytes = encoder.encode(text)
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
      const version = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
      return { bytes, version }
    },
  }
}
