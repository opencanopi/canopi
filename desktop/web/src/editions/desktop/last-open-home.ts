/**
 * editions/desktop/last-open-home.ts: Production Desktop `last_open_home` reader and writer
 * wired to 2e-1's durable `last_open_home` settings row (2b-4; contracts §4, 2.1-Q127, 2.1-M523).
 *
 * Never stores a raw filesystem path or ephemeral `FileGrantId`: file homes are encoded as
 * `file:<sha256-of-path>` and resolved on launch against `getRecentFiles()`; draft homes are
 * encoded as `draft:<DraftId>`.
 */
import { effect, type ReadonlySignal } from '@preact/signals'
import type { DesignSummary, DraftId, LastOpenHome } from '../../generated/contracts'
import type { DesignHome } from '../../app/document-session/continuous-save'
import type { LastOpenHomePort } from '../../app/document-session/launch-file'
import { flushSettingsProjection, mutateSettingsProjection } from '../../app/settings/projection'
import { lastOpenHome } from '../../app/settings/state'

async function recentIdForPath(path: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function decodeLastOpenHome(raw: string | null | undefined): LastOpenHome | null {
  if (!raw) return null
  const colon = raw.indexOf(':')
  const value = colon > 0 ? raw.slice(colon + 1).trim() : ''
  if (!value) return null
  const kind = raw.slice(0, colon)
  if (kind === 'draft') return { kind: 'draft', id: value as DraftId }
  if (kind === 'file') return { kind: 'file', recent_id: value }
  return null
}

export interface DesktopLastOpenHomePortDeps {
  readonly settingsReady: Promise<void>
  readonly getRecentFiles: () => Promise<DesignSummary[]>
}

/** Builds the `LastOpenHomePort` passed to `installLaunchFile` at Desktop boot. */
export function createDesktopLastOpenHomePort(
  deps: DesktopLastOpenHomePortDeps,
): LastOpenHomePort {
  return {
    async read() {
      await deps.settingsReady
      return decodeLastOpenHome(lastOpenHome.peek())
    },
    async clear() {
      mutateSettingsProjection((draft) => {
        draft.lastOpenHome = null
      })
      await flushSettingsProjection()
    },
    async resolveFilePath(recentId: string) {
      const recent = await deps.getRecentFiles()
      for (const entry of recent) {
        if ((await recentIdForPath(entry.path)) === recentId) {
          return entry.path
        }
      }
      return null
    },
  }
}

export interface DesktopLastOpenHomeWriterDeps {
  readonly currentDesign: ReadonlySignal<unknown | null>
  readonly designPath: ReadonlySignal<string | null>
  readonly saveStatus: ReadonlySignal<string>
  readonly readHome: () => DesignHome | null
}

/**
 * Observes the live Desktop Design Session and persists `last_open_home` through the
 * settings projection whenever a Design opens, rehomes (Save As), or closes.
 *
 * Does not clear `last_open_home` on initial empty boot before a Design has been opened,
 * so `installLaunchFile` can read and reopen the previous session's home first.
 */
export function installDesktopLastOpenHomeWriter(
  deps: DesktopLastOpenHomeWriterDeps,
): () => void {
  let disposed = false
  let hadOpenDesign = false
  let sequence = 0

  const persistEncoded = (encoded: string | null) => {
    if (disposed || lastOpenHome.peek() === encoded) return
    mutateSettingsProjection((draft) => {
      draft.lastOpenHome = encoded
    })
  }

  const stop = effect(() => {
    const open = deps.currentDesign.value !== null
    // Subscribe to path and save-status transitions so Save As / rehome updates `last_open_home`.
    void deps.designPath.value
    void deps.saveStatus.value
    const token = ++sequence

    if (!open) {
      if (hadOpenDesign) {
        hadOpenDesign = false
        persistEncoded(null)
      }
      return
    }

    hadOpenDesign = true
    const home = deps.readHome()
    if (!home) return

    if (home.kind === 'draft') {
      persistEncoded(`draft:${home.id}`)
      return
    }

    void recentIdForPath(home.path).then((recentId) => {
      if (disposed || token !== sequence) return
      persistEncoded(`file:${recentId}`)
    })
  })

  return () => {
    disposed = true
    stop()
  }
}
