import { useEffect, useState } from 'preact/hooks'
import { lidarAssetUrl, readLidarDisplay, requestLidarDisplay } from '../../../app/data-library/display'
import { displayVariant, itemTypeStyle } from '../../../app/data-library/item-types'
import type { LibraryItem } from '../../../app/data-library/library-items'
import { rasterWorkerPool, type RasterPoolClient } from '../../../maplibre/raster-display/pool'
import { t } from '../../../i18n'
import styles from './data-library.module.css'

/**
 * One raster preview client for the Data Library dock.
 *
 * The dock owns preview work: previews use the same bounded worker lanes as
 * the map, never a MapLibre instance or a worker per row, and closing the dock
 * rejects whatever preview work is still queued.
 */
export function usePreviewClient(): RasterPoolClient | null {
  const [client, setClient] = useState<RasterPoolClient | null>(null)
  useEffect(() => {
    const acquired = rasterWorkerPool().acquire()
    setClient(acquired)
    return () => acquired.dispose()
  }, [])
  return client
}

const MAX_CACHED_PREVIEWS = 96
/** Rendered previews by generation, variant, size and style; object URLs revoked on eviction. */
const previewCache = new Map<string, string>()

function remember(key: string, url: string): void {
  previewCache.delete(key)
  previewCache.set(key, url)
  while (previewCache.size > MAX_CACHED_PREVIEWS) {
    const [oldest, oldUrl] = previewCache.entries().next().value!
    previewCache.delete(oldest)
    URL.revokeObjectURL(oldUrl)
  }
}

/**
 * A lazy preview through the upstream renderer. A missing or failed preview
 * never blocks search or metadata: the row keeps a quiet placeholder.
 */
export function LibraryPreview({ item, client, width, height, large = false }: {
  item: LibraryItem
  client: RasterPoolClient | null
  width: number
  height: number
  large?: boolean
}) {
  const kind = item.role
  const ready = item.status === 'ready' && item.generationId !== null
  // A preview draws the item kind's default look (Relief for elevations and heights); an entry's own look belongs to its Design.
  const variant = displayVariant(item.itemType, { ramp: null })
  const descriptor = ready ? readLidarDisplay(kind, item.id, item.generationId, variant) : null
  const style = itemTypeStyle(item.itemType, { units: item.units, displayRange: item.displayRange, ramp: null, reversed: false, range: null })
  const key = `${item.generationId}|${variant}|${width}x${height}|${style.colormap}|${style.reversed}|${style.rescale.join(',')}`
  const [url, setUrl] = useState<string | null>(previewCache.get(key) ?? null)
  const [failed, setFailed] = useState(false)

  // The release lets an unmounted or changed preview stop asking for its display.
  useEffect(() => {
    if (!ready) return
    return requestLidarDisplay(kind, item.id, item.generationId, variant)
  }, [ready, kind, item.id, item.generationId, variant])

  useEffect(() => {
    const cached = previewCache.get(key)
    if (cached) {
      setUrl(cached)
      return
    }
    setUrl(null)
    setFailed(false)
    if (!client || descriptor?.state !== 'Ready' || descriptor.assets.length === 0) return
    let current = true
    const bbox = descriptor.assets.reduce<[number, number, number, number]>(
      (union, asset) => [
        Math.min(union[0], asset.bounds[0]),
        Math.min(union[1], asset.bounds[1]),
        Math.max(union[2], asset.bounds[2]),
        Math.max(union[3], asset.bounds[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    )
    void client
      .renderPreview(
        descriptor.assets.map((asset) => lidarAssetUrl(asset.path)),
        bbox,
        { width, height },
        { bidx: [1], rescale: [style.rescale[0], style.rescale[1]], colormap: style.colormap, reversed: style.reversed },
      )
      .then((png) => {
        const objectUrl = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }))
        remember(key, objectUrl)
        if (current) setUrl(objectUrl)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
    }
  }, [client, key, descriptor?.state, descriptor?.assets.length])

  const className = large ? styles.previewLarge : styles.thumbnail
  if (url) return <img className={className} src={url} alt="" width={width} height={height} />
  const label = !ready
    ? null
    : failed || descriptor?.state === 'Failed'
      ? t('canvas.lidar.library.previewUnavailable')
      : descriptor?.state === 'Unavailable'
        ? t('canvas.lidar.library.dataUnavailable')
        : t('canvas.lidar.library.previewPreparing')
  return <span className={className} data-placeholder="true" aria-hidden={label === null}>{large && label}</span>
}
