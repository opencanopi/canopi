import { effect } from '@preact/signals'
import type { SatelliteConfig } from './satellite-provider'
import {
  SatelliteImageryProvider,
  type SatelliteState,
  type SatelliteViewport,
} from './satellite-provider-session'
import { createBrowserSatelliteHttp } from './satellite-http'
import type { BasemapTileAuth } from './basemap-tile-auth'
import {
  reconcileSatelliteContribution,
  setSatelliteContributionVisibility,
  type SatelliteReconcileTarget,
} from './satellite-contribution'

/**
 * Whether a mounted map can accept a source and layer yet.
 *
 * MapLibre loads even an inline JSON style asynchronously, and `addSource`
 * throws `Style is not done loading.` before that finishes. A ready keyless
 * provider would therefore break map initialization if the contribution were
 * applied straight from `onCreate`, so the mount waits for this.
 */
interface MapStyleReadiness {
  isReady(): boolean
  /**
   * Wait for the style once. The callback runs at most once, and firing or
   * disposing removes every listener the wait registered. Returns the disposer;
   * the caller owns it and keeps at most one pending wait.
   */
  whenReady(listener: () => void): () => void
}

/**
 * Create the provider the live map should use.
 *
 * The provider is a per-map-lifetime resource: session and viewport requests
 * belong to the active provider generation *and* the map lifetime, so a map
 * creates its own and disposes it with the map rather than a module-level
 * singleton outliving the surface that owns it.
 *
 * The configuration is supplied as a getter rather than as values, so a
 * device-local key or a locale change reaches a provider that is already
 * serving a live map: `update()` re-reads it, and no caller has to capture the
 * key at map-creation time and go stale.
 */
export function createSatelliteImagery(
  tileAuth: BasemapTileAuth,
  readConfig: () => SatelliteConfig,
): SatelliteImageryProvider {
  return new SatelliteImageryProvider(
    createBrowserSatelliteHttp(),
    readConfig,
    () => Date.now(),
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tileAuth,
  )
}

/**
 * Observe the effective key and application locale for one map lifetime.
 *
 * A getter without an observer is insufficient: an already mounted provider
 * must be updated when any of these change, so the configuration identity is
 * re-evaluated and an incompatible session is replaced. Returns its disposer.
 */
function installSatelliteConfigObserver(
  provider: SatelliteImageryProvider,
  readViewport: () => SatelliteViewport,
): () => void {
  let mounted = false
  return effect(() => {
    // Subscribe to every configuration identity input: the provider's getter (readSatelliteConfig) reads the settings
    // signals.
    void provider.config()
    // The caller already applied the initial configuration; only later
    // configuration identity changes update the already mounted provider.
    if (!mounted) {
      mounted = true
      return
    }
    try {
      provider.update(readViewport())
    } catch {
      // A map that rejects the new contribution reports through its own
      // failure watcher; a settings change must not become an unhandled throw.
    }
  })
}

/**
 * Read style readiness from a live map and its lifetime.
 *
 * Ready means the style accepts sources and layers. MapLibre's own flag for
 * that (`style._loaded`, what `addSource` checks) is read first: the public
 * `isStyleLoaded()` also stays false while any tile, sprite or source update
 * is loading, which on a map that already loaded is not followed by another
 * `load` or `style.load`. `isStyleLoaded()` is the fallback; it returns
 * nothing on a map with no style yet, which is not ready.
 */
export function mapStyleReadiness(
  map: { isStyleLoaded(): boolean | void },
  lifetime: {
    on(type: string, listener: (event?: unknown) => void): void
    off(type: string, listener: (event?: unknown) => void): void
  },
): MapStyleReadiness {
  const isReady = (): boolean => {
    const loaded = (map as { style?: { _loaded?: unknown } }).style?._loaded
    if (typeof loaded === 'boolean') return loaded
    try {
      return map.isStyleLoaded() === true
    } catch {
      return false
    }
  }
  return {
    isReady,
    whenReady: (listener) => {
      let settled = false
      const release = () => {
        if (settled) return
        settled = true
        for (const type of READY_EVENTS) lifetime.off(type, onReady)
        for (const type of RECHECK_EVENTS) lifetime.off(type, onRecheck)
      }
      // `load` and `style.load` both signal readiness; whichever comes first
      // wins and a later style reload is not this wait's business.
      const onReady = () => {
        if (settled) return
        release()
        listener()
      }
      // A map that already loaded fires neither again: readiness lost to
      // loading tiles returns on one of these, so each re-checks it.
      const onRecheck = () => {
        if (settled || !isReady()) return
        onReady()
      }
      for (const type of READY_EVENTS) lifetime.on(type, onReady)
      for (const type of RECHECK_EVENTS) lifetime.on(type, onRecheck)
      return release
    },
  }
}

const READY_EVENTS = ['load', 'style.load'] as const
const RECHECK_EVENTS = ['idle', 'data', 'sourcedata', 'styledata'] as const

