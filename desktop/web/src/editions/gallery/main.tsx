import { render, type FunctionComponent } from 'preact'
import { useEffect } from 'preact/hooks'
import { effect, signal } from '@preact/signals'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../../styles/global.css'
import styles from './gallery.module.css'
import { installSpeciesCatalogWorkbench, speciesCatalogWorkbench } from '../../app/plant-browser'
import { createGallerySpeciesCatalogWorkbench } from './species-catalog'
import { DesktopSpeciesKeyPanel } from '../../components/panels/DesktopSpeciesKeyPanel'
import { LayersPanel } from '../../components/panels/LayersPanel'
import { DesignNotebookPanel } from '../../components/panels/DesignNotebookPanel'
import { PlantDbPanel } from '../../components/panels/PlantDbPanel'
import { DataDialogs } from '../../components/panels/lidar/DataDialogs'
import { SiteDataPanel } from '../../components/panels/lidar/SiteDataPanel'
import { FavoritesPanel } from '../../components/panels/FavoritesPanel'
import { BudgetPanel } from '../../components/panels/BudgetPanel'
import { CalendarPanel } from '../../components/panels/CalendarPanel'
import { ConsortiumPanel } from '../../components/panels/ConsortiumPanel'
import { StoriesPanel } from '../../components/panels/StoriesPanel'
import { selectStep } from '../../app/stories'
import { presentStory } from '../../app/story-presentation'
import { StoryPresenter } from '../../components/stories/StoryPresenter'
import { notebookWorkbench } from './notebook-fixture'
import { WebSpeciesCatalogPanel, WebSpeciesKeyPanel } from '../web/WebSpeciesCatalogPanel'
import { WebLayersPanel } from '../web/WebLayersPanel'
import { activePanel, navigateTo, sidePanel } from '../../app/shell/state'
import { applyHealthSnapshot } from '../../failures/health'
import { installHealthNotices } from '../../failures/health-notices'
import { locale, mapLayers, sidePanelWidth, theme, type MapLayersState } from '../../app/settings/state'
import { designFixture, detail, species, specimens } from './fixtures'
import { currentDesign, designSessionStore } from '../../app/document-session/store'
import { currentCanvasSession } from '../../canvas/session'
import type { CanvasDocumentSurface } from '../../canvas/runtime/runtime'
import { installSpeciesCacheLoader } from '../../app/canvas-runtime/species-cache'
import { createDesktopCanvasRuntimeAppAdapter } from '../../app/canvas-runtime/desktop-adapter'
import { createAppCanvasRuntimeAppAdapter } from '../../app/canvas-runtime/app-adapter'
import { createDesktopWorkspaceMapContributionAdapter } from '../../app/canvas-map-surface/desktop-workspace-map-contribution-adapter'
import { createDesktopCanvasHostCore } from '../../app/canvas-map-surface/desktop-workspace-runtime'
import { installCanvasHostRuntime, type CanvasHostRuntimeBinding } from '../../app/canvas-map-surface/use-canvas-host'
import { readWorkspaceActivationSnapshot, readWorkspaceBackgroundPresentation } from '../../app/canvas-map-surface/workspace-activation-snapshot'
import { readWorkspaceMapContributions } from '../../app/canvas-map-surface/workspace-map-contribution-adapter'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore } from '../../app/document-session/live-core'
import { registerCloseGuard } from '../../app/shell/close-guard'
import { installLidarDisplayDescriptors } from '../../app/data-library/display'
import { installLidarLibraryObserver } from '../../app/data-library/library-store'
import {
  closeCanvasContextMenu,
  openCanvasContextMenu,
  plantColorMenuOpen,
  plantSymbolMenuOpen,
} from '../../app/canvas-context-menu/state'
import { createGalleryEditionPorts } from './ports'
import { activity, galleryCommandTransport } from './command-adapter'
import { installAssetUrlResolver, installCommandTransport } from '../../types/command-transport'
import { installEditionPorts } from '../../platform/edition-ports'
import type { DesignHomeStore, DraftId } from '../../platform/design-home'
import type { AppFolderLocations } from '../../generated/contracts'
import { attachmentFailure, pendingAttachments } from '../../app/data-library/actions'
import { analyzeItem, dataDialog, libraryView, openDataLibrary } from '../../app/data-library/library-navigation'
import { showInSiteData } from '../../app/data-library/site-data-view'
import { CanvasPanel } from '../../components/panels/CanvasPanel'
import { MyLocationButtonView } from '../../components/canvas/MyLocationButton'
import { ToolOptions } from '../../components/canvas/ToolCard'
import { PlantSymbolSheet } from './PlantSymbolSheet'
import { GalleryViewSnapshots } from './GalleryViewSnapshots'
import { readPlanningViewState } from '../../app/planning-view/state'
import { appCommandGraphChromeProjection, appCommandGraphPanelProjection } from '../../commands/registry'
import { createBrowserShellCapabilities, createBrowserShellCatalog, browserPhoneSheetTabs, createBrowserShellCommandProjection } from '../web/browser-shell-commands'
import { workspaceCanvasCommandProjection } from '../../app/workspace-commands/canvas-actions'
import { keyboardShortcutsDialogOpen } from '../../app/shell/dialogs'
import { TitleBar } from '../../components/shared/TitleBar'
import { DesktopPanelRail } from '../../components/panels/DesktopPanelRail'
import { SettingsDialog } from '../../components/shared/SettingsDialog'
import { KeyboardShortcutsDialog } from '../../components/shared/KeyboardShortcutsDialog'
import type { InputPlatform } from '../../canvas/runtime/input/platform'
import { WelcomeScreen } from '../../components/shared/WelcomeScreen'
import { NoticeRow } from '../../components/shared/NoticeRow'
import { ToastSlot } from '../../components/shared/ToastSlot'
import { BrowserAppShell } from '../web/BrowserAppShell'
import { WebCanvasWorkspace, WebPhoneBar } from '../web/WebWorkspace'
import { WorkspaceComposition, WorkspaceDialogs, type WorkspacePanelProjection, type WorkspaceSurfaces } from '../../components/workspace/WorkspaceComposition'
import { GALLERY_LOCATION_STATES, GALLERY_SURFACES, parseGalleryLocationState, parseGallerySurface, selectGalleryPanel, type GalleryLocationState, type GallerySurface } from './surface-routing'

