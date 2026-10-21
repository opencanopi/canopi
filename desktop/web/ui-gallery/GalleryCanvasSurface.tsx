import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import type { WorkspaceRuntimeComposition } from '../src/app/canvas-map-surface/workspace-runtime-composition'
import { CanvasChrome } from '../src/components/canvas/CanvasChrome'
import { MyLocationButtonView } from '../src/components/canvas/MyLocationButton'
import type { StampChooserProps } from '../src/components/canvas/ToolCard'
import type { CanvasContextMenuProfileLine } from '../src/app/canvas-context-menu/entries'
import type { FunctionComponent } from 'preact'
import { workspaceCanvasCommandProjection } from '../src/app/workspace-commands/canvas-actions'
import panelStyles from '../src/components/panels/Panels.module.css'
import { CanvasRuntimeCleanupError } from '../src/canvas/runtime/cleanup'
import { acquireCanvasRuntimeLifecycle } from '../src/canvas/runtime/lifecycle-owner'
import { getCurrentCanvasSession, setCurrentCanvasSession } from '../src/canvas/session'
import { closeCanvasContextMenu, openCanvasContextMenu } from '../src/app/canvas-context-menu/state'
import type { CanopiFile } from '../src/types/design'
import {
  createGalleryWorkspaceRuntimeComposition,
  type GalleryWorkspaceRuntimeOptions,
} from './gallery-workspace-runtime'
import { activity } from './memory-backend'
import { specimens } from './fixtures'
import { useMapArea } from '../src/components/shared/useMapChrome'
import { MapNotice } from '../src/components/canvas/MapNotice'
import { getMapNoticeReadModel } from '../src/app/canvas-map-surface/map-notice'
import { IDLE_MAPLIBRE_CANVAS_SURFACE_STATE } from '../src/maplibre/canvas-surface-state'
import { t } from '../src/i18n'
import styles from './gallery.module.css'
import { GALLERY_LOCATION_STATES, parseGalleryLocationState, type GalleryLocationState } from './surface-routing'

/** Show my location in each state the `location` surface reviews; one component per state, so a re-render keeps it. */
const GALLERY_LOCATION_BUTTONS = new Map<GalleryLocationState, FunctionComponent<{ readonly className: string | undefined }>>(GALLERY_LOCATION_STATES.map((state) => [state, ({ className }) => (
  <MyLocationButtonView
    className={className}
    mode={state === 'stale' ? 'following' : state}
    unavailable={state === 'stale'}
    onPress={() => { activity.value = `Show my location pressed (${state}).` }}
  />
)]))

interface GallerySurfaceSignal {
  readonly value: string
}

interface GalleryCanvasSurfaceProps {
  readonly activeSurface: GallerySurfaceSignal
  readonly design: CanopiFile
  readonly dense: boolean
  readonly cameraState?: 'site' | 'overview' | 'maximum'
  /** Select everything instead of the first species (a fixture without plants). */
  readonly selectAll?: boolean
  /** The view's bearing after the fit, clockwise from north (`bearing=`); 0 keeps north up. */
  readonly bearingDeg?: number
  readonly onReadyChange: (ready: boolean) => void
  /** Place a stamp's saved-stamp chooser, as the Desktop canvas hands it over; none on Web. */
  readonly stampChooser?: FunctionComponent<StampChooserProps>
  /** The canvas menu's "Profile this line", as the Desktop canvas hands it over; none on Web. */
  readonly profileLine?: CanvasContextMenuProfileLine
  readonly createRuntimeComposition?: (options: GalleryWorkspaceRuntimeOptions) => WorkspaceRuntimeComposition
}

