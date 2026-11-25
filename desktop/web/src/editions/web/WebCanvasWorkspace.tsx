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
import { getMapNoticeReadModel } from '../../app/canvas-map-surface/map-notice'
import { useDesignReveal } from '../../app/canvas-map-surface/design-reveal'
import { hasVisibleMapLayer } from '../../app/settings/state'
import { presentedMapLayers } from '../../app/story-presentation/overrides'
import { MapNotice } from '../../components/canvas/MapNotice'
import { t } from '../../i18n'
import { WebWelcomeScreen } from './WebWelcomeScreen'
import { useMapArea } from '../../components/shared/useMapChrome'
import { webLaunching } from './web-session'

interface WebCanvasWorkspaceProps {
  readonly store?: DesignSessionStore
  readonly myLocation?: FunctionComponent<{ readonly className: string | undefined }>
}

export function WebCanvasWorkspace({
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
    mapVisible: hasVisibleMapLayer(presentedMapLayers()),
    surface,
    t,
  })
  const reveal = useDesignReveal(hasDesign, surface, webLaunching.value)

  return (
    <div className={panelStyles.canvasPanel} data-testid="web-canvas-workspace">
      <div ref={canvasAreaRef} className={panelStyles.canvasArea} data-design-hidden={hasDesign && !reveal.shown ? '' : undefined}>
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
        {reveal.startScreen && <WebWelcomeScreen />}
      </div>
    </div>
  )
}
