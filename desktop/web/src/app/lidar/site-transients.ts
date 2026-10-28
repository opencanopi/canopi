// app/lidar/site-transients.ts
//
// Owns the Site data transients (canopi-f47t.42, spec §1.10, U49): the pinned point and the profile line, held in WGS84 so
// a re-origin of the session plane never moves them (ADR 0001). They end whenever Site data stops being the open side
// panel (switching panels, closing it, closing or replacing the Design), on leaving Canvas and on entering overview; Esc
// (layer 25 clears the profile, then layer 20 unpins), Unpin and the chart's × end one each. Every trigger lives here, so
// the pin hand-off (site-values.ts), the profile hand-off (profile.ts), the panel and the map overlay only read and call
// it. None of it is stored, printed or captured.

import { batch, computed, effect, signal, type ReadonlySignal } from '@preact/signals'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { designSessionStore } from '../document-session/store'
import { ESCAPE_PRIORITY, registerEscapeLayer } from '../keyboard/escape-chain'
import type { GeoPoint } from '../../generated/contracts'
import { activePanel, sidePanel } from '../shell/state'

const pinned = signal<GeoPoint | null>(null)
const line = signal<readonly GeoPoint[] | null>(null)

/** The pinned point whose values the rows show while the pointer is off the map; null when nothing is pinned. */
export const pin: ReadonlySignal<GeoPoint | null> = pinned

/** The finished profile line, two or more points; null when no profile is shown. */
export const profileLine: ReadonlySignal<readonly GeoPoint[] | null> = line

/** Site data can hold a pin or a profile only while its panel is the open side panel over the Canvas, in site mode. */
const siteDataOpen = computed(() =>
  activePanel.value === 'canvas'
  && sidePanel.value === 'site-data'
  && currentCanvasQuerySurface.value?.view.mode.value !== 'overview')

function finite(point: GeoPoint): boolean {
  return Number.isFinite(point.lon) && Number.isFinite(point.lat)
}

/** Pins one point (a new pin replaces the old); ignored unless Site data is open in site mode. */
export function setPin(point: GeoPoint): void {
  if (!siteDataOpen.peek() || !finite(point)) return
  pinned.value = { lon: point.lon, lat: point.lat }
}

export function unpin(): void {
  pinned.value = null
}

/** Shows a profile along a finished line (a new line replaces the old); ignored unless Site data is open in site mode. */
export function setProfileLine(points: readonly GeoPoint[]): void {
  if (!siteDataOpen.peek() || points.length < 2 || !points.every(finite)) return
  line.value = points.map((point) => ({ lon: point.lon, lat: point.lat }))
}

export function clearProfile(): void {
  line.value = null
}

/** Ends the pin and the profile together. */
export function endSiteDataTransients(): void {
  batch(() => {
    pinned.value = null
    line.value = null
  })
}

// The panel and Design triggers: a transient belongs to one Design session's open Site data panel.
let owner = designSessionStore.sessionIdentity.peek()
effect(() => {
  const identity = designSessionStore.sessionIdentity.value
  if (siteDataOpen.value && identity === owner) return
  owner = identity
  endSiteDataTransients()
})

// Spec §3.7: after the tool and the selection, one Esc clears the profile and the next unpins, from any focus but a
// text field or a modal, and only an unmodified Esc (as the tool layer).
for (const [priority, active, end] of [
  [ESCAPE_PRIORITY.profile, () => line.peek() !== null, clearProfile],
  [ESCAPE_PRIORITY['site-pin'], () => pinned.peek() !== null, unpin],
] as const) {
  registerEscapeLayer({
    priority,
    isActive: active,
    escape({ event, focus }) {
      if (focus === 'modal' || focus === 'text') return false
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false
      end()
      return true
    },
  })
}
