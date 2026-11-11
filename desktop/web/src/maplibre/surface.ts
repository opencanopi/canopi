import { reportMapError } from './map-errors'
import { loadMapLibreModule, type MapLibreApi, type MapLibreMapInstance } from './loader'

type MapLibreSurfaceEventListener = (event?: unknown) => void
type MapLibreSurfaceLogError = (message?: unknown, ...optionalParams: unknown[]) => void

interface EventCapableMap {
  on(type: string, listener: MapLibreSurfaceEventListener): void
  off(type: string, listener: MapLibreSurfaceEventListener): void
}

interface MapLibreSurfaceResizeObserver {
  observe(target: Element): void
  disconnect(): void
}

/** What one map's request registered on it; the surface releases it, newest first, before it removes the map. */
export interface MapLibreSurfaceLifetime {
  on(type: string, listener: MapLibreSurfaceEventListener): void
  /** Unregister a listener registered through `on` before the map goes. */
  off(type: string, listener: MapLibreSurfaceEventListener): void
  addCleanup(cleanup: () => void): void
}

export interface MapLibreSurfaceContext<TMap extends MapLibreMapInstance> {
  readonly map: TMap
  readonly maplibre: MapLibreApi
  readonly lifetime: MapLibreSurfaceLifetime
  isCurrent(): boolean
}

/** The container's CSS size, as MapLibre reads it (clientWidth, clientHeight). */
interface MapLibreSurfaceSize {
  readonly width: number
  readonly height: number
}

interface MapLibreSurfaceRequest<TMap extends MapLibreMapInstance> {
  createMap(maplibre: MapLibreApi, container: HTMLElement): TMap
  onCreate?(context: MapLibreSurfaceContext<TMap>): void
  /**
   * The request's own resize owner (spec §1.1 "Resize"): the surface reports the container's new size and never resizes a map itself.
   * The workspace request hands the size to its camera driver; the World map, which has no driver, resizes its map.
   */
  onResize?(context: MapLibreSurfaceContext<TMap>, size: MapLibreSurfaceSize): void
  /** The request's own failure owner; without one, the surface logs the failure (redacted). */
  onCreateError?(error: unknown): void
}

interface MapLibreSurfaceDeps {
  readonly loadMapLibre?: () => Promise<MapLibreApi>
  readonly createResizeObserver?: (callback: ResizeObserverCallback) => MapLibreSurfaceResizeObserver | null
  readonly logError?: MapLibreSurfaceLogError
}

interface LiveMap<TMap extends MapLibreMapInstance> {
  readonly context: MapLibreSurfaceContext<TMap>
  readonly request: MapLibreSurfaceRequest<TMap>
  readonly lifetime: SurfaceLifetime
  /** Removes what the map's creation added to the container. */
  readonly rollback: () => void
}

/**
 * The one owner that creates and removes a MapLibre map in a container: it loads MapLibre, creates the request's map,
 * reports container resizes to the request, and on teardown releases what the request registered through its lifetime
 * before removing the map. No other code calls map.remove() on a map it created.
 */
export class MapLibreSurface<TMap extends MapLibreMapInstance = MapLibreMapInstance> {
  private readonly logError: MapLibreSurfaceLogError
  private container: HTMLElement | null = null
  private request: MapLibreSurfaceRequest<TMap> | null = null
  private live: LiveMap<TMap> | null = null
  private resizeObserver: MapLibreSurfaceResizeObserver | null = null
  /** Bumped by each removal, so a creation that started before it goes stale. */
  private generation = 0

  constructor(private readonly deps: MapLibreSurfaceDeps = {}) {
    this.logError = deps.logError ?? reportMapError
  }

  get map(): TMap | null {
    return this.live?.context.map ?? null
  }

  get maplibre(): MapLibreApi | null {
    return this.live?.context.maplibre ?? null
  }

  /** Replaces any map with the request's own, created in the container. */
  open(container: HTMLElement, request: MapLibreSurfaceRequest<TMap>): void {
    this.removeMap()
    this.container = container
    this.request = request
    void this.createMap()
  }

  destroy(): void {
    this.container = null
    this.request = null
    this.removeMap()
  }

