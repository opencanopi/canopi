import type { SavedView } from '../../types/design'
import { useSavedViewThumbnail } from '../../app/saved-views'
import styles from './SavedViewThumbnail.module.css'

/**
 * A small map snapshot of a saved view, decorative beside the view's name: an
 * empty frame while it is drawn or when it cannot be.
 */
export function SavedViewThumbnail({ view, size = 'row' }: { readonly view: SavedView; readonly size?: 'row' | 'menu' }) {
  const thumbnail = useSavedViewThumbnail(view)
  return <ThumbnailFrame url={thumbnail.url} loading={thumbnail.status === 'loading'} size={size} />
}

export function ThumbnailFrame({ url, loading, size = 'row' }: {
  readonly url: string | null
  readonly loading: boolean
  readonly size?: 'row' | 'menu'
}) {
  return (
    <span
      className={`${styles.frame} ${size === 'menu' ? styles.menu : styles.row}`}
      data-thumbnail-state={url ? 'ready' : loading ? 'loading' : 'none'}
      aria-hidden="true"
    >
      {url && <img className={styles.image} src={url} alt="" draggable={false} />}
    </span>
  )
}
