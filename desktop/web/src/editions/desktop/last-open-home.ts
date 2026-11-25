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

const DRAFT_PREFIX = 'draft:'
const FILE_PREFIX = 'file:'

/** Deterministic opaque Recent Designs identifier derived from a file path (no raw path persisted). */
async function recentIdForPath(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Encodes a typed `LastOpenHome` into the settings row's opaque string representation. */
function encodeLastOpenHome(home: LastOpenHome): string {
  return home.kind === 'draft' ? `${DRAFT_PREFIX}${home.id}` : `${FILE_PREFIX}${home.recent_id}`
}

/** Decodes a persisted `last_open_home` string into a typed `LastOpenHome`, or `null` if invalid. */
function decodeLastOpenHome(raw: string | null | undefined): LastOpenHome | null {
  if (!raw) return null
  if (raw.startsWith(DRAFT_PREFIX)) {
    const id = raw.slice(DRAFT_PREFIX.length).trim()
    return id ? { kind: 'draft', id: id as DraftId } : null
  }
  if (raw.startsWith(FILE_PREFIX)) {
    const recentId = raw.slice(FILE_PREFIX.length).trim()
    return recentId ? { kind: 'file', recent_id: recentId } : null
  }
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
      persistEncoded(encodeLastOpenHome({ kind: 'draft', id: home.id as DraftId }))
      return
    }

    void recentIdForPath(home.path).then((recentId) => {
      if (disposed || token !== sequence) return
      persistEncoded(encodeLastOpenHome({ kind: 'file', recent_id: recentId }))
    })
  })

  return () => {
    disposed = true
    stop()
  }
}
