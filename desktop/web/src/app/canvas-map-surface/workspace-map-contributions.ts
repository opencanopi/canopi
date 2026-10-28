import { logMapError } from '../../maplibre/redact-credentials'
import type { MapLibreSurfaceContext } from '../../maplibre/surface'
import type { MapLibreMapInstance } from '../../maplibre/loader'
import {
  IDLE_MAPLIBRE_CANVAS_SURFACE_STATE,
  mapLibreCanvasSurfaceStateEquals,
  type MapLibreBasemapStatus,
  type MapLibreCanvasSurfaceState,
} from '../../maplibre/canvas-surface-state'
import { applyTerrainPaintUpdates, classifyTerrainSync, clearTerrain, rebuildTerrain } from '../../maplibre/terrain-sync'
import {
  TERRAIN_CONTOUR_LAYER_IDS,
  TERRAIN_CONTOUR_SOURCE_ID,
  TERRAIN_DEM_SOURCE_ID,
  TERRAIN_HILLSHADE_LAYER_ID,
  type TerrainLayerState,
} from '../../maplibre/terrain'
import { mapErrorResourceId } from '../../maplibre/map-error-owner'
import type { RasterDisplay, RasterDisplayLayer } from '../../maplibre/raster-display/adapter'
import {
  clearCanvasMapSurfaceOverlays,
  clearCanvasMapSurfaceSiteHover,
  clearCanvasMapSurfaceSiteOverlay,
  syncCanvasMapSurfaceOverlays,
  syncCanvasMapSurfaceSiteHover,
  syncCanvasMapSurfaceSiteOverlay,
  type CanvasMapSurfaceOverlaySnapshot,
} from './overlays'
import { siteMapOverlayIds, type SiteMapOverlay } from '../../maplibre/site-overlay'
import {
  clearUserLocationOverlay,
  syncUserLocationOverlay,
  userLocationOverlayIds,
  type UserLocationReading,
} from '../../maplibre/user-location-overlay'
import { createMapLayerStackDescriptors, reconcileMapLayerStack } from '../map-layers/bands'
import type { WorkspaceMapContributionAdapter, WorkspaceMapContributionSnapshot } from './workspace-map-contribution-adapter'

/**
 * A value the composition reads outside the contributions read (the profile chart's hover, the user location); a map's
 * contributions follow it while attached, so a Retry's new map starts from the current value.
 */
export interface ContributionFeed<T> {
  current(): T
  subscribe(listener: (value: T) => void): () => void
}

export interface WorkspaceMapContributionsOptions {
  readonly onFailure: (error: unknown) => void
  /** Desktop only: the chart hover ([lon, lat]), drawn by one setData outside the drain (architecture review finding 7). */
  readonly siteHover?: ContributionFeed<readonly [number, number] | null>
  /** Web only: the device location, drawn by one setData outside the drain like the chart hover (canopi-f47t.53). */
  readonly userLocation?: ContributionFeed<UserLocationReading | null>
  readonly loadTerrainSupport?: WorkspaceMapContributionAdapter['loadTerrainSupport']
  readonly createRasterDisplay?: WorkspaceMapContributionAdapter['createRasterDisplay']
  readonly onStateChange?: (state: MapLibreCanvasSurfaceState) => void
  readonly logError?: (message?: unknown, ...args: unknown[]) => void
}