/** Show my location in each state the `location` surface reviews; one component per state, so a re-render keeps it. */
const GALLERY_LOCATION_BUTTONS = new Map<GalleryLocationState, FunctionComponent<{ readonly className: string | undefined }>>(
  GALLERY_LOCATION_STATES.map((state) => [state, ({ className }) => (
    <MyLocationButtonView
      className={className}
      mode={state === 'stale' ? 'following' : state}
      unavailable={state === 'stale'}
      onPress={() => { activity.value = `Show my location pressed (${state}).` }}
    />
  )]),
)

if (!import.meta.env.DEV) throw new Error('Gallery cannot run in production.')
const params = new URLSearchParams(location.search)
const fixtureState = params.get('state') ?? 'populated'
const requestedPanelWidth = Number(params.get('panelWidth'))
const edition = params.get('edition') === 'web' ? 'web' : 'desktop'
installCommandTransport(galleryCommandTransport)
installAssetUrlResolver((path) => path)
installSpeciesCatalogWorkbench(createGallerySpeciesCatalogWorkbench())
installSpeciesCacheLoader({
  getSpeciesBatch: async (canonicalNames) => canonicalNames.map((canonical_name) => {
    const entry = species.find((item) => item.canonical_name === canonical_name)
    return {
      ...detail,
      canonical_name,
      common_name: entry?.common_name ?? null,
      habit: entry?.habit ?? null,
      growth_rate: entry?.growth_rate ?? null,
    }
  }),
  getFlowerColorBatch: async () => [],
  isPlantDbUnavailableError: () => false,
})

const OFFLINE_TERRAIN = Object.freeze({
  contoursVisible: false, contoursOpacity: 0, contourIntervalMeters: 1,
  hillshadeVisible: false, hillshadeOpacity: 0, isDark: false,
})

function readOfflineMapLayers(): MapLayersState {
  const layers = mapLayers.value
  return {
    ...layers,
    basemap: { ...layers.basemap, visible: false },
    satellite: { ...layers.satellite, visible: false },
  }
}

