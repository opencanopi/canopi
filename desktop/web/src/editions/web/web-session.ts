/**
 * editions/web/web-session.ts: Web Edition Session Core actions and Draft/file helpers
 * (ADR 0024, contracts §4).
 */
import { effect, signal } from '@preact/signals'
import { encodeCanopiDesign } from '../../app/contracts/canopi-design-wire'
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
import { presentBrowserDraftOpenFailure } from '../../web/browser-notices'
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

export function currentWebDesignText(): string | null {
  const core = getLiveSessionCore()
  const open = core?.currentDesign.peek()
  if (!core || !open || (open.readOnly && open.savedByVersion !== null)) return null
  const snap = core.snapshot()
  return snap ? JSON.stringify(encodeCanopiDesign(snap), null, 2) : null
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

export async function downloadWebCanopi(): Promise<void> {
  const core = requireLiveSessionCore()
  const snap = core.snapshot()
  if (!snap) return
  const text = JSON.stringify(encodeCanopiDesign(snap), null, 2)
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
  const file = newerDrafts.hides(id) ? null : browserAppDataStore.loadDraft(id)
  if (!file) throw new Error('Draft not found')
  const text = JSON.stringify(encodeCanopiDesign(file), null, 2)
  downloadBrowserTextFile(canopiDownloadName(file.name), text, 'application/json')
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
