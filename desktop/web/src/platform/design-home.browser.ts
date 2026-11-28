/**
 * platform/design-home.browser.ts: L1 Web `DesignHomeStore` adapter over `platform/draft-records.browser.ts`
 * (2b-6, canopi-f47t.52.50; contracts §4, §11, ADR 0024, ADR 0026, 2.1-M526, 2.1-M527).
 * Invariant: resolves Draft keys directly through IndexedDB `canopi-drafts` v4 and never branches on
 * `DesignHome.kind` (contracts §4).
 */
import type {
  DeleteDraftResult,
  DesignHomeStore,
  DesignHomeWriteResult,
  DraftId,
  DraftRecord,
  HomeRead,
  HomeVersion,
} from './design-home'
import {
  createDraftRecordsStore,
  type DraftRecordsStore,
  type DraftRecordsStoreOptions,
  type DraftStoreOpenOutcome,
} from './draft-records.browser'

export type BrowserDesignHomeStoreOptions = DraftRecordsStoreOptions

export interface BrowserDesignHomeStore extends DesignHomeStore {
  open(): Promise<DraftStoreOpenOutcome>
  syncLegacyStorage(): Promise<void>
  markPending(id: string): void
  clearPending(id: string): void
  takePendingMarkers(reloadTabId?: string | null): readonly string[]
  closeForPageHide(): void
  reopenAfterPageShow(): Promise<void>
  dispose(): void
}

export function createBrowserDesignHomeStore(
  options: BrowserDesignHomeStoreOptions = {},
): BrowserDesignHomeStore {
  const store: DraftRecordsStore = createDraftRecordsStore(options)

  return {
    open: () => store.open(),
    syncLegacyStorage: () => store.syncLegacyStorage(),
    read: (key: string): Promise<HomeRead> => store.read(key),
    write: (key: string, bytes: Uint8Array, expected: HomeVersion | null): Promise<DesignHomeWriteResult> =>
      store.write(key, bytes, expected),
    listDrafts: (): Promise<readonly DraftRecord[]> => store.list(),
    deleteDraft: (id: DraftId): Promise<DeleteDraftResult> => store.delete(id),
    onVersionChange: (cb: () => void): (() => void) => store.onVersionChange(cb),
    markPending: (id: string): void => store.markPending(id),
    clearPending: (id: string): void => store.clearPending(id),
    takePendingMarkers: (reloadTabId?: string | null): readonly string[] => store.takePendingMarkers(reloadTabId),
    closeForPageHide: (): void => store.closeForPageHide(),
    reopenAfterPageShow: (): Promise<void> => store.reopenAfterPageShow(),
    dispose: (): void => store.dispose(),
  }
}
