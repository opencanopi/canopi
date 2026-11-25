import { effect, signal, untracked, type ReadonlySignal, type Signal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { currentCanvasQuerySurface } from '../../canvas/session'
import type { SavedView } from '../../generated/contracts'
import { currentDesign, designSessionStore } from '../document-session/store'
import { locale, mapLayers, theme } from '../settings/state'
import {
  captureSavedViewSnapshot,
  savedViewPresentedLabels,
  ViewSnapshotSceneBusyError,
  VIEW_SNAPSHOT_THUMBNAIL,
} from './snapshot'

// Saved view thumbnails: small off-screen snapshots of each view, a session
// cache that is never written to the Design. An entry is drawn again only when
// what it depends on changes (the view, the Scene revision, the background
// settings, the locale or the theme, and, for a view saved without its framed
// ground, the settled workspace size the image is fitted to), never on render.
// Captures run one at a time, a short while after the last change, and retry
// while an edit owns the Scene. Every object URL is revoked when it is replaced, when its view goes
// away, when another Design replaces this one and on HMR.

interface SavedViewThumbnail {
  /** Object URL of the latest image; a stale image stays until the new one is ready. */
  readonly url: string | null
  readonly status: 'loading' | 'ready' | 'failed'
}

export interface SavedViewThumbnailCacheOptions {
  /** Resolves the image, null when there is nothing to draw; rejects with `ViewSnapshotSceneBusyError` while an edit owns the Scene. */
  capture(view: SavedView, signal: AbortSignal): Promise<Blob | null>
  createUrl(blob: Blob): string
  revokeUrl(url: string): void
  /** Wait after a change before drawing, so a burst of edits draws once. */
  readonly settleMs?: number
  /** Wait before trying again while an edit owns the Scene. */
  readonly busyRetryMs?: number
  readonly maxBusyRetries?: number
}

export interface SavedViewThumbnailCache {
  /** The thumbnail of a view; draws it when `key` differs from the one it was drawn for. */
  request(view: SavedView, key: string): ReadonlySignal<SavedViewThumbnail>
  /** The current thumbnail of a view without asking for one. */
  read(viewId: string): ReadonlySignal<SavedViewThumbnail>
  /** Forgets every view not listed, revoking its image. */
  retain(viewIds: ReadonlySet<string>): void
  /** Forgets everything and stops drawing. */
  clear(): void
}

interface Entry {
  view: SavedView
  key: string
  /** The key the current image was drawn for. */
  drawnKey: string | null
  busyRetries: number
  readonly state: Signal<SavedViewThumbnail>
}

const EMPTY: SavedViewThumbnail = Object.freeze({ url: null, status: 'loading' })

export function createSavedViewThumbnailCache(options: SavedViewThumbnailCacheOptions): SavedViewThumbnailCache {
  const settleMs = options.settleMs ?? 400
  const busyRetryMs = options.busyRetryMs ?? 500
  const maxBusyRetries = options.maxBusyRetries ?? 40
  const entries = new Map<string, Entry>()
  const idle = new Map<string, Signal<SavedViewThumbnail>>()
  const queue: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: AbortController | null = null

  function entryFor(viewId: string): Entry | null {
    return entries.get(viewId) ?? null
  }

  function schedule(delay: number): void {
    if (timer !== null || running) return
    timer = setTimeout(() => {
      timer = null
      void drawNext()
    }, delay)
  }

  function enqueue(viewId: string): void {
    if (!queue.includes(viewId)) queue.push(viewId)
    schedule(settleMs)
  }

  async function drawNext(): Promise<void> {
    const viewId = queue.shift()
    const entry = viewId === undefined ? null : entryFor(viewId)
    if (!entry || entry.drawnKey === entry.key) {
      if (queue.length > 0) schedule(0)
      return
    }
    const controller = new AbortController()
    running = controller
    const key = entry.key
    let blob: Blob | null = null
    let outcome: 'drawn' | 'busy' | 'failed' = 'drawn'
    try {
      blob = await options.capture(entry.view, controller.signal)
      if (!blob) outcome = 'failed'
    } catch (error) {
      outcome = error instanceof ViewSnapshotSceneBusyError ? 'busy' : 'failed'
    }
    if (running === controller) running = null
    if (controller.signal.aborted) return
    const current = entryFor(entry.view.id)
    if (current === entry && entry.key === key) {
      if (outcome === 'drawn' && blob) {
        const previous = entry.state.peek().url
        entry.state.value = { url: options.createUrl(blob), status: 'ready' }
        entry.drawnKey = key
        entry.busyRetries = 0
        if (previous) options.revokeUrl(previous)
      } else if (outcome === 'busy' && entry.busyRetries < maxBusyRetries) {
        // An edit owns the Scene: every view waits for it, not just this one.
        entry.busyRetries += 1
        queue.push(entry.view.id)
        schedule(busyRetryMs)
        return
      } else {
        entry.drawnKey = key
        entry.state.value = { url: entry.state.peek().url, status: 'failed' }
      }
    }
    if (queue.length > 0) schedule(0)
  }

  function forget(viewId: string): void {
    const entry = entries.get(viewId)
    if (!entry) return
    entries.delete(viewId)
    const url = entry.state.peek().url
    if (url) options.revokeUrl(url)
    entry.state.value = EMPTY
  }

  return {
    request(view, key) {
      let entry = entries.get(view.id)
      if (!entry) {
        const state = idle.get(view.id) ?? signal(EMPTY)
        idle.delete(view.id)
        entry = { view, key, drawnKey: null, busyRetries: 0, state }
        entries.set(view.id, entry)
        enqueue(view.id)
        return entry.state
      }
      entry.view = view
      if (entry.key !== key) {
        entry.key = key
        entry.busyRetries = 0
        if (entry.state.peek().status !== 'loading') {
          entry.state.value = { url: entry.state.peek().url, status: 'loading' }
        }
        enqueue(view.id)
      }
      return entry.state
    },
    read(viewId) {
      const entry = entries.get(viewId)
      if (entry) return entry.state
      let state = idle.get(viewId)
      if (!state) {
        state = signal(EMPTY)
        idle.set(viewId, state)
      }
      return state
    },
    retain(viewIds) {
      for (const viewId of [...entries.keys()]) {
        if (!viewIds.has(viewId)) forget(viewId)
      }
      for (const viewId of [...idle.keys()]) {
        if (!viewIds.has(viewId)) idle.delete(viewId)
      }
    },
    clear() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      running?.abort()
      running = null
      queue.length = 0
      for (const viewId of [...entries.keys()]) forget(viewId)
      idle.clear()
    },
  }
}

