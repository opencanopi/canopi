import type { FunctionComponent } from 'preact'
import { useRef } from 'preact/hooks'
import {
  designSessionStore,
  type DesignSessionStore,
} from '../../app/document-session/store'
import { useCanvasHost } from '../../app/canvas-map-surface/use-canvas-host'
import { CanvasChrome } from '../../components/canvas/CanvasChrome'
import { MyLocationButton } from '../../components/canvas/MyLocationButton'
import { workspaceCanvasCommandProjection } from '../../app/workspace-commands/canvas-actions'
import panelStyles from '../../components/panels/Panels.module.css'
import { browserDesignSessionController, type BrowserDesignSessionController } from '../../web/browser-design-session'
import { getMapNoticeReadModel } from '../../app/canvas-map-surface/map-notice'
import { useDesignReveal } from '../../app/canvas-map-surface/design-reveal'
import { hasVisibleMapLayer } from '../../app/settings/state'
import { presentedMapLayers } from '../../app/story-presentation/overrides'
import { MapNotice } from '../../components/canvas/MapNotice'
import { t } from '../../i18n'
import { WebWelcomeScreen } from './WebWelcomeScreen'
import { useMapArea } from '../../components/shared/useMapChrome'

interface WebCanvasWorkspaceProps {
  readonly controller?: BrowserDesignSessionController
  readonly store?: DesignSessionStore
  readonly myLocation?: FunctionComponent<{ readonly className: string | undefined }>
}

export function WebCanvasWorkspace({
  controller = browserDesignSessionController,
  store = designSessionStore,
  myLocation = MyLocationButton,
}: WebCanvasWorkspaceProps) {
  const hasDesign = store.currentDesign.value !== null
  const canvasAreaRef = useRef<HTMLDivElement>(null)
  useMapArea(canvasAreaRef)
  const containerRef = useRef<HTMLDivElement>(null)
  const host = useCanvasHost(containerRef)
  const surface = host.surface.value

  const mapNotice = getMapNoticeReadModel({
    hasDesign,
    // The map the workspace draws: a presented story step's layers, else the user's own.
    mapVisible: hasVisibleMapLayer(presentedMapLayers()),
    surface,
    t,
  })
  // While the launch reads 2.1's Draft ids (canopi-f47t.52.272) neither the start screen nor a Design shows.
  const reveal = useDesignReveal(hasDesign, surface, controller.launching.value)

  return (
    <div className={panelStyles.canvasPanel} data-testid="web-canvas-workspace">
      <div ref={canvasAreaRef} className={panelStyles.canvasArea} data-design-hidden={hasDesign && !reveal.shown ? '' : undefined}>
        {/* Focusable from script while no session holds it (tabIndex -1, which the session restores when it ends), so
            focus handed to the map after a Retry lands before the rebuilt session makes it a Tab stop again. */}
        <div
          ref={containerRef}
          tabIndex={-1}
          className={panelStyles.canvasContainer}
          data-map-active={mapNotice.mapSurfaceVisible ? 'true' : 'false'}
          data-testid="web-canvas-workspace-surface"
        />
        {hasDesign && <CanvasChrome projection={workspaceCanvasCommandProjection.value} canvasRef={containerRef} myLocation={myLocation} />}
        <MapNotice
          notice={mapNotice}
          onRetry={() => {
            if (!host.retryMap()) host.retryLayer('background')
          }}
          canvasRef={containerRef}
        />
        {reveal.startScreen && <WebWelcomeScreen controller={controller} />}
      </div>
    </div>
  )
}
