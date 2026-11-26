/**
 * Owner of Desktop's FileAccessPort, AppLifecyclePort, and DesignCore bindings (`no-cancelled-literal`,
 * ADR 0024, ADR 0025; contracts §4, §22). Invariant: dialog picks return typed outcomes, never raw paths.
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { pickOpen, pickSave } from '../../ipc/dialogs'
import { deleteDesignDraft, listDesignDrafts } from '../../ipc/design'
import {
  designCoreCanopiToStamp,
  designCoreDecode,
  designCoreDecodeStamp,
  designCoreDraftSummary,
  designCoreEncode,
  designCoreEncodeStamp,
  designCoreNewDesign,
  designCoreStampToCanopi,
  designCoreVersion,
} from '../../ipc/design-core'
import type { AppLifecyclePort, LifecycleEvent } from '../../platform/app-lifecycle'
import type { DesignCore } from '../../platform/design-core'
import type {
  DeleteDraftResult,
  DesignHomeStore,
  DraftId,
  DraftRecord,
} from '../../platform/design-home'
import type { FileAccessPort, PickFileOutcome } from '../../platform/file-access'
import { desktopHomePort } from './design-home'

export function createDesktopSessionHomeStore(): DesignHomeStore {
  return {
    read: (key) => desktopHomePort.read(key),
    write: (key, bytes, expected, options) => desktopHomePort.write(key, bytes, expected, options),
    async listDrafts(): Promise<readonly DraftRecord[]> {
      const drafts = await listDesignDrafts()
      return drafts.map((draft) => ({
        id: draft.id as DraftId,
        updatedAt: draft.updated_at,
        bytes: null,
      }))
    },
    async deleteDraft(id: DraftId): Promise<DeleteDraftResult> {
      try {
        await deleteDesignDraft(id)
        return { ok: true }
      } catch {
        // IPC delete failures map to a typed Failure in DeleteDraftResult so Session Core handles recovery.
        return {
          ok: false,
          failure: {
            code: { kind: 'io', io: 'other' },
            user_may_retry: false,
            op: 'draft.delete',
            operation: null,
            detail: null,
          },
        }
      }
    },
    onVersionChange(): () => void {
      return () => {}
    },
  }
}

export const desktopFileAccessPort: FileAccessPort = {
  async pickOpen(): Promise<PickFileOutcome> {
    const outcome = await pickOpen('design-open')
    if (outcome.kind !== 'picked') return { kind: 'cancelled' }
    const home = outcome.file_homes?.[0]
    const grant = home?.grant ?? outcome.grants?.[0]
    if (!grant) return { kind: 'cancelled' }
    return {
      kind: 'picked',
      grant,
      ...(home?.display_name ? { displayName: home.display_name } : {}),
      ...(home?.recent_id ? { recentId: home.recent_id } : {}),
    }
  },
  async pickHomeTarget(suggestedName: string): Promise<PickFileOutcome> {
    const outcome = await pickSave('design-save', suggestedName)
    if (outcome.kind !== 'picked') return { kind: 'cancelled' }
    const home = outcome.file_home
    const grant = home?.grant ?? outcome.grant
    if (!grant) return { kind: 'cancelled' }
    return {
      kind: 'picked',
      grant,
      ...(home?.display_name ? { displayName: home.display_name } : {}),
      ...(home?.recent_id ? { recentId: home.recent_id } : {}),
    }
  },
}

export interface DesktopWindowHandle {
  onCloseRequested(handler: (event: { preventDefault(): void }) => void): Promise<() => void>
  destroy(): Promise<void>
}

export function createDesktopAppLifecyclePort(options?: {
  readonly getWindow?: () => DesktopWindowHandle
  readonly waitForCloseHold?: () => Promise<'proceed' | 'cancel'>
}): AppLifecyclePort {
  const resolveWindow = options?.getWindow ?? (() => getCurrentWindow())
  return {
    subscribe(listener: (event: LifecycleEvent) => void): () => void {
      let disposed = false
      let unlistenClose: (() => void) | null = null
      let closePending: Promise<void> | null = null

      const onBlur = () => listener({ kind: 'focus-lost' })
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') listener({ kind: 'hidden' })
        else listener({ kind: 'shown', persisted: false })
      }
      window.addEventListener('blur', onBlur)
      document.addEventListener('visibilitychange', onVisibility)

      try {
        const win = resolveWindow()
        void win
          .onCloseRequested((event) => {
            event.preventDefault()
            if (disposed || closePending) return
            closePending = (async () => {
              if (options?.waitForCloseHold) {
                const holdAnswer = await options.waitForCloseHold()
                if (disposed || holdAnswer === 'cancel') return
              }
              let closeWork: Promise<void> | undefined
              if (!disposed) {
                listener({ kind: 'close-requested', done: (work) => { closeWork = work } })
              }
              await closeWork
            })()
              .catch(() => {
                // Unexpected failure before or during close handoff: keep the window open so unsaved work is never silently lost.
              })
              .finally(() => {
                closePending = null
              })
          })
          .then((unlisten) => {
            if (disposed) unlisten()
            else unlistenClose = unlisten
          })
          .catch(() => {
            // Outside a Tauri webview (e.g. JSDOM/Vitest), native close listener is unavailable.
          })
      } catch {
        // Outside a Tauri webview (e.g. JSDOM/Vitest), getCurrentWindow() throws synchronously.
      }

      return () => {
        disposed = true
        unlistenClose?.()
        unlistenClose = null
        window.removeEventListener('blur', onBlur)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    },
    async destroyWindow(): Promise<void> {
      try {
        await resolveWindow().destroy()
      } catch {
        // Outside a Tauri webview, destroy() is unavailable.
      }
    },
  }
}

export const desktopDesignCorePort: DesignCore = {
  version: () => designCoreVersion(),
  decode: (bytes) => designCoreDecode(bytes),
  async encode(design) {
    const reply = await designCoreEncode(design)
    return 'ok' in reply ? { ok: new Uint8Array(reply.ok) } : reply
  },
  newDesign: (input) => designCoreNewDesign(input),
  draftSummary: (bytes, updatedAt) => designCoreDraftSummary(bytes, updatedAt),
  decodeStamp: (payloadJson) => designCoreDecodeStamp(payloadJson),
  encodeStamp: (payload) => designCoreEncodeStamp(payload),
  async stampToCanopi(payload, name, origin) {
    const reply = await designCoreStampToCanopi(payload, name, origin)
    return 'ok' in reply ? { ok: new Uint8Array(reply.ok) } : reply
  },
  canopiToStamp: (bytes, origin) => designCoreCanopiToStamp(bytes, origin),
}
