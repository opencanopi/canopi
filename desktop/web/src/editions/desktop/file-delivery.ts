/**
 * editions/desktop/file-delivery.ts: Owner of the Desktop FileDelivery adapter (no-cancelled-literal,
 * ADR 0022 and 0025, contracts §16, 2.1-M154, 2.1-M155, 2.1-M522). Invariant: every export goes through
 * the host Save dialog (`pickSave`) and raw binary IPC (`deliverFileBytes`), returning `{ kind: 'cancelled' }`
 * only on dialog dismissal or caller AbortSignal; extension and overwrite rules are enforced by the host.
 */
import { reportFailure } from '../../failures/report'
import { deliverFileBytes } from '../../ipc/bytes'
import { pickSave } from '../../ipc/dialogs'
import {
  buildDeliveryFileName,
  deliveryContentBytes,
  FILE_DELIVERY_ROWS,
  type FileDeliveryContent,
  type FileDeliveryKind,
  type FileDeliveryOutcome,
  type FileDeliveryPort,
} from '../../platform/file-delivery'

export function createDesktopFileDelivery(untitled?: () => string): FileDeliveryPort {
  return {
    async deliverFile(
      kind: FileDeliveryKind,
      suggestedStem: string,
      content: FileDeliveryContent,
      signal?: AbortSignal,
    ): Promise<FileDeliveryOutcome> {
      if (signal?.aborted) return 'cancelled'
      const row = FILE_DELIVERY_ROWS[kind]
      if (row.dialogKind === null) {
        const error = new Error(`Desktop FileDelivery row "${kind}" is written directly by the host`)
        reportFailure(error, { shown: 'none' })
        throw error
      }
      const bytes = deliveryContentBytes(content)
      if (bytes === null) {
        const error = new Error(`Desktop FileDelivery row "${kind}" requires byte or text content`)
        reportFailure(error, { shown: 'none' })
        throw error
      }
      const suggestedName = buildDeliveryFileName(kind, suggestedStem, untitled?.())
      const picked = await pickSave(row.dialogKind, suggestedName)
      if (picked.kind === 'cancelled') return 'cancelled'
      if (signal?.aborted) return 'cancelled'

      await deliverFileBytes(row.fileKind, picked.path, bytes)
      return 'saved'
    },
    dispose() {
      // Desktop delivery holds no temporary blob URLs.
    },
  }
}
