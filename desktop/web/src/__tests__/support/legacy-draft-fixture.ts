/**
 * __tests__/support/legacy-draft-fixture.ts: Test-only helper for seeding or mutating
 * the 2.0 localStorage Drafts key (`canopi:web-app-data:v3:drafts`). Production 2.1
 * code never writes or deletes this key (2.1-M21).
 */
import {
  DRAFTS_STORAGE_KEY,
  type BrowserDraftSummary,
  type BrowserStorageAdapter,
} from '../../web/browser-app-data'

interface RawLegacyDraftsEnvelope {
  version: 3
  drafts: BrowserDraftSummary[]
  draftFiles: Record<string, Record<string, unknown>>
}

export class TestLegacyDraftChangedError extends Error {
  constructor(readonly draftId: string) {
    super('The Draft was changed in another browser tab')
    this.name = 'BrowserDraftChangedError'
  }
}

function defaultStorage(): BrowserStorageAdapter {
  return {
    getItem: (key) => globalThis.localStorage.getItem(key),
    setItem: (key, value) => globalThis.localStorage.setItem(key, value),
    removeItem: (key) => globalThis.localStorage.removeItem(key),
  }
}

function readEnvelope(storage: BrowserStorageAdapter): RawLegacyDraftsEnvelope {
  const raw = storage.getItem(DRAFTS_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<RawLegacyDraftsEnvelope>
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.drafts) && parsed.draftFiles && typeof parsed.draftFiles === 'object') {
        return {
          version: 3,
          drafts: [...parsed.drafts],
          draftFiles: { ...parsed.draftFiles },
        }
      }
    } catch {
      // Unreadable test storage starts from an empty envelope.
    }
  }
  return { version: 3, drafts: [], draftFiles: {} }
}

function draftIdFor(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `draft-${slug || 'untitled'}`
}

export function seedLegacyDraft(options: {
  readonly id?: string
  readonly raw: Record<string, unknown>
  readonly name: string
  readonly now: string
  readonly expectedUpdatedAt?: string | null
  readonly storage?: BrowserStorageAdapter
}): { readonly ok: true; readonly value: BrowserDraftSummary } | { readonly ok: false; readonly error: unknown } {
  const storage = options.storage ?? defaultStorage()
  try {
    const current = readEnvelope(storage)
    const trimmed = options.id?.trim()
    const id = trimmed && trimmed.length > 0 ? trimmed : draftIdFor(options.name)
    if (options.expectedUpdatedAt !== undefined) {
      const stored = current.drafts.find((draft) => draft.id === id)
      if (stored && stored.updatedAt !== options.expectedUpdatedAt) {
        return { ok: false, error: new TestLegacyDraftChangedError(id) }
      }
    }
    const summary: BrowserDraftSummary = { id, name: options.name || 'Untitled', updatedAt: options.now }
    const drafts = [summary, ...current.drafts.filter((draft) => draft.id !== id)]
    const draftFiles = { ...current.draftFiles, [id]: options.raw }
    storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ version: 3, drafts, draftFiles }))
    return { ok: true, value: summary }
  } catch (error) {
    return { ok: false, error }
  }
}

export function deleteLegacyDraft(
  id: string,
  storage: BrowserStorageAdapter = defaultStorage(),
): { readonly ok: true; readonly value: null } | { readonly ok: false; readonly error: unknown } {
  try {
    const current = readEnvelope(storage)
    const { [id]: _removed, ...draftFiles } = current.draftFiles
    const drafts = current.drafts.filter((draft) => draft.id !== id)
    storage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ version: 3, drafts, draftFiles }))
    return { ok: true, value: null }
  } catch (error) {
    return { ok: false, error }
  }
}
