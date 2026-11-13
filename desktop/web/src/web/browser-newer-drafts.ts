import type { BrowserDraftSummary } from "./browser-app-data";

/**
 * web/browser-newer-drafts.ts: the Web session's view of 2.1's Drafts after a rollback (Step 2.0.4 R3,
 * canopi-f47t.52.272; 2.1-Q321, Q322; design check F7, A18), over the store's read half
 * (platform/draft-records.browser.ts). It keeps the last listing, the old-key ids it hides, and whether one listing
 * has completed: until then any old-key Draft may be a copy 2.1 keeps, so none is restored, opened or deleted.
 */

/** 2.1's Draft store read half: no write (design check F7); `hiddenIds` hide 2.0 ids (2.1-Q322). */
export interface BrowserNewerDraftRecords {
  /** `complete` is false when the read failed or ran late, and the rest is the last good listing. */
  list(): Promise<{ readonly drafts: readonly BrowserDraftSummary[]; readonly hiddenIds: readonly string[]; readonly complete: boolean }>;
  content(id: string): Promise<string | null>;
}

export interface BrowserNewerDrafts {
  install(records: BrowserNewerDraftRecords): () => void;
  /** Reads 2.1's Drafts afresh; `complete` says whether this read did (none installed: complete and empty). */
  relist(): Promise<{ readonly drafts: readonly BrowserDraftSummary[]; readonly complete: boolean }>;
  /** The last 2.1 listing; null until one is read while the reader is installed. */
  listed(): readonly BrowserDraftSummary[] | null;
  /** Whether the last listing names `id` as a 2.1 Draft. */
  has(id: string): boolean;
  /** A listed 2.1 Draft's name. */
  name(id: string): string | undefined;
  /** Whether the last listing hides the old-key Draft `id`. */
  hides(id: string): boolean;
  /** Whether the old-key Draft `id` may be opened or deleted now: one listing completed and it does not hide `id`. */
  editable(id: string): boolean;
  /** `editable`, after a re-list while no listing has completed yet. */
  admit(id: string): Promise<boolean>;
  content(id: string): Promise<string | null>;
}

export function createBrowserNewerDrafts(): BrowserNewerDrafts {
  let records: BrowserNewerDraftRecords | null = null;
  let drafts: Map<string, BrowserDraftSummary> | null = null;
  let hiddenIds: ReadonlySet<string> = new Set();
  // Sticky once true for the installed reader: a later failed read keeps the last good hidden ids.
  let completed = false;
  const known = () => records === null || completed;

  async function relist() {
    const listing = records ? await records.list() : { drafts: [], hiddenIds: [], complete: true };
    drafts = new Map(listing.drafts.map((draft) => [draft.id, draft]));
    hiddenIds = new Set(listing.hiddenIds);
    completed ||= listing.complete;
    return { drafts: listing.drafts, complete: listing.complete };
  }

  const editable = (id: string) => known() && !hiddenIds.has(id);

  return {
    install(next) {
      records = next;
      completed = false;
      return () => { if (records === next) records = null; };
    },
    relist,
    listed: () => (records === null ? [] : drafts && [...drafts.values()]),
    has: (id) => drafts?.has(id) ?? false,
    name: (id) => drafts?.get(id)?.name,
    hides: (id) => hiddenIds.has(id),
    editable,
    async admit(id) {
      if (!known()) await relist();
      return editable(id);
    },
    content: async (id) => (await records?.content(id)) ?? null,
  };
}