if (edition === 'desktop' && fixtureState === 'lidar-raster') {
  installLidarLibraryObserver()
  installLidarDisplayDescriptors((path) => path)
}

function createGalleryDesktopAdapters(): NonNullable<CanvasHostRuntimeBinding['adapters']> {
  const baseContributions = createDesktopWorkspaceMapContributionAdapter({ locationEnabled: true })
  const baseCreateRasterDisplay = baseContributions.createRasterDisplay
  return {
    appAdapter: createDesktopCanvasRuntimeAppAdapter(),
    mapContributions: {
      ...(baseCreateRasterDisplay && fixtureState === 'lidar-raster'
        ? {
            createRasterDisplay: (map, rasterOptions) => {
              // The map whose rasters draw, for display.spec.ts layer-order assertions.
              (window as { __galleryRasterMap?: unknown }).__galleryRasterMap = map
              return baseCreateRasterDisplay(map, rasterOptions)
            },
          }
        : {}),
      ...(baseContributions.readSiteHover ? { readSiteHover: baseContributions.readSiteHover } : {}),
      read: (runtime) => {
        const contribution = baseContributions.read(runtime)
        if (!contribution) return null
        return {
          ...contribution,
          overlays: {
            ...contribution.overlays,
            terrain: OFFLINE_TERRAIN,
          },
        }
      },
    },
    readSnapshot: (readInitialCenter: () => { readonly lat: number; readonly lon: number }) => readWorkspaceActivationSnapshot({
      readInitialCenter,
      readMapLayers: readOfflineMapLayers,
    }),
    readBackgroundPresentation: () => readWorkspaceBackgroundPresentation({
      readMapLayers: readOfflineMapLayers,
    }),
  }
}

function createGalleryWebAdapters(): NonNullable<CanvasHostRuntimeBinding['adapters']> {
  return {
    appAdapter: createAppCanvasRuntimeAppAdapter({ presentationData: {} }),
    mapContributions: {
      read: (runtime) => readWorkspaceMapContributions(runtime, designSessionStore, () => ({
        lidar: [],
        terrain: OFFLINE_TERRAIN,
        site: null,
      })),
    },
    readSnapshot: (readInitialCenter: () => { readonly lat: number; readonly lon: number }) => readWorkspaceActivationSnapshot({
      readInitialCenter,
      readMapLayers: readOfflineMapLayers,
    }),
    readBackgroundPresentation: () => readWorkspaceBackgroundPresentation({
      readMapLayers: readOfflineMapLayers,
    }),
  }
}

