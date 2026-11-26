/**
 * editions/web/web-session.ts: Web Edition Session Core actions and Draft/file helpers
 * (ADR 0024, contracts §4).
 */
import { effect, signal } from '@preact/signals'
import { ingestionErrorFromFormatRefusal } from '../../app/contracts/canopi-design-errors'
import { flattenDocumentForJson } from '../../app/contracts/document'
import { editionPorts, hasEditionPorts } from '../../platform/edition-ports'
import { isIndexedDbAvailable } from '../../platform/design-home.browser'
import { setDesignName } from '../../app/design-edit'
import {
  closeDesign,
  designRevertAvailable,
  designSaveFailureReason,
  designSaveStatus,
  newDesignAction,
  openDesignDraft,
  resolveDesignConflict,
  retryDesignSave,
  revertDesign,
} from '../../app/document-session/actions'
import { getLiveSessionCore, requireLiveSessionCore } from '../../app/document-session/live-core'
import { presentDesignOpenFailure } from '../../app/document-session/open-failure'
import { designSessionStore, readOnlyOrigin } from '../../app/document-session/store'
import { applyNewDesignBackground } from '../../app/settings/new-design-defaults'
import { currentCanvasSession } from '../../canvas/session'
import { browserAppDataStore, type BrowserDraftSummary } from '../../web/browser-app-data'
import { browserDraftPersistence, type BrowserShellDesignIdentity } from '../../web/browser-draft-persistence'
import { createBrowserNewerDrafts, type BrowserNewerDraftRecords } from '../../web/browser-newer-drafts'
import { presentBrowserDraftOpenFailure, presentBrowserStorageUncheckedNotice } from '../../web/browser-notices'
import { downloadBrowserTextFile, pickBrowserTextFile } from '../../web/browser-text-files'

export const webLaunching = signal(false)
const newerDrafts = createBrowserNewerDrafts()

export function setWebLaunching(next: boolean): void {
  webLaunching.value = next
}

export function installWebNewerDrafts(records: BrowserNewerDraftRecords): () => void {
  return newerDrafts.install(records)
}

export function listedNewerWebDrafts(): readonly BrowserDraftSummary[] | null {
  return newerDrafts.listed()
}

export async function relistNewerWebDrafts(): Promise<{ readonly drafts: readonly BrowserDraftSummary[]; readonly complete: boolean }> {
  return newerDrafts.relist()
}

export function isWebDraftListingComplete(): boolean {
  return newerDrafts.known()
}

export function isWebDraftEditable(id: string): boolean {
  return newerDrafts.editable(id)
}

export function readWebDesignIdentity(): BrowserShellDesignIdentity | null {
  const open = getLiveSessionCore()?.currentDesign.value ?? null
  if (!open) return null
  const kind = designSessionStore.sessionKind.value
  return {
    name: designSessionStore.designName.value,
    saveStatus: designSaveStatus.value,
    saveFailureReason: designSaveFailureReason.value,
    readOnlyOrigin: readOnlyOrigin(kind),
  }
}

export async function currentWebDesignText(): Promise<string | null> {
  const core = getLiveSessionCore()
  const open = core?.currentDesign.peek()
  if (!core || !open) return null
  const snap = core.snapshot()
  if (!snap) return null
  return encodeWebCanopiText(snap)
}

export async function newWebDesign(): Promise<void> {
  browserDraftPersistence.requestOnce()
  await newDesignAction()
  applyNewDesignBackground()
}

/** Wait until an attached canvas finishes its opening fit (`applyPendingOpen`) before flushing a freshly opened `.canopi` file. */
async function flushOpenedFileAfterPresent(
  core: ReturnType<typeof requireLiveSessionCore>,
  openedScope: unknown,
): Promise<void> {
  const canvas = currentCanvasSession.peek()?.documents ?? null
  if (canvas && !canvas.presented.peek()) {
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        stop()
        resolve()
      }
      const stop = effect(() => {
        if (canvas.presented.value || core.currentDesign.value?.scope !== openedScope) done()
      })
    })
  }
  const live = core.currentDesign.peek()
  if (live && live.scope === openedScope && !live.readOnly) {
    await core.flushNow({ force: true })
  }
}

