/**
 * app/document-session/core/types.ts: Public interfaces and result types for the Session Core
 * (ADR 0024, contracts §4, 2b-3).
 */
import type { ReadonlySignal } from '@preact/signals'
import type { AppLifecyclePort, LifecycleEvent } from '../../../platform/app-lifecycle'
import type {
  DesignHome,
  DesignHomeStore,
  DesignSource,
  DraftId,
  DraftRecord,
  LastOpenHome,
} from '../../../platform/design-home'
import type { FileAccessPort } from '../../../platform/file-access'
import type { CanopiFile } from '../../../types/design'
import type { DesignScope } from '../../../types/design-scope'
import type { SessionEditsApi } from './edits'
import type { HistoryEntry } from './history'
import type { DeepReadonly } from './immutable'
import type { ScenePort } from './scene-half'
import type {
  DesignSessionState,
  OpenDesignState,
  QuestionChoice,
  QuestionId,
  QuestionPurpose,
} from './state'
import type { EncodedDesignPayload } from './write-lane'

export interface DecodedDesignPayload {
  readonly file: CanopiFile
  readonly migratedFrom?: number | null
  readonly readOnly?: boolean
}

export interface SessionCoreCodec {
  decode(bytes: Uint8Array): Promise<DecodedDesignPayload>
  encode(file: DeepReadonly<CanopiFile>): Promise<EncodedDesignPayload>
  admitWrite?(file: DeepReadonly<CanopiFile>): string | null
}

interface SessionCoreSettingsPort {
  readLastOpenHome(): Promise<LastOpenHome | null>
  writeLastOpenHome(home: DesignHome | null): Promise<void>
  flushSettings?(): Promise<void>
  applyNewDesignDefaults?(file: CanopiFile): CanopiFile
}

export interface SessionCoreDeps {
  readonly designHome: DesignHomeStore
  readonly fileAccess: FileAccessPort
  readonly lifecycle: AppLifecyclePort
  readonly codec: SessionCoreCodec
  readonly settings: SessionCoreSettingsPort
  readonly newDesignFactory: () => Promise<CanopiFile> | CanopiFile
  readonly flushDelayMs?: number
  readonly onPendingWriteChange?: (pending: boolean) => void
  readonly onNotice?: (notice: { readonly kind: string; readonly detail?: string }) => void
  /** Optional synchronous initial open state (e.g. Gallery fixture or unit test harness). */
  readonly initialDesign?: {
    readonly home: DesignHome
    readonly file: CanopiFile
    readonly migratedFrom?: number | null
    readonly readOnly?: boolean
  }
}

export type OpenResult =
  | { readonly status: 'opened'; readonly home: DesignHome }
  | { readonly status: 'already-open'; readonly home: DesignHome }
  | { readonly status: 'refused'; readonly reason: string; readonly error?: unknown }
  | { readonly status: 'cancelled' }

type AnswerResult = 'answered' | 'stale'

export interface SessionCore extends SessionEditsApi {
  readonly state: ReadonlySignal<DesignSessionState>
  readonly currentDesign: ReadonlySignal<OpenDesignState | null>
  readonly dirty: ReadonlySignal<boolean>
  readonly revertAvailable: ReadonlySignal<boolean>
  readonly pendingWrite: ReadonlySignal<boolean>
  readonly canUndo: ReadonlySignal<boolean>
  readonly canRedo: ReadonlySignal<boolean>
  readonly newestUndoable: ReadonlySignal<HistoryEntry | null>

  snapshot(): DeepReadonly<CanopiFile> | null
  encodeSnapshot(): Promise<Uint8Array | null>
  openFrom(source: DesignSource): Promise<OpenResult>
  createNew(): Promise<OpenResult>
  close(purpose?: QuestionPurpose): Promise<'closed' | 'cancelled'>
  flushNow(options?: { readonly force?: boolean }): Promise<boolean>
  saveAs(): Promise<'saved' | 'cancelled' | 'conflict' | 'failed'>
  resolveConflict(choice: 'keep-mine' | 'save-as' | 'use-file'): Promise<'resolved' | 'cancelled' | 'failed'>
  saveWithoutCopy(): Promise<boolean>
  revert(): Promise<'reverted' | 'unavailable' | 'failed'>

  attachScene(port: ScenePort): 'attached' | 'no-design'
  detachScene(): void

  onDesignOpened(listener: (scope: DesignScope, design: OpenDesignState) => void): () => void
  answer(id: QuestionId, choice: QuestionChoice): AnswerResult
  listDrafts(): Promise<readonly DraftRecord[]>
  deleteDraft(id: DraftId): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>
  handleLifecycle(event: LifecycleEvent): Promise<void>
  dispose(): void
}
