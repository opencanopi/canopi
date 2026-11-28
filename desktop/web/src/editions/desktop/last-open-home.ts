/**
 * editions/desktop/last-open-home.ts: Production Desktop `last_open_home` reader and home encoder
 * wired to 2e-1's durable `last_open_home` settings row (2b-4/2b-3; contracts §4, 2.1-Q127, 2.1-M523).
 */
import type { DesignSummary, FileHomeGrant } from '../../generated/contracts'
import type { LastOpenHomePort, ResolvedFileHome } from '../../app/document-session/launch-file'
import { flushSettingsProjection, mutateSettingsProjection } from '../../app/settings/projection'
import { lastOpenHome } from '../../app/settings/state'
import {
  decodeLastOpenHome,
  encodeLastOpenHome,
  recentFileIdForPath,
  type DesignHome,
} from '../../platform/design-home'

export interface DesktopLastOpenHomePortDeps {
  readonly settingsReady: Promise<void>
  readonly getRecentFiles: () => Promise<DesignSummary[]>
  readonly grantForRecent?: (recentId: string) => Promise<FileHomeGrant | null>
}

/** Encodes a Desktop `DesignHome` into the `last_open_home` settings string (opaque `recent_id` or draft id). */
export async function encodeDesktopLastOpenHome(home: DesignHome | null): Promise<string | null> {
  if (!home) return null
  if (home.kind === 'draft') return encodeLastOpenHome({ kind: 'draft', id: home.key })
  if (!home.recentId) return null
  return encodeLastOpenHome({ kind: 'file', recent_id: home.recentId })
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
    async resolveFileHome(recentId: string): Promise<ResolvedFileHome | null> {
      if (deps.grantForRecent) {
        const granted = await deps.grantForRecent(recentId)
        if (granted) {
          return {
            grant: granted.grant,
            displayName: granted.display_name,
            recentId: granted.recent_id,
          }
        }
      }
      const recent = await deps.getRecentFiles()
      for (const entry of recent) {
        const entryRecentId = entry.recent_id ?? (await recentFileIdForPath(entry.path))
        if (entryRecentId === recentId && entry.grant) {
          return {
            grant: entry.grant,
            displayName: entry.name,
            recentId: entryRecentId,
          }
        }
      }
      return null
    },
  }
}