export async function openWebCanopiFile(): Promise<boolean> {
  browserDraftPersistence.requestOnce()
  const picked = await pickBrowserTextFile('.canopi,application/json')
  if (!picked) return false
  try {
    const core = requireLiveSessionCore()
    const bytes = new TextEncoder().encode(picked.text)
    const res = await core.openFrom({ kind: 'bytes', name: picked.fileName, bytes })
    if (res.status === 'refused') {
      presentDesignOpenFailure(res.error ?? new Error(res.reason))
      return false
    }
    const opened = core.currentDesign.peek()
    if (res.status === 'opened' && opened && !opened.readOnly) {
      await flushOpenedFileAfterPresent(core, opened.scope)
    }
    return res.status === 'opened' || res.status === 'already-open'
  } catch (error) {
    presentDesignOpenFailure(error)
    return false
  }
}

const RESERVED_FILENAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])

function canopiDownloadName(raw: string): string {
  const base = (raw || 'Untitled').trim() || 'Untitled'
  let out = ''
  for (const ch of base) {
    out += RESERVED_FILENAME_CHARS.has(ch) ? '_' : ch
  }
  return `${out}.canopi`
}

async function encodeWebCanopiText(file: Parameters<typeof flattenDocumentForJson>[0]): Promise<string> {
  const core = editionPorts().designCore
  const encoded = await core.encode(flattenDocumentForJson(file))
  if ('err' in encoded) throw ingestionErrorFromFormatRefusal(encoded.err)
  return new TextDecoder('utf-8', { fatal: true }).decode(encoded.ok)
}

export async function downloadWebCanopi(): Promise<void> {
  const core = requireLiveSessionCore()
  const snap = core.snapshot()
  if (!snap) return
  const text = await encodeWebCanopiText(snap)
  downloadBrowserTextFile(canopiDownloadName(snap.name), text, 'application/json')
}

export async function downloadWebDraft(id: string): Promise<void> {
  if (newerDrafts.has(id)) {
    const text = await newerDrafts.content(id)
    if (text === 'closed') return
    if (text === null) throw new Error('Draft not found')
    downloadBrowserTextFile(canopiDownloadName(newerDrafts.name(id) || 'Untitled'), text, 'application/json')
    return
  }
  const core = editionPorts().designCore
  let rawBytes: Uint8Array | null = null
  if (isIndexedDbAvailable() && hasEditionPorts()) {
    const read = await editionPorts().designHome.read(id)
    if (read.kind === 'present') rawBytes = new Uint8Array(read.bytes)
  } else {
    const raw = newerDrafts.hides(id) ? null : browserAppDataStore.loadRawDraft(id)
    if (raw) rawBytes = new TextEncoder().encode(JSON.stringify(raw))
  }
  if (!rawBytes) throw new Error('Draft not found')
  const decoded = await core.decode(rawBytes)
  if ('err' in decoded) throw ingestionErrorFromFormatRefusal(decoded.err)
  const encoded = await core.encode(decoded.ok.design)
  if ('err' in encoded) throw ingestionErrorFromFormatRefusal(encoded.err)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(encoded.ok)
  const name = typeof decoded.ok.design.name === 'string' ? decoded.ok.design.name : 'Untitled'
  downloadBrowserTextFile(canopiDownloadName(name), text, 'application/json')
}

