/**
 * platform/file-access.ts: L1 file-picking port for Design Open and Save As
 * (contracts §4, §22, 2.1-M155, ADR 0027).
 */
import type { FileGrantId } from './design-home'

export type PickFileOutcome =
  | {
      readonly kind: 'picked'
      readonly grant: FileGrantId
      readonly displayName?: string
      readonly recentId?: string
    }
  | { readonly kind: 'cancelled' }

export interface FileAccessPort {
  pickOpen(kind: 'canopi'): Promise<PickFileOutcome>
  pickHomeTarget(suggestedName: string): Promise<PickFileOutcome>
}
