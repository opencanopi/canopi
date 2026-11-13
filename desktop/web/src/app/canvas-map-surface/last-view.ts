import { designSessionStore } from '../document-session/store'
import { mutateSettingsProjection } from '../settings/projection'
import type { WorkspaceSettledView } from './workspace-runtime-composition'

/**
 * Remembers the settled view's centre and zoom as the app's last view (per device; spec §4.15). Both editions' settled
 * views pass through here, so this is the one owner of the read-only rule: a Design shown read-only writes no byte,
 * the device settings record included (design check 5c, 2.1-M478; canopi-f47t.52.270).
 */
export function persistLastView(view: WorkspaceSettledView): void {
  if (designSessionStore.isReadOnly()) return
  mutateSettingsProjection((settings) => {
    settings.lastView = { lon: view.lon, lat: view.lat, zoom: view.zoom }
  }, { persist: 'queued' })
}