/** Map-lifetime presentation owner. It never creates a map or writes a camera. */
export class WorkspaceMapContributions {
  private snapshot: WorkspaceMapContributionSnapshot | null = null
  private context: MapLibreSurfaceContext<MapLibreMapInstance> | null = null
  private state = IDLE_MAPLIBRE_CANVAS_SURFACE_STATE
  /** Map-lifetime owner of the upstream raster renderer (Desktop only). */
  private raster: RasterDisplay | null = null
  private terrain: TerrainLayerState | null = null
  private terrainTouched = false
  private terrainUnavailable = false
  private terrainGeneration = 0
  private revision = 0
  private styleReady = false
  private dirty = false
  private draining = false
  private failed = false
  private disposed = false
  /** Target set whose overlay failed; skipped until the Targets change. */
  private skippedOverlayKey: string | null = null
  /** Site data pin and line whose overlay failed; skipped until they change, so the panel highlights never go with them. */
  private skippedSiteKey: string | null = null
  /** The chart hover's ground point; never part of the snapshot, so it moves no revision. */
  private siteHover: readonly [number, number] | null = null
  private unsubscribeSiteHover: (() => void) | null = null
  /** The device reading; never part of the snapshot, so it moves no revision. It lives here and on the map only. */
  private userLocation: UserLocationReading | null = null
  private unsubscribeUserLocation: (() => void) | null = null
  /** A user location write is under way: a MapLibre error it raises synchronously leaves the clearing to it. */
  private syncingUserLocation = false
  private userLocationRejected = false
  /** A failing user location write is logged once per map. */
  private userLocationFailureLogged = false
  private rasterSkipped = false
  /** The layer the rasters were last told to draw beneath (`syncRaster`). */
  private rasterAnchor: string | undefined = undefined

  constructor(private readonly options: WorkspaceMapContributionsOptions) {}

  attach(context: MapLibreSurfaceContext<MapLibreMapInstance>): void {
    if (this.disposed) return
    this.context = context
    // The raster renderer adds its layers asynchronously after its module and
    // headers load; each change re-establishes the semantic band order.
    this.raster = this.options.createRasterDisplay?.(context.map, {
      onLayersChanged: () => this.restack(),
    }) ?? null
    this.siteHover = this.options.siteHover?.current() ?? null
    this.unsubscribeSiteHover = this.options.siteHover?.subscribe((hover) => this.setSiteHover(hover)) ?? null
    this.userLocation = this.options.userLocation?.current() ?? null
    this.unsubscribeUserLocation = this.options.userLocation?.subscribe((reading) => this.setUserLocation(reading)) ?? null
    this.publishState({ ...IDLE_MAPLIBRE_CANVAS_SURFACE_STATE, status: 'loading' })
  }

  /**
   * The profile chart's hover point, at scrub rate: one setData on the hover source, outside the drain, so it never re-runs
   * the raster sync, the panel overlays or the order and never moves the revision or the terrain generation (GeoLibre
   * `NativeProfileMap.setHover`). Each drain re-applies it after painting the site layers, which covers Retry.
   */
  setSiteHover(hover: readonly [number, number] | null): void {
    if (this.disposed) return
    this.siteHover = hover
    if (!this.live() || !this.styleReady || this.draining || !this.snapshot) return
    try {
      this.syncSiteHover(this.guardedMap(this.revision))
    } catch (error) {
      if (error !== STALE_CONTRIBUTION) this.fail(error)
    }
  }

  /**
   * The device location (Show my location), at fix rate: one setData on its own source, outside the drain, like the chart
   * hover. It draws only on a Design's map; each drain re-applies it, which covers Retry. A write that fails is cleared and
   * retried with the next reading, and its error is never logged: MapLibre's errors can echo the data they were given.
   */
  setUserLocation(reading: UserLocationReading | null): void {
    if (this.disposed) return
    this.userLocation = reading
    if (!this.live() || !this.styleReady || this.draining || !this.snapshot) return
    try {
      this.syncUserLocation(this.guardedMap(this.revision))
    } catch (error) {
      if (error !== STALE_CONTRIBUTION) this.fail(error)
    }
  }

  update(snapshot: WorkspaceMapContributionSnapshot | null): void {
    if (this.disposed || this.failed) return
    if (!snapshot || !this.snapshot || classifyTerrainSync(this.snapshot.terrain, snapshot.terrain) !== 'noop') {
      this.terrainUnavailable = false
    }
    this.snapshot = snapshot
    this.revision += 1
    this.terrainGeneration += 1
    this.dirty = true
    this.drain()
  }

  /** The map's first `style.load` admitted it, so contributions may install; a later one never reaches here (ADR 0004). */
  admitStyle(): void {
    if (!this.live()) return
    this.styleReady = true
    this.dirty = true
    this.drain()
  }