const galleryWebController = {
  attachCanvasSession: (documents: CanvasDocumentSurface) => {
    const current = designSessionStore.currentDesign.peek()
    if (current) {
      documents.loadDocument(current)
      documents.showCanvasChrome()
      documents.zoomToFit()
    }
    return () => {}
  },
}
const initial = parseGallerySurface(params.get('surface'))
const selectedSurface = signal<GallerySurface>(initial)
installCanvasHostRuntime(() => {
  if (edition === 'web' || selectedSurface.peek() === 'location') {
    let detach: (() => void) | null = null
    return {
      core: {
        attachScene(documents) {
          detach = galleryWebController.attachCanvasSession(documents)
          return 'attached'
        },
        detachScene() {
          const fn = detach
          if (!fn) return
          fn()
          detach = null
        },
      },
      adapters: createGalleryWebAdapters(),
    }
  }
  return {
    core: createDesktopCanvasHostCore(),
    adapters: createGalleryDesktopAdapters(),
  }
})
const galleryPorts = createGalleryEditionPorts(edition)
installEditionPorts(galleryPorts)
const galleryReadOnly = params.get('session') === 'read-only'
const file = designFixture(fixtureState)
// `state=no-design`: no Design is open, as on the Start screen (the empty Data library's Import… is disabled).
const gallerySessionCore = createSessionCore({
  designHome: galleryPorts.designHome as DesignHomeStore,
  fileAccess: galleryPorts.fileAccess,
  lifecycle: galleryPorts.appLifecycle,
  codec: createJsonSessionCodec({
    designCore: galleryPorts.designCore,
    decode: async (bytes) => ({
      file: JSON.parse(new TextDecoder().decode(bytes)),
      ...(galleryReadOnly ? { readOnly: true } : {}),
    }),
  }),
  settings: {
    readLastOpenHome: async () => null,
    writeLastOpenHome: async () => {},
  },
  newDesignFactory: () => designFixture(fixtureState),
  ...(initial !== 'start' && fixtureState !== 'no-design'
    ? { initialDesign: { home: { kind: 'draft', key: 'gallery-fixture' as DraftId, version: null }, file, ...(galleryReadOnly ? { readOnly: true } : {}) } }
    : {}),
})
const disposeGallerySessionCore = installLiveSessionCore(gallerySessionCore)
// Gallery registers the close guard to keep SessionCore's close-question contract active;
// it never triggers host close prompts, so WorkspaceDialogs does not mount SaveProblemDialog here (N4).
const galleryCloseGuard = registerCloseGuard()
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    galleryCloseGuard.dispose()
    disposeGallerySessionCore()
  })
}
const galleryAppFolders: AppFolderLocations = {
  drafts: '/gallery/drafts',
  data_library: '/gallery/data-library',
}
/** `open=<id>`: the Site data item opened under its row, or the item the Data library selects. */
const openItem = params.get('open')
const galleryCanvasReady = signal(false)
// Layers-initiated work joining this Design, as its progress rows show it.
if (fixtureState === 'lidar-progress') {
  const identity = designSessionStore.sessionIdentity.value
  pendingAttachments.value = [
    { key: 'import:lidar-canopy', kind: 'import', identity, itemIds: ['lidar-canopy'] },
    { key: 'lidar-slope-running-def', kind: 'analysis', identity, itemIds: ['lidar-slope-running'] },
  ]
}
// A failed attachment, as the Site data notice shows it (canopi-6spu).
if (fixtureState === 'lidar-failure') {
  attachmentFailure.value = { itemId: 'lidar-ground' }
}
const planningView = readPlanningViewState()
planningView.calendarMonth.value = '2026-09-01'
planningView.calendarExpanded.value = initial === 'calendar-expanded'
if (Number.isFinite(requestedPanelWidth) && requestedPanelWidth >= 320) {
  sidePanelWidth.value = requestedPanelWidth
}
locale.value = (params.get('locale') ?? 'en') as typeof locale.value
theme.value = params.get('theme') === 'dark' ? 'dark' : 'light'
const disposeTheme = effect(() => { document.documentElement.dataset.theme = theme.value })
// `plantDb=corrupt|missing` shows the plant database notice on the notice row, through the one health model.
const plantDb = params.get('plantDb')
const disposeHealthNotices = installHealthNotices({ report: null, update: null })
if (plantDb === 'corrupt' || plantDb === 'missing') {
  const cause = plantDb === 'missing' ? 'missing' : 'open_failed'
  applyHealthSnapshot({ plant_catalog: { status: { kind: 'unavailable', code: { kind: 'plant_db_unavailable', cause } }, notice: null } })
}
// `bearing=30` turns the map 30° clockwise from north once the Design is fitted (compass, turned grid).
// `platform=mac|linux`: F1 (Help › Keyboard shortcuts) lists the gestures as on a Mac whose WebKit delivers gesture
// events (Control-click, the trackpad twist), or as on Linux with Desktop's pinch note. Only F1 reads it.
const requestedPlatform = params.get('platform')
const shortcutsPlatform: Pick<InputPlatform, 'os' | 'gestureEvents'> | undefined = requestedPlatform === 'mac'
  ? { os: 'mac', gestureEvents: true }
  : requestedPlatform === 'linux' ? { os: 'linux', gestureEvents: false } : undefined

const workspaceSurfaces: WorkspaceSurfaces = edition === 'web'
  ? {
      primary: { canvas: GalleryCanvasWorkspace },
      side: {
        'species-key': WebSpeciesKeyPanel,
        layers: WebLayersPanel,
        calendar: CalendarPanel,
        budget: BudgetPanel,
        consortium: ConsortiumPanel,
        stories: StoriesPanel,
        'plant-db': WebCatalogSurface,
        favorites: WebFavoritesSurface,
      },
    }
  : {
      primary: { canvas: GalleryCanvasWorkspace },
      side: {
        'species-key': DesktopSpeciesKeyPanel,
        layers: GalleryLayersSurface,
        'site-data': GallerySiteDataSurface,
        calendar: CalendarPanel,
        budget: BudgetPanel,
        consortium: ConsortiumPanel,
        stories: StoriesPanel,
        'design-notebook': GalleryNotebookSurface,
        'plant-db': PlantDbPanel,
        favorites: FavoritesPanel,
      },
    }