/**
 * One per-map Satellite mount: the only place a live provider meets a live map.
 *
 * The provider owns the session, the viewport requests and the retry policy; the
 * map owns its camera, its scene and every other layer. The mount applies the
 * provider's published state to the Satellite source and layer once the style
 * can accept it, starts the provider from the current configuration at once,
 * follows later configuration and settled viewports, and on disposal releases
 * subscriptions, pending waits, requests and credentials and withdraws the
 * contribution. It never calls `setStyle()` and never recreates the map, which
 * is what lets a key change or a re-issued session happen mid-edit without
 * disturbing the camera, the scene runtime or placement. Where request
 * transformation must exist before map construction, the map host creates that
 * credential capability and supplies it; this mount never installs a second
 * transform.
 */
export interface SatelliteMountOptions {
  /**
   * The provider this mount drives and disposes (`createSatelliteImagery`), built on the map's credential owner. Without
   * one an official provider has nothing to authenticate its tiles, and the mount withholds the contribution rather
   * than requesting an unresolved `{session}` template.
   */
  readonly provider: SatelliteImageryProvider
  /** The map's own methods; the mount adds the credit callback. */
  readonly map: Omit<SatelliteReconcileTarget, 'replaceSatelliteAttribution'>
  readonly readViewport: () => SatelliteViewport
  readonly styleReady: MapStyleReadiness
  /** Where the raster layer belongs in the map's own stack. */
  readonly beforeLayerId: () => string | null
  /**
   * Runs after the contribution and visibility are applied: paint state the
   * map keeps on the Satellite layer (its opacity) is re-applied whenever the
   * contribution is replaced, and only then.
   */
  readonly afterApply: () => void
  /** Lifetime-owned event registration from the map host: `moveend`, registered once and removed on disposal. */
  readonly events: {
    on(type: string, listener: () => void): void
    off(type: string, listener: () => void): void
  }
  readonly replaceSatelliteAttribution: (attribution: string) => void
  /**
   * Every state the provider publishes, from the one it holds at mount, at once and whether or not the style is ready:
   * the background band derives the map notice's status from it.
   */
  readonly onState?: (state: SatelliteState) => void
}

export interface SatelliteMountHandle {
  update(viewport: SatelliteViewport): void
  dispose(): void
}

export function mountSatelliteLifecycle(options: SatelliteMountOptions): SatelliteMountHandle {
  const { provider, map, styleReady } = options
  // Delegate explicitly: a live MapLibre map keeps its methods on the class
  // prototype, so spreading it would drop them.
  const target: SatelliteReconcileTarget = {
    getSource: (id) => map.getSource(id),
    getLayer: (id) => map.getLayer(id),
    removeLayer: (id) => map.removeLayer(id),
    removeSource: (id) => map.removeSource(id),
    addSource: (id, source) => map.addSource(id, source),
    addLayer: (layer, beforeId) => map.addLayer(layer, beforeId),
    setLayoutProperty: (id, name, value) => map.setLayoutProperty(id, name, value),
    replaceSatelliteAttribution: options.replaceSatelliteAttribution,
  }
  let disposed = false
  let pending: SatelliteState | null = null
  let cancelReadyWait: (() => void) | null = null

  const contribute = (state: SatelliteState): void => reconcileSatelliteContribution(target, state, {
    officialTilesResolvable: provider.officialTilesResolvable(),
    beforeLayerId: options.beforeLayerId,
  })

  const reconcile = (state: SatelliteState): void => {
    contribute(state)
    // Loading official metadata must not expose cached imagery.
    setSatelliteContributionVisibility(target, state.state === 'ready')
    options.afterApply()
  }

  const apply = (state: SatelliteState): void => {
    // The latest state always wins: a state that arrives while the style is
    // not ready is what gets applied when it is, not the one that happened to
    // arrive first. Every deferral keeps one wait pending, not only the one at
    // mount time, so a state published while tiles load is never dropped.
    pending = state
    if (!styleReady.isReady()) {
      if (!cancelReadyWait) {
        cancelReadyWait = styleReady.whenReady(() => {
          cancelReadyWait = null
          if (disposed) return
          const latest = pending ?? provider.snapshot()
          pending = null
          reconcile(latest)
        })
      }
      return
    }
    pending = null
    cancelReadyWait?.()
    cancelReadyWait = null
    reconcile(state)
  }

  // Adopt whatever the provider already published, then start it from the
  // current configuration: no movement, settings or style-ready event is
  // required before the first provider generation.
  options.onState?.(provider.snapshot())
  apply(provider.snapshot())
  const unsubscribe = provider.subscribe((state) => {
    options.onState?.(state)
    apply(state)
  })
  provider.update(options.readViewport())
  const disposeObserver = installSatelliteConfigObserver(provider, options.readViewport)
  const onMoveEnd = () => provider.updateViewport(options.readViewport())
  options.events.on('moveend', onMoveEnd)
  return {
    update: (viewport: SatelliteViewport) => provider.update(viewport),
    dispose: () => {
      disposed = true
      pending = null
      cancelReadyWait?.()
      cancelReadyWait = null
      options.events.off('moveend', onMoveEnd)
      disposeObserver()
      unsubscribe()
      // The provider clears the credential it published: a removed map must
      // not leave a live session token in a shared transport.
      provider.dispose()
      // Withdraw the contribution so teardown leaves no source, layer or
      // basemap-owned credit on a map that outlives the mount.
      try {
        contribute({ state: 'idle' })
      } catch {
        // A map that rejects withdrawal still tears down its own resources.
      }
    },
  }
}
