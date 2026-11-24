import { useRef, useState } from 'preact/hooks'
import { t } from '../../i18n'
import { useCanvasDocumentSession } from '../../app/document-session/use-canvas-document-session'
import {
  IDLE_MAPLIBRE_CANVAS_SURFACE_STATE,
  type MapLibreCanvasSurfaceState,
} from '../../maplibre/canvas-surface-state'
import { WelcomeScreen } from '../shared/WelcomeScreen'
import { hasVisibleMapLayer } from '../../app/map-layers/state'
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
  const [basemapState, setBasemapState] = useState<MapLibreCanvasSurfaceState>(
    () => IDLE_MAPLIBRE_CANVAS_SURFACE_STATE,
  )

  useMapArea(canvasAreaRef)
  const { retryMap } = useCanvasDocumentSession({
    canvasAreaRef,
    containerRef,
    onMapStateChange: setBasemapState,
  })

  const hasDesign = currentDesign.value !== null
  const reveal = useDesignReveal(hasDesign, basemapState)
  const mapNotice = getMapNoticeReadModel({
    hasDesign,
    // The map the workspace draws: a presented story step's layers, else the user's own.
    mapVisible: hasVisibleMapLayer(presentedMapLayers()),
    mapSurface: basemapState,
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
        <MapNotice notice={mapNotice} onRetry={retryMap} canvasRef={containerRef} />
        {reveal.startScreen && <WelcomeScreen />}
      </div>
    </div>
  )
}