  /**
   * Routes a MapLibre error that names a resource this owner contributed.
   * Contributions are optional: a failing one is skipped, logged and noticed,
   * and the map stays admitted. Returns false for anything it does not own.
   */
  handleMapError(event: unknown): boolean {
    const id = mapErrorResourceId(event)
    if (id === null || !this.live()) return id !== null && isContributionResource(id)
    // upstream: W5
    if (/^mlrcog\d+-src-/.test(id) || this.raster?.layerIds().includes(id)) {
      // The upstream renderer draws a failed tile as transparent and keeps the
      // rest of the band; a source error is passive display degradation.
      this.log('Passive shared workspace raster error:', event)
      return true
    }
    if (TERRAIN_DEM_IDS.has(id) || TERRAIN_CONTOUR_IDS.has(id)) {
      const enabled = TERRAIN_DEM_IDS.has(id)
        ? this.snapshot?.terrain.hillshadeVisible
        : this.snapshot?.terrain.contoursVisible
      if (!enabled) return true
      this.revision += 1
      this.terrainGeneration += 1
      this.terrainUnavailable = true
      this.terrainFailed(event)
      return true
    }
    if (USER_LOCATION_IDS.has(id)) {
      // Never log the event: it can carry the reading. A write under way clears the dot when it returns.
      this.userLocationFailed()
      if (!this.syncingUserLocation) this.clearUserLocation()
      return true
    }
    if (SITE_OVERLAY_IDS.has(id)) {
      if (this.skippedSiteKey === null && this.snapshot) this.siteFailed(siteKey(this.snapshot.overlays.site), event)
      this.dirty = true
      this.drain()
      return true
    }
    if (id.startsWith(PANEL_TARGET_PREFIX)) {
      // MapLibre validation emits instead of throwing, often mid-sync; the
      // drain removes the partial overlay on its next pass.
      if (this.skippedOverlayKey === null && this.snapshot) this.overlayFailed(overlayKey(this.snapshot.overlays), event)
      this.dirty = true
      this.drain()
      return true
    }
    return false
  }

  /** The Basemap's download status, kept until the map goes. */
  setBasemapStatus(basemapStatus: MapLibreBasemapStatus): void {
    if (this.disposed) return
    this.publishState({ ...this.state, basemapStatus })
  }