function Gallery() {
  const panelProjection = galleryPanelProjection()

  return <div className={styles.gallery} data-gallery-ready={galleryCanvasReady.value}>
    <header className={styles.title}><strong>canopi</strong><span>Orchard notebook</span><span>UI gallery</span>
      <button onClick={() => { theme.value = theme.value === 'light' ? 'dark' : 'light' }}>{theme.value === 'light' ? 'Dark' : 'Light'} theme</button>
    </header>
    <nav className={styles.review} aria-label="Review surfaces">
      {Object.entries(GALLERY_SURFACES)
        .filter(([key]) => edition === 'desktop' || key !== 'notebook')
        .map(([key, label]) => <button data-panel={key === 'key' ? 'species-key' : key === 'notebook' ? 'design-notebook' : key} aria-pressed={selectedSurface.value === key} onClick={() => selectGallerySurface(key as GallerySurface)}>{label}</button>)}
      <span>Edition:</span>
      {(['desktop', 'web'] as const).map((nextEdition) => <a aria-current={edition === nextEdition ? 'page' : undefined} href={editionUrl(nextEdition)}>{nextEdition}</a>)}
      <span>State:</span>{['populated', 'empty', 'mixed', 'long', 'located', 'dense', 'planting', 'zone', 'overview', 'max-zoom', 'lidar-progress', 'lidar-failure', 'lidar-missing', 'lidar-long', 'lidar-raster', 'no-design'].map(state => <a aria-current={fixtureState === state ? 'page' : undefined}
        href={`?surface=${selectedSurface.value}&state=${state}&theme=${theme.value}&locale=${locale.value}${edition === 'web' ? '&edition=web' : ''}`}>{state}</a>)}
    </nav>
    {selectedSurface.value === 'workspace' && edition === 'desktop' ? <GalleryWorkspaceCommands panelProjection={panelProjection} /> : null}
    <main className={styles.workspace} data-edition={edition}>
      {selectedSurface.value === 'start' ? <GalleryStart /> : selectedSurface.value === 'symbols' ? <PlantSymbolSheet /> : edition === 'web' ? (
        <GalleryWebFrame>
          <WorkspaceComposition
            panelProjection={panelProjection}
            surfaces={workspaceSurfaces}
            responsive
            phoneTabs={galleryPhoneTabs()}
            phoneBar={<WebPhoneBar />}
            phoneOptions={<ToolOptions />}
          />
        </GalleryWebFrame>
      ) : (
        <>
          <WorkspaceComposition panelProjection={panelProjection} surfaces={workspaceSurfaces} />
          <DataDialogs />
          <GalleryDesktopFrame />
          {selectedSurface.value === 'stories' ? <StoryPresenter /> : null}
          {selectedSurface.value === 'snapshots'
            ? <GalleryViewSnapshots ready={galleryCanvasReady.value} tiles={params.get('tiles') === '1'} />
            : null}
        </>
      )}
    </main>
    {/* A live status line: ARIA in HTML allows no status role on a footer. */}
    <div className={styles.status} role="status">{activity.value}</div>
  </div>
}

