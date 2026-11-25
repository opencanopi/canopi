import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import {
  captureSavedViewSnapshot,
  composeSavedView,
  describeSavedViewSnapshot,
  savedViewPresentedLabels,
  VIEW_SNAPSHOT_THUMBNAIL,
  type SavedViewSnapshot,
} from '../../app/saved-views'
import { locale, mapLayers, type MapLayersState } from '../../app/settings/state'
import { readSatelliteConfig } from '../../app/settings/satellite-config'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { geographicViewOfCamera } from '../../geo/session-plane'
import { createViewSnapshotMap } from '../../maplibre/view-snapshot-map'
import type { SavedView } from '../../generated/contracts'
import styles from './gallery.module.css'

const SHORT_TIMEOUT_VIEW = 'Region, 50 ms timeout'

interface SnapshotRow {
  readonly label: string
  readonly mode: 'render-callback' | 'preserve-buffer'
  readonly url: string | null
  readonly snapshot: SavedViewSnapshot | null
  readonly error: string | null
}

/**
 * Captures saved views of the gallery Design off-screen while the workspace
 * stays where it is, for manual checks and cost measurement. Offline by
 * default (no background); `tiles=1` adds Basemap and Satellite views.
 */
export function GalleryViewSnapshots({ ready, tiles }: { readonly ready: boolean; readonly tiles: boolean }) {
  const rows = useSignal<readonly SnapshotRow[]>([])
  const running = useSignal(false)
  const run = useSignal(0)

  useEffect(() => {
    if (!ready) return
    const controller = new AbortController()
    const urls: string[] = []
    running.value = true
    rows.value = []
    void (async () => {
      const views = galleryViews(tiles)
      const next: SnapshotRow[] = []
      const push = (row: SnapshotRow) => {
        if (row.url) urls.push(row.url)
        next.push(row)
        rows.value = [...next]
      }
      for (const view of views) {
        push(await capture(view.name, 'render-callback', () => captureSavedViewSnapshot(view, {
          ...VIEW_SNAPSHOT_THUMBNAIL,
          signal: controller.signal,
          // A new area with almost no wait shows the "some tiles missing" flag.
          ...(view.id === SHORT_TIMEOUT_VIEW ? { timeoutMs: 50 } : {}),
        })))
      }
      if (views.length > 0) {
        // The same captures on a map whose drawing buffer is preserved, to
        // compare their cost with reading inside the frame's task.
        const preserving = createViewSnapshotMap({ readSatelliteConfig, preserveDrawingBuffer: true })
        try {
          for (const view of views.filter((entry) => entry.id !== SHORT_TIMEOUT_VIEW)) {
            push(await capture(view.name, 'preserve-buffer', () => {
              const request = describe(view, VIEW_SNAPSHOT_THUMBNAIL, controller.signal)
              return request ? preserving.capture(request) : Promise.resolve(null)
            }))
          }
        } finally {
          await preserving.dispose()
        }
      }
      if (!controller.signal.aborted) running.value = false
    })()
    return () => {
      controller.abort()
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [ready, tiles, run.value])

  return (
    <aside className={styles.snapshots} aria-label="View snapshots" data-snapshots-ready={ready && !running.value && rows.value.length > 0}>
      <header>
        <strong>View snapshots</strong>
        <span>{tiles ? 'Basemap and Satellite on' : 'Offline: no background (add tiles=1)'}</span>
        <button type="button" disabled={!ready || running.value} onClick={() => { run.value += 1 }}>Capture again</button>
      </header>
      {!ready ? <p>Waiting for the workspace…</p> : null}
      <ul>
        {rows.value.map((row) => (
          <li key={`${row.label}-${row.mode}`}>
            {row.url ? <img src={row.url} alt={row.label} /> : <div className={styles.snapshotMissing}>{row.error ?? 'No Design on a map'}</div>}
            <dl>
              <dt>{row.label}</dt><dd>{row.mode}</dd>
              {row.snapshot ? <>
                <dt>Size</dt><dd>{row.snapshot.width} × {row.snapshot.height}, {Math.round(row.snapshot.blob.size / 1024)} KiB</dd>
                <dt>Tiles</dt><dd data-missing-tiles={row.snapshot.missingTiles}>{row.snapshot.missingTiles ? 'Some tiles missing' : 'Complete'}</dd>
                <dt>Setup / settle / read / encode</dt>
                <dd>{[row.snapshot.timings.mapSetupMs, row.snapshot.timings.settleMs, row.snapshot.timings.readMs, row.snapshot.timings.encodeMs].map((ms) => ms.toFixed(1)).join(' / ')} ms</dd>
                <dt>Attribution</dt><dd>{row.snapshot.attribution.join(' · ') || 'None'}</dd>
              </> : null}
            </dl>
          </li>
        ))}
      </ul>
    </aside>
  )
}

async function capture(
  label: string,
  mode: SnapshotRow['mode'],
  take: () => Promise<SavedViewSnapshot | null>,
): Promise<SnapshotRow> {
  try {
    const snapshot = await take()
    return { label, mode, snapshot, url: snapshot ? URL.createObjectURL(snapshot.blob) : null, error: null }
  } catch (error) {
    return { label, mode, snapshot: null, url: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function describe(view: SavedView, size: { width: number; height: number }, signal: AbortSignal) {
  const queries = currentCanvasQuerySurface.peek()
  return queries
    ? describeSavedViewSnapshot(view, { ...size, signal }, { queries, mapLayers: mapLayers.peek(), locale: locale.peek(), plantLabels: savedViewPresentedLabels(view) })
    : null
}

/** Views of what the workspace shows now, composed as Save view would. */
function galleryViews(tiles: boolean): SavedView[] {
  const queries = currentCanvasQuerySurface.peek()
  const plane = queries?.sessionPlane.peek()
  const capture = queries && plane ? queries.view.captureView() : null
  if (!queries || !capture) return []
  const current = geographicViewOfCamera(capture.camera)
  const sceneLayers = queries.getSceneSnapshot().layers
  const species = queries.getSceneSnapshot().plants[0]?.canonicalName ?? null
  const view = (name: string, zoomDelta: number, background: 'none' | 'basemap' | 'satellite', options: { layers?: typeof sceneLayers; species?: string | null } = {}) => {
    const layers: MapLayersState = {
      ...mapLayers.peek(),
      basemap: { ...mapLayers.peek().basemap, visible: background === 'basemap' },
      satellite: { ...mapLayers.peek().satellite, visible: background === 'satellite' },
    }
    return composeSavedView({
      id: name,
      name,
      title: null,
      view: { ...current, zoom: current.zoom + zoomDelta },
      screen: capture.screen,
      mapLayers: layers,
      sceneLayers: options.layers ?? sceneLayers,
      siteData: [],
      focusedSpecies: options.species ?? null,
      selection: [],
      labels: 'names',
    })
  }
  const views = [
    view('Site', 0, tiles ? 'basemap' : 'none'),
    ...(tiles ? [view(SHORT_TIMEOUT_VIEW, -7, 'basemap')] : []),
    view('Wide', -3, tiles ? 'basemap' : 'none'),
    view('Focused species', 0.5, tiles ? 'satellite' : 'none', { species }),
    view('Plants hidden', 0, 'none', { layers: sceneLayers.map((layer) => ({ ...layer, visible: layer.name !== 'plants' })) }),
  ]
  // A map with no size gives no view.
  return views.filter((entry): entry is SavedView => entry !== null)
}
