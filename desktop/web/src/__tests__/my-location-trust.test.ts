// The location trust boundary (canopi-f47t.53; design check A12): a device fix is the user's
// whereabouts, and its reading (dot, accuracy, time) never reaches a log, even when the map refuses it. Who may import
// the session and call the browser's geolocation is the policy rules location-session-only-in-button and
// geolocation-only-in-geolocation-module; the browser
// half (the saved .canopi, the Draft record and the saved-view path carry no fix) is e2e/canvas/my-location.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceMapContributions } from '../app/canvas-map-surface/workspace-map-contributions'
import type { WorkspaceMapContributionSnapshot } from '../app/canvas-map-surface/workspace-map-contribution-adapter'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import type { MapLibreApi, MapLibreMapInstance } from '../maplibre/loader'
import type { UserLocationReading } from '../maplibre/user-location-overlay'

/** The fix every trust case plants: its digits must never leave the session's reading. */
const FIX: UserLocationReading = { lon: 12.3456789, lat: 45.6789012, accuracy: 30, timestamp: 1_760_000_000_000, stale: false }
const FIX_DIGITS = '12.3456789'

/** A map whose GeoJSON writes fail the way a validation error can: by echoing the data it was given. */
class FailingSetDataMap implements MapLibreMapInstance {
  readonly sources = new Map<string, { setData(data: unknown): void }>()
  readonly order: string[] = ['basemap-background', 'canopi-shared-scene']
  /** Every write that carried the fix to the map. */
  readonly fixWrites: string[] = []
  jumpTo() {}
  resize() {}
  remove() {}
  on() {}
  off() {}
  addSource(id: string, source: Record<string, unknown>) {
    const text = JSON.stringify(source)
    if (text.includes(FIX_DIGITS)) {
      this.fixWrites.push(`addSource ${id}`)
      throw new Error(`addSource rejected ${id}: ${text}`)
    }
    this.sources.set(id, {
      setData: (data: unknown) => {
        const written = JSON.stringify(data)
        if (written.includes(FIX_DIGITS)) this.fixWrites.push(`setData ${id}`)
        throw new Error(`setData rejected ${id}: ${written}`)
      },
    })
  }
  getSource(id: string) { return this.sources.get(id) }
  removeSource(id: string) { this.sources.delete(id) }
  addLayer(layer: Record<string, unknown>) { this.order.push(String(layer.id)) }
  getLayersOrder() { return [...this.order] }
  moveLayer(id: string, before?: string) {
    const index = this.order.indexOf(id)
    if (index < 0) return
    this.order.splice(index, 1)
    const target = before ? this.order.indexOf(before) : -1
    this.order.splice(target < 0 ? this.order.length : target, 0, id)
  }
  setPaintProperty() {}
  getLayer(id: string) { return this.order.includes(id) ? { id } : undefined }
  removeLayer(id: string) {
    const index = this.order.indexOf(id)
    if (index >= 0) this.order.splice(index, 1)
  }
}

function emptySnapshot(): WorkspaceMapContributionSnapshot {
  const scene = createDefaultScenePersistedState()
  return {
    sessionIdentity: {},
    lidar: [],
    terrain: { contourIntervalMeters: 1, contoursVisible: false, contoursOpacity: 1, hillshadeVisible: false, hillshadeOpacity: 1, isDark: false },
    overlays: { runtime: { getSceneSnapshot: () => scene }, location: { lat: 48, lon: 2 }, hoveredTargets: [], selectedTargets: [], site: null },
  }
}

/** Everything any console method was given, as text (errors with their message and stack). */
function consoleText(spies: readonly ReturnType<typeof vi.spyOn>[]): string {
  const text = (value: unknown): string => {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}\n${text((value as { cause?: unknown }).cause)}`
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
  }
  return spies.flatMap((spy) => spy.mock.calls.flat().map(text)).join('\n')
}

describe('a location reading never reaches a log', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('logs no fix when the dot and accuracy source fail to take it', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const map = new FailingSetDataMap()
    const contributions = new WorkspaceMapContributions({ onFailure: () => {} })
    contributions.attach({ map, maplibre: {} as MapLibreApi, lifetime: { on() {}, off() {}, addCleanup() {} }, isCurrent: () => true })
    contributions.update(emptySnapshot())
    contributions.admitStyle()

    contributions.setUserLocation(FIX)

    expect(map.fixWrites, 'the reading reached the map, and its write failed').not.toEqual([])
    expect(consoleText(spies), 'no console output carries the fix').not.toContain(FIX_DIGITS)
  })
})
