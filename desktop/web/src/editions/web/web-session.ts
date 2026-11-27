/**
 * editions/web/web-session.ts: Web Edition Session Core actions and Draft/file helpers
 * (ADR 0024, contracts §4).
 */
import { effect, signal } from '@preact/signals'
import { ingestionErrorFromFormatRefusal } from '../../app/contracts/canopi-design-errors'
import { flattenDocumentForJson } from '../../app/contracts/document'
import type { DraftId } from '../../platform/design-home'
import { editionPorts, hasEditionPorts } from '../../platform/edition-ports'
import { draftNameFromBytes } from '../../platform/draft-records-move'
import { setDesignName } from '../../app/design-edit'
import {
  closeDesign,
  designRevertAvailable,
  designSaveFailureReason,
  designSaveStatus,
  newDesignAction,
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
import { presentBrowserDraftOpenFailure, presentBrowserStorageUncheckedNotice } from '../../web/browser-notices'
import { downloadBrowserTextFile, pickBrowserTextFile } from '../../web/browser-text-files'

export const webLaunching = signal(false)
const webStorageUnchecked = signal(false)

export function setWebLaunching(next: boolean): void {
  webLaunching.value = next
}

/** True when IndexedDB `canopi-drafts` could not be opened/checked (2.1-Q334). */
export function setWebStorageUnchecked(next: boolean): void {
  webStorageUnchecked.value = next
}

export function isWebStorageUnchecked(): boolean {
  return webStorageUnchecked.value
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
  const core = editionPorts().designCore
  let rawBytes: Uint8Array | null = null
  if (webStorageUnchecked.peek()) {
    const raw = browserAppDataStore.loadRawDraft(id)
    if (raw) rawBytes = new TextEncoder().encode(JSON.stringify(raw))
  } else if (hasEditionPorts()) {
    const read = await editionPorts().designHome.read(id)
    if (read.kind === 'present') rawBytes = new Uint8Array(read.bytes)
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

async function openLegacyDraftReadOnly(id: string): Promise<boolean> {
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

export async function openWebDraft(id: string): Promise<boolean> {
  // 2.1-Q334 (canopi-2b6q): when IndexedDB could not be checked/opened, open the 2.0-key Draft read-only with Download a copy.
  if (webStorageUnchecked.peek()) {
    return openLegacyDraftReadOnly(id)
  }
  try {
    const core = requireLiveSessionCore()
    const res = await core.openFrom({ kind: 'draft', id: id as DraftId })
    if (res.status === 'refused') {
      // 2.1-Q40 / 2.1-Q337: a newer store or versionchange already raised the one Reload notice; stay quiet here.
      if (res.reason === 'draft_store_newer') return false
      const kind = res.error && typeof res.error === 'object' ? (res.error as { readonly kind?: unknown }).kind : undefined
      if (kind === 'missing' || kind === 'unreadable') {
        presentBrowserDraftOpenFailure()
      } else {
        presentDesignOpenFailure(res.error ?? new Error(res.reason))
      }
      return false
    }
    return res.status === 'opened' || res.status === 'already-open'
  } catch {
    // Missing or unreadable Draft; tell the user and let welcome screen re-list.
    presentBrowserDraftOpenFailure()
    return false
  }
}

function listWebDrafts(): readonly BrowserDraftSummary[] {
  return browserAppDataStore.listDrafts()
}

export interface WebDraftListing {
  readonly editable: readonly BrowserDraftSummary[]
  readonly readOnly: readonly BrowserDraftSummary[]
}

export function initialWebDraftListing(): WebDraftListing & { readonly loading: boolean } {
  if (webStorageUnchecked.peek()) {
    return { editable: [], readOnly: browserAppDataStore.listDrafts(), loading: false }
  }
  if (!hasEditionPorts() || !('listDrafts' in editionPorts().designHome)) {
    return { editable: listWebDrafts(), readOnly: [], loading: false }
  }
  return { editable: [], readOnly: [], loading: true }
}

export async function listWebDraftsAsync(): Promise<WebDraftListing> {
  if (webStorageUnchecked.peek()) {
    return { editable: [], readOnly: browserAppDataStore.listDrafts() }
  }
  if (!hasEditionPorts()) return { editable: listWebDrafts(), readOnly: [] }
  const home = editionPorts().designHome
  if (!('listDrafts' in home)) return { editable: listWebDrafts(), readOnly: [] }
  const records = await home.listDrafts()
  return {
    editable: records.map((record) => ({
      id: record.id,
      name: draftNameFromBytes(record.bytes),
      updatedAt: record.updatedAt,
    })),
    readOnly: [],
  }
}

export async function deleteWebDraft(id: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
  if (webStorageUnchecked.peek()) {
    return { ok: false, error: new Error(`The Draft ${id} cannot be deleted while browser storage is unchecked`) }
  }
  const core = getLiveSessionCore()
  if (!core) {
    return { ok: false, error: new Error(`No live session available to delete Draft ${id}`) }
  }
  const res = await core.deleteDraft(id as never)
  return res.ok ? { ok: true } : { ok: false, error: new Error(res.reason) }
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