/**
 * What a view's thumbnail depends on besides the view itself. Reading it in a
 * component subscribes the component to those signals.
 */
function savedViewThumbnailKey(view: SavedView): string {
  const sceneRevision = currentCanvasQuerySurface.value?.revision.scene.value ?? -1
  const layers = mapLayers.value
  return JSON.stringify([
    sceneRevision,
    view.camera,
    view.visible_layers,
    view.highlighted.species,
    readLabels(view),
    layers.basemap.style,
    layers.basemap.opacity,
    layers.satellite.opacity,
    layers.softenBackground,
    locale.value,
    theme.value,
  ])
}

function readLabels(view: SavedView): string {
  // Subscribes to the Design so a changed label choice draws again.
  void currentDesign.value
  return savedViewPresentedLabels(view)
}

const thumbnailCache = createSavedViewThumbnailCache({
  async capture(view, signal) {
    const snapshot = await captureSavedViewSnapshot(view, { ...VIEW_SNAPSHOT_THUMBNAIL, type: 'image/webp', quality: 0.8, signal })
    return snapshot?.blob ?? null
  },
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
})

/** Asks for a view's thumbnail now; draws it only when its key changed. */
export function requestSavedViewThumbnail(view: SavedView): ReadonlySignal<SavedViewThumbnail> {
  // A menu asks outside render; nothing here should subscribe its caller.
  return thumbnailCache.request(view, untracked(() => savedViewThumbnailKey(view)))
}

/** The thumbnail of a view as last drawn, without asking for one. */
export function savedViewThumbnail(viewId: string): ReadonlySignal<SavedViewThumbnail> {
  return thumbnailCache.read(viewId)
}

/** A component's view thumbnail: asks for it after render, whenever what it shows changes. */
export function useSavedViewThumbnail(view: SavedView): SavedViewThumbnail {
  const key = savedViewThumbnailKey(view)
  useEffect(() => {
    thumbnailCache.request(view, key)
  }, [view, key])
  return thumbnailCache.read(view.id).value
}

let thumbnailSession: object | null = null
// Views that go away lose their images; another Design starts a fresh cache.
const disposeThumbnailRetention = effect(() => {
  const session = designSessionStore.sessionIdentity.value
  const views = currentDesign.value?.views ?? []
  if (thumbnailSession !== session) {
    thumbnailSession = session
    thumbnailCache.clear()
    return
  }
  thumbnailCache.retain(new Set(views.map((view) => view.id)))
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeThumbnailRetention()
    thumbnailCache.clear()
  })
}