  dispose(error?: unknown): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeSiteHover?.()
    this.unsubscribeSiteHover = null
    this.unsubscribeUserLocation?.()
    this.unsubscribeUserLocation = null
    this.userLocation = null
    this.revision += 1
    this.terrainGeneration += 1
    this.snapshot = null
    this.publishState({
      ...IDLE_MAPLIBRE_CANVAS_SURFACE_STATE,
      status: error ? 'error' : 'idle',
    })
    this.clear()
    // Map-lifetime teardown: the manager's layers, sources, protocol and
    // listeners go, and its worker client rejects queued and in-flight work.
    const raster = this.raster
    this.raster = null
    this.attempt('Failed to dispose the raster display:', () => raster?.dispose())
    this.context = null
  }

  private live(): boolean {
    return !this.disposed && !this.failed && this.context?.isCurrent() === true
  }

  private drain(): void {
    if (this.draining || !this.live() || !this.styleReady) return
    this.draining = true
    try {
      while (this.dirty && this.live()) {
        this.dirty = false
        const snapshot = this.snapshot
        const revision = this.revision
        if (!snapshot) {
          this.publishState(IDLE_MAPLIBRE_CANVAS_SURFACE_STATE)
          this.clear()
          continue
        }
        // Synchronous callbacks may replace or dispose the session during any map mutation.
        const map = this.guardedMap(revision)
        try {
          this.syncRaster(map, snapshot.lidar)
          this.syncOverlays(map, snapshot.overlays)
          this.syncSiteOverlay(map, snapshot.overlays.site)
          this.syncSiteHover(map)
          this.syncUserLocation(map)
          this.reconcileOrder(map, snapshot)
          this.publishState({ ...this.state, status: 'ready', layerSkipped: this.layerSkipped() })
          if (!this.current(revision)) continue
          void this.syncTerrain(map, snapshot, revision)
        } catch (error) {
          if (error !== STALE_CONTRIBUTION) this.fail(error)
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** Hand the desired band to the renderer, beneath the first higher Canopi layer. */
  private syncRaster(map: MapLibreMapInstance, layers: readonly Readonly<RasterDisplayLayer>[]): void {
    if (!this.raster) return
    const anchor = rasterAnchor(map)
    this.rasterAnchor = anchor
    try {
      this.raster.sync(layers, anchor)
      this.rasterSkipped = false
    } catch (error) {
      // Raster display is passive: a renderer that rejects the band never
      // disables editing or the other contributions.
      this.rasterSkipped = true
      this.log('Failed to sync the raster band:', error)
    }
  }

  /**
   * Panel Target overlays are optional decoration. A failing sync is rolled
   * back and skipped until the Targets change; a rollback that cannot remove
   * the partial overlay escapes to the hard failure path.
   */
  private syncOverlays(map: MapLibreMapInstance, overlays: CanvasMapSurfaceOverlaySnapshot): void {
    const key = overlayKey(overlays)
    if (this.skippedOverlayKey !== null) {
      if (this.skippedOverlayKey === key) {
        clearCanvasMapSurfaceOverlays(map)
        return
      }
      this.skippedOverlayKey = null
    }
    try {
      syncCanvasMapSurfaceOverlays(map, overlays)
    } catch (error) {
      if (error === STALE_CONTRIBUTION) throw error
      this.overlayFailed(key, error)
      clearCanvasMapSurfaceOverlays(map)
    }
  }

  private overlayFailed(key: string, error: unknown): void {
    this.skippedOverlayKey = key
    this.log('Skipped a map overlay that failed to sync:', error)
  }

  /**
   * The Site data pin and line, on their own skip key: a failing sync is rolled back and skipped until they change, and the
   * panel Target overlays stay drawn. A rollback that cannot remove the partial overlay escapes to the hard failure path.
   */
  private syncSiteOverlay(map: MapLibreMapInstance, site: SiteMapOverlay | null): void {
    const key = siteKey(site)
    if (this.skippedSiteKey !== null) {
      if (this.skippedSiteKey === key) {
        clearCanvasMapSurfaceSiteOverlay(map)
        return
      }
      this.skippedSiteKey = null
    }
    try {
      syncCanvasMapSurfaceSiteOverlay(map, site)
    } catch (error) {
      if (error === STALE_CONTRIBUTION) throw error
      this.siteFailed(key, error)
      clearCanvasMapSurfaceSiteOverlay(map)
    }
  }

  /** The hover ring sits on the pin and line: it draws only while they draw, and its failure skips them with it. */
  private syncSiteHover(map: MapLibreMapInstance): void {
    const site = this.snapshot?.overlays.site ?? null
    if (!site || this.skippedSiteKey !== null) {
      clearCanvasMapSurfaceSiteHover(map)
      return
    }
    try {
      syncCanvasMapSurfaceSiteHover(map, this.siteHover)
    } catch (error) {
      if (error === STALE_CONTRIBUTION) throw error
      this.siteFailed(siteKey(site), error)
      clearCanvasMapSurfaceSiteOverlay(map)
      this.publishState({ ...this.state, layerSkipped: this.layerSkipped() })
    }
  }

  /** Draws the reading; a write that fails, by throwing or by a MapLibre error event during it, is rolled back. */
  private syncUserLocation(map: MapLibreMapInstance): void {
    this.syncingUserLocation = true
    this.userLocationRejected = false
    try {
      syncUserLocationOverlay(map, this.userLocation)
    } catch (error) {
      if (error === STALE_CONTRIBUTION) throw error
      this.userLocationFailed()
    } finally {
      this.syncingUserLocation = false
    }
    // A rollback that cannot remove the partial dot escapes to the hard failure path, as the other overlays' do.
    if (this.userLocationRejected) clearUserLocationOverlay(map)
  }

  /** Logs that the dot failed, once per map, never with the error: it can echo the reading. */
  private userLocationFailed(): void {
    this.userLocationRejected = true
    if (this.userLocationFailureLogged) return
    this.userLocationFailureLogged = true
    ;(this.options.logError ?? logMapError)('Skipped the user location map overlay that failed to draw.')
  }

  private clearUserLocation(): void {
    const revision = this.revision
    if (this.context) this.attempt('Failed to clear the user location map overlay:', () => clearUserLocationOverlay(this.guardedMap(revision)))
  }

  private siteFailed(key: string, error: unknown): void {
    this.skippedSiteKey = key
    this.log('Skipped the Site data map overlay that failed to sync:', error)
  }

  private layerSkipped(): boolean {
    return this.skippedOverlayKey !== null || this.skippedSiteKey !== null || this.rasterSkipped
  }

  /**
   * The map's layers changed outside the drain (the renderer added a raster, activation added the scene layer); restore
   * the semantic order.
   */
  restack(): void {
    if (!this.live() || !this.styleReady || !this.snapshot || this.draining) return
    const revision = this.revision
    try {
      this.reconcileOrder(this.guardedMap(revision), this.snapshot)
    } catch (error) {
      if (error !== STALE_CONTRIBUTION) this.fail(error)
    }
  }

  private async syncTerrain(map: MapLibreMapInstance, snapshot: WorkspaceMapContributionSnapshot, revision: number): Promise<void> {
    const generation = ++this.terrainGeneration
    const current = () => this.current(revision) && generation === this.terrainGeneration
    const next = snapshot.terrain
    if (this.terrainUnavailable) return
    let rebuilt = false
    try {
      const mode = classifyTerrainSync(this.terrain, next)
      if (mode === 'clear' || ((!next.contoursVisible && !next.hillshadeVisible) && this.terrainTouched)) {
        clearTerrain(map)
        this.terrain = null
        this.terrainTouched = false
      } else if (mode === 'paint') {
        applyTerrainPaintUpdates(map, next)
        this.terrain = next
      } else if (mode === 'rebuild') {
        this.publishState({ ...this.state, terrainStatus: 'loading' })
        if (!current()) return
        if (!this.options.loadTerrainSupport) throw new Error('Terrain support is unavailable in this workspace.')
        const support = await this.options.loadTerrainSupport(this.context!.maplibre)
        if (!current()) return
        this.terrainTouched = true
        rebuildTerrain(map, support, next)
        if (!current()) return
        this.terrain = next
        rebuilt = true
      }
    } catch (error) {
      if (current() && error !== STALE_CONTRIBUTION) this.terrainFailed(error)
      return
    }
    if (!current()) return
    // Source/terrain failures are passive. The shared semantic stack is an
    // editing invariant, so ordering failure uses the hard map failure path.
    if (rebuilt) {
      try {
        this.reconcileOrder(map, this.snapshot!)
      } catch (error) {
        if (error !== STALE_CONTRIBUTION) this.fail(error)
        return
      }
    }
    if (current()) this.publishState({ ...this.state, terrainStatus: this.terrain ? 'ready' : 'idle' })
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failed) return
    this.failed = true
    try {
      // Let the map owner retain the original cause before cleanup callbacks
      // can synchronously emit a second error. The failure fence is already up.
      this.options.onFailure(error)
    } finally {
      this.dispose(error)
    }
  }

  private terrainFailed(error: unknown): void {
    this.terrainUnavailable = true
    const revision = this.revision
    try {
      if (this.context) clearTerrain(this.guardedMap(revision))
    } catch (cleanupError) {
      if (cleanupError !== STALE_CONTRIBUTION) this.fail(cleanupError)
      return
    }
    if (!this.current(revision)) return
    this.terrain = null
    this.publishState({ ...this.state, terrainStatus: 'error' })
    this.log('Failed to sync terrain layers:', error)
  }

  private reconcileOrder(map: MapLibreMapInstance, snapshot: WorkspaceMapContributionSnapshot): void {
    // The renderer puts its layers back beneath their anchor on every style change, so a higher Canopi layer added
    // since the last sync (a rebuilt map's scene layer, which comes after its first drain; terrain) re-anchors them
    // first, or the rasters would return above it.
    if (this.raster && rasterAnchor(map) !== this.rasterAnchor) this.syncRaster(map, snapshot.lidar)
    // Only layers the renderer has actually added take part; a layer still
    // loading its header is placed when it arrives.
    const present = this.raster?.layerIds() ?? []
    reconcileMapLayerStack(map, createMapLayerStackDescriptors(snapshot.lidar.map((layer) => layer.id).filter((id) => present.includes(id))))
  }

  private clear(): void {
    const revision = this.revision
    const map = this.context && this.guardedMap(revision, true)
    if (map) {
      this.attempt('Failed to clear map target overlays:', () => clearCanvasMapSurfaceOverlays(map))
      this.attempt('Failed to clear the Site data map overlay:', () => clearCanvasMapSurfaceSiteOverlay(map))
      this.attempt('Failed to clear the user location map overlay:', () => clearUserLocationOverlay(map))
      this.attempt('Failed to clear map terrain:', () => clearTerrain(map))
      this.attempt('Failed to clear map rasters:', () => this.raster?.sync([], undefined))
    }
    if (this.revision !== revision) return
    this.terrain = null
    this.terrainTouched = false
  }

  private current(revision: number): boolean {
    return this.live() && this.revision === revision
  }

  private guardedMap(revision: number, cleanup = false): MapLibreMapInstance {
    const ownedMap = this.context!.map
    const current = () => cleanup
      ? this.context?.map === ownedMap && this.revision === revision
      : this.current(revision)
    return new Proxy(ownedMap, {
      get: (map, property) => {
        const value = Reflect.get(map, property)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (!current()) throw STALE_CONTRIBUTION
          const result = Reflect.apply(value, map, args)
          if (!current()) throw STALE_CONTRIBUTION
          return result
        }
      },
    })
  }

  private publishState(state: MapLibreCanvasSurfaceState): void {
    if (mapLibreCanvasSurfaceStateEquals(this.state, state)) return
    this.state = state
    this.attempt('Map contribution state observer failed:', () => this.options.onStateChange?.(state))
  }

  private attempt(message: string, run: () => void): void {
    try { run() } catch (error) { if (error !== STALE_CONTRIBUTION) this.log(message, error) }
  }

  private log(message: string, error: unknown): void {
    (this.options.logError ?? logMapError)(message, error)
  }
}

/** The first Canopi layer above the LiDAR band now on the map: the rasters draw beneath it. */
function rasterAnchor(map: MapLibreMapInstance): string | undefined {
  const order = map.getLayersOrder()
  return createMapLayerStackDescriptors([])
    .filter((descriptor) => descriptor.band !== 'basemap')
    .map((descriptor) => descriptor.id)
    .find((id) => order.includes(id))
}

const STALE_CONTRIBUTION = Symbol('stale-map-contribution')
const PANEL_TARGET_PREFIX = 'panel-target-'
const TERRAIN_DEM_IDS = new Set<string>([TERRAIN_DEM_SOURCE_ID, TERRAIN_HILLSHADE_LAYER_ID])
const TERRAIN_CONTOUR_IDS = new Set<string>([TERRAIN_CONTOUR_SOURCE_ID, ...TERRAIN_CONTOUR_LAYER_IDS])
const SITE_OVERLAY_IDS = (() => {
  const ids = siteMapOverlayIds()
  return new Set<string>([ids.sourceId, ...ids.layerIds, ids.hover.sourceId, ...ids.hover.layerIds])
})()

const USER_LOCATION_IDS = (() => {
  const ids = userLocationOverlayIds()
  return new Set<string>([ids.sourceId, ...ids.layerIds])
})()

/** Late errors from a contribution this owner already removed stay passive. */
function isContributionResource(id: string): boolean {
  // upstream: W5
  return /^mlrcog\d+-/.test(id)
    || TERRAIN_DEM_IDS.has(id)
    || TERRAIN_CONTOUR_IDS.has(id)
    || id.startsWith(PANEL_TARGET_PREFIX)
    || SITE_OVERLAY_IDS.has(id)
    || USER_LOCATION_IDS.has(id)
}

/** Identity of the Target set an overlay draws; geometry is re-read on each sync. */
function overlayKey(overlays: CanvasMapSurfaceOverlaySnapshot): string {
  return JSON.stringify([overlays.hoveredTargets, overlays.selectedTargets])
}

/** Identity of the pin and line a site overlay draws. */
function siteKey(site: SiteMapOverlay | null): string {
  return JSON.stringify(site)
}
