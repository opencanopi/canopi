import { useRef } from 'preact/hooks'
import { t } from '../../i18n'
import { useCanvasHost } from '../../app/canvas-map-surface/use-canvas-host'
import { WelcomeScreen } from '../shared/WelcomeScreen'
import { hasVisibleMapLayer } from '../../app/settings/state'
import { presentedMapLayers } from '../../app/story-presentation/overrides'
import { getMapNoticeReadModel } from '../../app/canvas-map-surface/map-notice'
import { useDesignReveal } from '../../app/canvas-map-surface/design-reveal'
import { currentDesign } from '../../app/document-session/store'
import { appCommandGraphToolbarProjection } from '../../commands/registry'
import { profileLineMenu } from '../../app/data-library/profile'
import { CanvasChrome } from '../canvas/CanvasChrome'
import { MapNotice } from '../canvas/MapNotice'
import { StampChooser } from '../canvas/StampChooser'
import { useMapArea } from '../shared/useMapChrome'
import styles from './Panels.module.css'

/** Desktop canvas: the full-bleed map with the shared floating chrome, or the start screen. */
export function CanvasPanel() {
  const canvasAreaRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useMapArea(canvasAreaRef)
  const host = useCanvasHost(containerRef)
  const surface = host.surface.value

  const hasDesign = currentDesign.value !== null
  const reveal = useDesignReveal(hasDesign, surface)
  const mapNotice = getMapNoticeReadModel({
    hasDesign,
    // The map the workspace draws: a presented story step's layers, else the user's own.
    mapVisible: hasVisibleMapLayer(presentedMapLayers()),
    surface,
    t,
  })

  return (
    <div className={styles.canvasPanel}>
      <div ref={canvasAreaRef} className={styles.canvasArea} data-design-hidden={hasDesign && !reveal.shown ? '' : undefined}>
        {/* Focusable from script while no session holds it (tabIndex -1, which the session restores when it ends), so
            focus handed to the map after a Retry lands before the rebuilt session makes it a Tab stop again. */}
        <div
          ref={containerRef}
          tabIndex={-1}
          className={styles.canvasContainer}
          data-map-active={mapNotice.mapSurfaceVisible ? 'true' : 'false'}
        />
        {hasDesign && (
          <CanvasChrome
            projection={appCommandGraphToolbarProjection.value}
            canvasRef={containerRef}
            stampChooser={StampChooser}
            profileLine={profileLineMenu}
          />
        )}
        <MapNotice
          notice={mapNotice}
          onRetry={() => {
            if (!host.retryMap()) host.retryLayer('background')
          }}
          canvasRef={containerRef}
        />
        {reveal.startScreen && <WelcomeScreen />}
      </div>
    </div>
  )
}