  private async createMap(): Promise<void> {
    const { request, container, generation } = this
    if (!request || !container) return
    const stale = () => this.generation !== generation

    try {
      const maplibre = await (this.deps.loadMapLibre ?? loadMapLibreModule)()
      if (stale()) return

      const before = { children: new Set(container.children), classes: new Set(container.classList) }
      let map: TMap
      try {
        map = request.createMap(maplibre, container)
      } catch (error) {
        containerRollback(container, before)()
        throw error
      }
      const rollback = containerRollback(container, before)
      if (stale()) {
        removeMap(map, rollback)
        return
      }

      const lifetime = new SurfaceLifetime(map, this.logError)
      const context: MapLibreSurfaceContext<TMap> = {
        map,
        maplibre,
        lifetime,
        isCurrent: () => this.live?.context.map === map && this.generation === generation,
      }
      this.live = { context, request, lifetime, rollback }
      this.observeResize(container)
      request.onCreate?.(context)
    } catch (error) {
      if (stale()) return
      try {
        this.removeMap()
      } catch (removeError) {
        this.logSafely('Failed to remove MapLibre map after create failure:', removeError)
      }
      if (request.onCreateError) request.onCreateError(error)
      else this.logSafely('Failed to create MapLibre map:', error)
    }
  }

  private removeMap(): void {
    this.generation += 1
    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    const live = this.live
    this.live = null
    if (!live) return
    live.lifetime.clear()
    removeMap(live.context.map, live.rollback)
  }

  private observeResize(container: HTMLElement): void {
    this.resizeObserver = this.createResizeObserver(() => {
      const live = this.live
      if (!live?.context.isCurrent()) return
      live.request.onResize?.(live.context, { width: container.clientWidth, height: container.clientHeight })
    })
    this.resizeObserver?.observe(container)
  }

  private createResizeObserver(callback: ResizeObserverCallback): MapLibreSurfaceResizeObserver | null {
    if (this.deps.createResizeObserver) return this.deps.createResizeObserver(callback)
    if (typeof ResizeObserver === 'undefined') return null
    return new ResizeObserver(callback)
  }

  private logSafely(message: unknown, error: unknown): void {
    try {
      this.logError(message, error)
    } catch {
      // A failing diagnostic never hides the failure it reports.
    }
  }
}

/**
 * What a creation added to the container since `before`. MapLibre removes its own canvas, controls and class only when
 * its painter fails or remove() completes; a later constructor step, or a request's setup after the constructor, that
 * throws leaves them behind, and a Retry would stack a second map in the container.
 */
function containerRollback(container: HTMLElement, before: { children: Set<Element>, classes: Set<string> }): () => void {
  const children = Array.from(container.children).filter((child) => !before.children.has(child))
  const classes = Array.from(container.classList).filter((name) => !before.classes.has(name))
  return () => {
    for (const child of children) if (child.parentElement === container) child.remove()
    container.classList.remove(...classes)
  }
}

function removeMap(map: MapLibreMapInstance, rollback: () => void): void {
  try {
    map.remove()
  } finally {
    rollback()
  }
}

class SurfaceLifetime implements MapLibreSurfaceLifetime {
  private readonly cleanups: Array<() => void> = []
  /** Each `on` registration's cleanup, so an explicit `off` releases it as well as the live map listener. */
  private readonly registrations: Array<{ type: string, listener: MapLibreSurfaceEventListener, cleanup: () => void }> = []
  private cleared = false

  constructor(
    private readonly map: MapLibreMapInstance,
    private readonly logError: MapLibreSurfaceLogError,
  ) {}

  on(type: string, listener: MapLibreSurfaceEventListener): void {
    if (this.cleared) return
    const map = this.map as unknown as EventCapableMap
    map.on(type, listener)
    const cleanup = () => map.off(type, listener)
    this.registrations.push({ type, listener, cleanup })
    this.cleanups.push(cleanup)
  }

  off(type: string, listener: MapLibreSurfaceEventListener): void {
    ;(this.map as unknown as EventCapableMap).off(type, listener)
    const index = this.registrations.findIndex((entry) => entry.type === type && entry.listener === listener)
    if (index < 0) return
    const [registration] = this.registrations.splice(index, 1)
    const at = this.cleanups.indexOf(registration!.cleanup)
    if (at >= 0) this.cleanups.splice(at, 1)
  }

  addCleanup(cleanup: () => void): void {
    if (this.cleared) {
      this.runCleanup(cleanup)
      return
    }
    this.cleanups.push(cleanup)
  }

  clear(): void {
    this.cleared = true
    // Take the cleanups first, so a cleanup that unregisters another registration cannot run a later one twice.
    const pending = this.cleanups.splice(0)
    this.registrations.length = 0
    for (let i = pending.length - 1; i >= 0; i -= 1) this.runCleanup(pending[i]!)
  }

  private runCleanup(cleanup: () => void): void {
    try {
      cleanup()
    } catch (error) {
      this.logError('Failed to clean up MapLibre surface resource:', error)
    }
  }
}