function GalleryCanvasWorkspace() {
  const session = currentCanvasSession.value
  const surface = selectedSurface.value
  const ready = galleryCanvasReady.value

  useEffect(() => {
    if (!session) {
      setGalleryCanvasReady(false)
      return
    }
    const rawBearing = Number(params.get('bearing'))
    const bearingDeg = Number.isFinite(rawBearing) ? rawBearing : 0
    if (bearingDeg !== 0) {
      // Turned about the fitted centre at the same zoom, as a restored view is: no animation, never snapped.
      const { camera } = session.queries.view.captureView()
      session.commands.viewport.showCamera({ ...camera, bearingDeg }, { motion: 'jump' })
    }
    if (fixtureState === 'dense') {
      for (let i = 0; i < 6; i++) session.commands.viewport.zoomOut()
    }
    if (fixtureState === 'overview') {
      for (let i = 0; i < 100; i++) session.commands.viewport.zoomOut()
    } else if (fixtureState === 'max-zoom') {
      for (let i = 0; i < 100; i++) session.commands.viewport.zoomIn()
    }
    if (fixtureState === 'zone') session.commands.sceneEdits.selectAll()
    else session.commands.sceneEdits.selectSpecies([specimens[0][0]])
    setGalleryCanvasReady(true)
  }, [session])

  useEffect(() => {
    if (!ready || !surface.startsWith('menu-') || !session) return
    const container = document.querySelector<HTMLElement>('[data-map-active]')
    if (!container) return
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
      ...(sceneEdits.saveSelectionAsObjectStamp ? { saveSelectionAsObjectStamp: sceneEdits.saveSelectionAsObjectStamp } : {}),
      returnFocus: () => container.focus(),
    }
    const timer = window.setTimeout(() => openCanvasContextMenu(request), 1500)
    return () => {
      window.clearTimeout(timer)
      closeCanvasContextMenu(request)
    }
  }, [ready, session, surface])

  useEffect(() => {
    if (!ready || surface !== 'lens') return
    document.querySelector<HTMLButtonElement>('button[data-inspection-launcher][aria-expanded="false"]')?.click()
  }, [ready, surface])

  const locationButton = surface === 'location'
    ? GALLERY_LOCATION_BUTTONS.get(parseGalleryLocationState(params.get('location')))
    : undefined

  if (edition === 'web' || locationButton) {
    return (
      <WebCanvasWorkspace
        {...(locationButton ? { myLocation: locationButton } : {})}
      />
    )
  }
  return <CanvasPanel />
}

function setGalleryCanvasReady(ready: boolean): void {
  galleryCanvasReady.value = ready
  // `surface=stories&present=1` presents the story from its third step once the map is ready.
  // The map flies there; it jumps only when the browser prefers reduced motion (emulate it for captures).
  if (ready && initial === 'stories' && params.get('present') === '1') {
    presentStory('story-visit', 2)
  }
}

function selectGallerySurface(next: GallerySurface): void {
  selectedSurface.value = next
  speciesCatalogWorkbench.closeSpeciesDetail()
  selectGalleryPanel(next)
  planningView.calendarExpanded.value = next === 'calendar-expanded'
  plantColorMenuOpen.value = next === 'color'
  plantSymbolMenuOpen.value = next === 'symbol'
  showGalleryDataSurface(next)
  // Stories opens on the third step, as the StoryAuthor board shows it.
  if (next === 'stories' && fixtureState !== 'empty') selectStep('step-hedges')
  const url = new URL(location.href)
  url.searchParams.set('surface', next)
  history.replaceState(null, '', url)
}

const galleryWebCatalog = createBrowserShellCatalog(createBrowserShellCapabilities({
  newDesign: async () => { activity.value = 'New Design stays in memory.' },
  openCanopi: async () => { activity.value = 'Opened the sample Design in memory.'; return true },
  downloadCanopi: async () => { activity.value = 'Download completed in memory.' },
  revertDesign: async () => { activity.value = 'Reverted the sample Design in memory.' },
  closeDesign: async () => { activity.value = 'Close Design returns to the Start screen.' },
}, (error) => console.error(error), {
  importGeoJson: async () => { activity.value = 'GeoJSON import stays in memory.'; return { status: 'cancelled' as const } },
  exportGeoJson: async () => { activity.value = 'GeoJSON export completed in memory.'; return { status: 'cancelled' as const } },
}), { templatesEnabled: false, canvasReady: () => true })

function galleryWebProjection() {
  return createBrowserShellCommandProjection({
    catalog: galleryWebCatalog,
    state: { hasDesign: true, revertAvailable: false, activePanel: activePanel.value, sidePanel: sidePanel.value },
    canvas: workspaceCanvasCommandProjection.value,
  })
}

function galleryPhoneTabs() {
  return browserPhoneSheetTabs(galleryWebProjection().panelBar)
}

function galleryPanelProjection(): WorkspacePanelProjection {
  if (edition === 'desktop') return appCommandGraphPanelProjection.value
  return galleryWebProjection().panelBar
}