export function GalleryCanvasSurface({
  activeSurface,
  design,
  dense,
  cameraState = 'site',
  selectAll = false,
  bearingDeg = 0,
  onReadyChange,
  stampChooser,
  profileLine,
  createRuntimeComposition = createGalleryWorkspaceRuntimeComposition,
}: GalleryCanvasSurfaceProps) {
  const canvas = useRef<HTMLDivElement>(null)
  // As in both editions: the map area frames fits and centres chips.
  const canvasArea = useRef<HTMLDivElement>(null)
  useMapArea(canvasArea)
  const ready = useSignal(false)
  // The production map notice, for failures only (the gallery's background stays hidden offline): a lost map shows
  // "The map stopped drawing" with Retry, which rebuilds the map as the app's does.
  const mapState = useSignal(IDLE_MAPLIBRE_CANVAS_SURFACE_STATE)
  const retryMap = useRef<(() => void) | null>(null)

  useEffect(() => {
    const container = canvas.current
    if (!container) return

    let cancelled = false
    let runtime: WorkspaceRuntimeComposition | null = null
    let resize: ResizeObserver | null = null
    let released = false
    let releaseLease: (() => Promise<void>) | null = null
    let runtimeCreationSettlement: Promise<void> | null = null

    const releaseRuntime = async () => {
      if (released) return
      const pendingCreation = runtimeCreationSettlement
      if (pendingCreation) await pendingCreation
      if (released) return
      released = true
      const activeRuntime = runtime
      const errors: unknown[] = []
      try {
        resize?.disconnect()
      } catch (error) {
        errors.push(error)
      }
      try {
        await activeRuntime?.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        if (activeRuntime && getCurrentCanvasSession() === activeRuntime.surfaces) {
          setCurrentCanvasSession(null)
        }
      } catch (error) {
        errors.push(error)
      }
      try {
        ready.value = false
        onReadyChange(false)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        console.error(
          'Unable to release gallery canvas:',
          errors.length === 1
            ? errors[0]
            : new CanvasRuntimeCleanupError('Gallery Canvas runtime cleanup failed', errors),
        )
      }
    }
    const release = () => {
      const releaseCurrentLease = releaseLease
      if (!releaseCurrentLease) return
      void releaseCurrentLease().catch((error: unknown) => {
        console.error('Unable to release gallery canvas:', error)
      })
    }

    onReadyChange(false)
    void (async () => {
      const lease = await acquireCanvasRuntimeLifecycle(releaseRuntime)
      releaseLease = lease.release
      if (cancelled) {
        release()
        return
      }

      let finishRuntimeCreation!: () => void
      runtimeCreationSettlement = new Promise<void>((resolve) => {
        finishRuntimeCreation = resolve
      })
      try {
        runtime = createRuntimeComposition({
          container,
          design,
          onMapStateChange: (state) => {
            mapState.value = state
            if (state.status === 'error') activity.value = 'Map unavailable'
          },
          onFailure: (error) => console.error('Gallery workspace failed:', error),
        })
      } finally {
        finishRuntimeCreation()
        runtimeCreationSettlement = null
      }
      const activeRuntime = runtime
      retryMap.current = () => activeRuntime.retryMap()
      const activeResize = new ResizeObserver(() => {
        activeRuntime.surfaces.documents.resize(container.clientWidth, container.clientHeight)
      })
      resize = activeResize
      const runtimeIsActive = () => !cancelled && !released && runtime === activeRuntime
      if (!runtimeIsActive()) {
        release()
        return
      }

      const outcome = await activeRuntime.start()
      if (outcome === 'cancelled' || outcome === 'no-design') {
        throw new Error(`Gallery workspace did not start (${outcome}).`)
      }
      if (!runtimeIsActive()) return
      activeRuntime.surfaces.documents.loadDocument(design)
      activeRuntime.surfaces.documents.showCanvasChrome()
      if (!runtimeIsActive()) return
      activeRuntime.surfaces.documents.resize(container.clientWidth, container.clientHeight)
      if (!runtimeIsActive()) return
      activeRuntime.surfaces.documents.zoomToFit()
      if (bearingDeg !== 0) {
        // Turned about the fitted centre at the same zoom, as a restored view is: no animation, never snapped.
        const { camera } = activeRuntime.surfaces.queries.view.captureView()
        activeRuntime.surfaces.commands.viewport.showCamera({ ...camera, bearingDeg }, { motion: 'jump' })
      }
      if (dense) {
        for (let i = 0; i < 6; i++) {
          if (!runtimeIsActive()) return
          activeRuntime.surfaces.commands.viewport.zoomOut()
        }
      }
      if (cameraState === 'overview') {
        for (let i = 0; i < 100; i++) activeRuntime.surfaces.commands.viewport.zoomOut()
      } else if (cameraState === 'maximum') {
        for (let i = 0; i < 100; i++) activeRuntime.surfaces.commands.viewport.zoomIn()
      }
      if (!runtimeIsActive()) return
      if (selectAll) activeRuntime.surfaces.commands.sceneEdits.selectAll()
      else activeRuntime.surfaces.commands.sceneEdits.selectSpecies([specimens[0][0]])
      if (!runtimeIsActive()) return
      activeResize.observe(container)
      if (!runtimeIsActive()) return
      setCurrentCanvasSession(activeRuntime.surfaces)
      if (!runtimeIsActive() || getCurrentCanvasSession() !== activeRuntime.surfaces) {
        release()
        return
      }
      ready.value = true
      onReadyChange(true)
    })().catch(error => {
      release()
      if (cancelled) return
      activity.value = 'Canvas could not start. See the browser console.'
      console.error('Unable to start gallery canvas:', error)
    })

    return () => {
      cancelled = true
      release()
    }
  }, [bearingDeg, cameraState, createRuntimeComposition, dense, design, onReadyChange, selectAll])

  useEffect(() => {
    const surface = activeSurface.value
    const session = getCurrentCanvasSession()
    const container = canvas.current
    if (!ready.value || !surface.startsWith('menu-') || !session || !container) return
    // The review surfaces open the right-click menu as the runtime would, beside the map's centre.
    const { sceneEdits } = session.commands
    if (surface === 'menu-mixed') sceneEdits.selectAll()
    else sceneEdits.selectSpecies([specimens[0][0]])
    const rect = container.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + 96
    const request = {
      anchor: { left: x, top: y, right: x, bottom: y },
      world: { x: 0, y: 0 },
      selection: surface === 'menu-empty' ? null : session.queries.getDesignObjectSelection(),
      commands: sceneEdits,
      saveSelectionAsObjectStamp: sceneEdits.saveSelectionAsObjectStamp,
      returnFocus: () => container.focus(),
    }
    // Opened after the first layout settles: a resize or scroll closes a context menu.
    const timer = window.setTimeout(() => openCanvasContextMenu(request), 1500)
    return () => {
      window.clearTimeout(timer)
      closeCanvasContextMenu(request)
    }
  }, [activeSurface.value, ready.value])

  useEffect(() => {
    if (!ready.value || activeSurface.value !== 'lens') return
    canvas.current?.parentElement?.querySelector<HTMLButtonElement>('button[data-inspection-launcher][aria-expanded="false"]')?.click()
  }, [activeSurface.value, ready.value])

  return (
    <div className={styles.canvasWorkspace}>
      <div ref={canvasArea} className={`${panelStyles.canvasArea} ${styles.canvasArea}`}>
        <div ref={canvas} className={styles.canvas} />
        {ready.value ? (
          <CanvasChrome
            key={activeSurface.value === 'lens' ? 'lens' : 'other'}
            projection={workspaceCanvasCommandProjection.value}
            canvasRef={canvas}
            stampChooser={stampChooser}
            profileLine={profileLine}
            myLocation={activeSurface.value === 'location'
              ? GALLERY_LOCATION_BUTTONS.get(parseGalleryLocationState(new URLSearchParams(location.search).get('location')))
              : undefined}
          />
        ) : null}
        <MapNotice
          notice={getMapNoticeReadModel({ hasDesign: true, mapVisible: false, mapSurface: mapState.value, t })}
          onRetry={() => retryMap.current?.()}
          canvasRef={canvas}
        />
      </div>
    </div>
  )
}