export async function openWebDraft(id: string): Promise<boolean> {
  if (newerDrafts.has(id)) {
    const text = await newerDrafts.content(id)
    if (text === 'closed') return false
    if (text === null) {
      presentBrowserDraftOpenFailure()
      return false
    }
    const core = requireLiveSessionCore()
    const bytes = new TextEncoder().encode(text)
    const res = await core.openFrom({ kind: 'bytes', name: newerDrafts.name(id) || 'Untitled', bytes })
    if (res.status === 'refused') {
      presentDesignOpenFailure(res.error ?? new Error(res.reason))
      return false
    }
    return res.status === 'opened' || res.status === 'already-open'
  }
  const admitted = await newerDrafts.admit(id)
  if (!admitted) {
    // 2.1-Q334 (canopi-2b6q): when IndexedDB could not be checked, open the old-key Draft read-only with Download a copy.
    if (!newerDrafts.known()) {
      const raw = browserAppDataStore.loadRawDraft(id)
      if (!raw) {
        presentBrowserDraftOpenFailure()
        return false
      }
      const core = requireLiveSessionCore()
      const bytes = new TextEncoder().encode(JSON.stringify(raw))
      const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name : 'Untitled'
      const res = await core.openFrom({ kind: 'bytes', name, bytes, readOnly: true })
      if (res.status === 'refused') {
        presentDesignOpenFailure(res.error ?? new Error(res.reason))
        return false
      }
      presentBrowserStorageUncheckedNotice()
      return res.status === 'opened' || res.status === 'already-open'
    }
    presentBrowserDraftOpenFailure()
    return false
  }
  try {
    await openDesignDraft(id, { presentFailure: false })
    return true
  } catch {
    // Missing or unreadable Draft; tell the user and let welcome screen re-list.
    presentBrowserDraftOpenFailure()
    return false
  }
}

export function listWebDrafts(): readonly BrowserDraftSummary[] {
  return browserAppDataStore.listDrafts().filter((draft) => !newerDrafts.hides(draft.id))
}

function summaryNameFromDraftBytes(bytes: Uint8Array | null): string {
  if (!bytes) return 'Untitled'
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { readonly name?: unknown }
    return typeof parsed?.name === 'string' && parsed.name.trim().length > 0 ? parsed.name : 'Untitled'
  } catch {
    // Unreadable Draft bytes fall back to Untitled in the welcome list.
    return 'Untitled'
  }
}

export async function listWebDraftsAsync(): Promise<readonly BrowserDraftSummary[]> {
  if (!isIndexedDbAvailable() || !hasEditionPorts()) return listWebDrafts()
  const home = editionPorts().designHome
  if (!('listDrafts' in home)) return listWebDrafts()
  const records = await home.listDrafts()
  return records.map((record) => ({
    id: record.id,
    name: summaryNameFromDraftBytes(record.bytes),
    updatedAt: record.updatedAt,
  }))
}

export async function deleteWebDraft(id: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
  if (!(await newerDrafts.admit(id))) {
    return { ok: false, error: new Error(`The Draft ${id} may be 2.1's and is not deleted here`) }
  }
  const core = getLiveSessionCore()
  if (core) {
    const res = await core.deleteDraft(id as never)
    return res.ok ? { ok: true } : { ok: false, error: new Error(res.reason) }
  }
  const res = browserAppDataStore.deleteDraft(id)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export async function reloadWebForRelease(reload: () => void = () => globalThis.location.reload()): Promise<boolean> {
  const core = getLiveSessionCore()
  if (core) {
    const open = core.currentDesign.peek()
    browserAppDataStore.noteReloadHome(
      open && !open.readOnly && open.home.kind === 'draft' ? open.home.key : null,
    )
    const outcome = await core.close('reload')
    if (outcome !== 'closed') {
      browserAppDataStore.takeReloadHome()
      return false
    }
  }
  reload()
  return true
}

export function createWebShellCommands() {
  return {
    newDesign: newWebDesign,
    openCanopi: openWebCanopiFile,
    downloadCanopi: downloadWebCanopi,
    revertDesign,
    closeDesign,
  }
}

export {
  designRevertAvailable,
  resolveDesignConflict,
  retryDesignSave,
  setDesignName,
}