/** The Desktop frame over the gallery workspace: the production title bar, rail and dialogs. */
function GalleryDesktopFrame() {
  if (selectedSurface.value !== 'workspace' && selectedSurface.value !== 'start') return null
  return <>
    <TitleBar />
    <NoticeRow />
    <ToastSlot />
    {selectedSurface.value === 'workspace' && <DesktopPanelRail />}
    {selectedSurface.value === 'workspace' && <WorkspaceDialogs />}
    <SettingsDialog folders={{ load: async () => galleryAppFolders, show: async (folder) => { activity.value = `Show folder: ${folder}` } }} />
    {keyboardShortcutsDialogOpen.value && (
      <KeyboardShortcutsDialog
        menus={appCommandGraphChromeProjection.value.menus}
        {...(shortcutsPlatform ? { platform: shortcutsPlatform } : {})}
        linuxPinchNote={shortcutsPlatform?.os === 'linux'}
      />
    )}
  </>
}

function GalleryWebFrame({ children }: { readonly children: preact.ComponentChildren }) {
  const projection = galleryWebProjection()
  const undoAction = workspaceCanvasCommandProjection.value.historyActions.find((action) => action.id === 'undo')
  return <>
    <BrowserAppShell
      commandProjection={projection}
      designIdentity={{ name: file.name, saveStatus: galleryReadOnly ? 'read-only' : 'draft', saveFailureReason: null }}
      placeSearch
      {...(undoAction ? { undo: undoAction } : {})}
    >
      {children}
    </BrowserAppShell>
    <WorkspaceDialogs />
    <SettingsDialog />
    {/* Browsers on Linux deliver a trackpad pinch as Ctrl + wheel: no Linux note on the Web Edition. */}
    {keyboardShortcutsDialogOpen.value && <KeyboardShortcutsDialog menus={projection.workspaceMenus} {...(shortcutsPlatform ? { platform: shortcutsPlatform } : {})} />}
  </>
}

function GalleryStart() { return <><WelcomeScreen /><GalleryDesktopFrame /></> }

function GalleryWorkspaceCommands({ panelProjection }: { readonly panelProjection: WorkspacePanelProjection }) {
  return (
    <nav className={styles.workspaceCommands} aria-label="Workspace panel commands">
      {[...panelProjection.primary, ...panelProjection.design, ...panelProjection.planning].map((command) => command.panel ? (
        <button type="button" data-gallery-workspace-panel={command.panel} onClick={() => navigateTo(command.panel!)}>
          {command.panel}
        </button>
      ) : null)}
    </nav>
  )
}

/** The data workflow surfaces: Site data (with `open=<id>` opened under its row), the Data library sheet, Import and Analyze. */
function showGalleryDataSurface(next: GallerySurface): void {
  libraryView.value = null
  dataDialog.value = null
  if (next === 'library') openDataLibrary(openItem)
  if (next === 'import') {
    dataDialog.value = { kind: 'import', paths: ['/data/LHD_FXX_0470_6800_MNT_O_0M50_LAMB93_IGN69.tif', '/data/LHD_FXX_0470_6801_MNT_O_0M50_LAMB93_IGN69.tif'] }
  }
  if (next === 'analyze') analyzeItem('lidar-ground')
  if (next === 'site-data' && openItem && currentDesign.peek()) showInSiteData(openItem)
}

function GalleryLayersSurface() { return <LayersPanel /> }
function GallerySiteDataSurface() { return <SiteDataPanel /> }
function GalleryNotebookSurface() { return <DesignNotebookPanel workbench={notebookWorkbench} /> }
function WebCatalogSurface() { return <WebSpeciesCatalogPanel mode="catalog" /> }
function WebFavoritesSurface() { return <WebSpeciesCatalogPanel mode="favorites" /> }

function editionUrl(nextEdition: 'desktop' | 'web'): string {
  const url = new URL(location.href)
  if (nextEdition === 'web') url.searchParams.set('edition', 'web')
  else url.searchParams.delete('edition')
  return `${url.pathname}${url.search}`
}

selectGallerySurface(initial)
const root = document.getElementById('app')!
render(<Gallery />, root)
if (import.meta.hot) import.meta.hot.dispose(() => { render(null, root); disposeTheme(); disposeHealthNotices() })
