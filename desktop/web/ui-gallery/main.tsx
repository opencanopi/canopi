import { render } from 'preact'
import { effect, signal } from '@preact/signals'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../src/styles/global.css'
import styles from './gallery.module.css'
import { speciesCatalogWorkbench } from '../src/app/plant-browser'
import { DesktopSpeciesKeyPanel } from '../src/components/panels/DesktopSpeciesKeyPanel'
import { LayersPanel } from '../src/components/panels/LayersPanel'
import { DesignNotebookPanel } from '../src/components/panels/DesignNotebookPanel'
import { PlantDbPanel } from '../src/components/panels/PlantDbPanel'
import { DataDialogs } from '../src/components/panels/lidar/DataDialogs'
import { SiteDataPanel } from '../src/components/panels/lidar/SiteDataPanel'
import { FavoritesPanel } from '../src/components/panels/FavoritesPanel'
import { BudgetPanel } from '../src/components/panels/BudgetPanel'
import { CalendarPanel } from '../src/components/panels/CalendarPanel'
import { ConsortiumPanel } from '../src/components/panels/ConsortiumPanel'
import { StoriesPanel } from '../src/components/panels/StoriesPanel'
import { selectStep } from '../src/app/stories'
import { presentStory } from '../src/app/story-presentation'
import { StoryPresenter } from '../src/components/stories/StoryPresenter'
import { notebookWorkbench } from './notebook-fixture'
import { WebSpeciesCatalogPanel, WebSpeciesKeyPanel } from '../src/web/WebSpeciesCatalogPanel'
import { WebLayersPanel } from '../src/web/WebLayersPanel'
import {
  activePanel,
  navigateTo,
  sidePanel,
  sidePanelWidth,
} from '../src/app/shell/state'
import { plantColorMenuOpen } from '../src/canvas/plant-color-menu-state'
import { plantSymbolMenuOpen } from '../src/canvas/plant-symbol-menu-state'
import { plantDbStatus } from '../src/app/health/state'
import { theme, locale } from '../src/app/settings/state'
import { designFixture } from './fixtures'
import { currentDesign, designSessionStore } from '../src/app/document-session/store'
import { activity } from './memory-backend'
import { attachmentFailure, pendingAttachments } from '../src/app/lidar/actions'
import { analyzeItem, dataDialog, libraryView, openDataLibrary } from '../src/app/lidar/library-navigation'
import { showInSiteData } from '../src/app/lidar/site-data-view'
import { profileLineMenu } from '../src/app/lidar/profile'
import { GalleryCanvasSurface } from './GalleryCanvasSurface'
import { StampChooser } from '../src/components/canvas/StampChooser'
import { ToolOptions } from '../src/components/canvas/ToolCard'
import { PlantSymbolSheet } from './PlantSymbolSheet'
import { GalleryViewSnapshots } from './GalleryViewSnapshots'
import { readPlanningViewState } from '../src/app/planning-view/state'
import { appCommandGraphChromeProjection, appCommandGraphPanelProjection } from '../src/commands/registry'
import {
  createBrowserShellCapabilities,
  createBrowserShellCatalog,
  browserPhoneSheetTabs,
  createBrowserShellCommandProjection,
} from '../src/web/browser-shell-commands'
import { workspaceCanvasCommandProjection } from '../src/app/workspace-commands/canvas-actions'
import { keyboardShortcutsDialogOpen } from '../src/app/shell/dialogs'
import { TitleBar } from '../src/components/shared/TitleBar'
import { DesktopPanelRail } from '../src/components/panels/DesktopPanelRail'
import { SettingsDialog } from '../src/components/shared/SettingsDialog'
import { getAppFolders, showAppFolder } from '../src/ipc/settings'
import { KeyboardShortcutsDialog } from '../src/components/shared/KeyboardShortcutsDialog'
import type { InputPlatform } from '../src/canvas/runtime/input/platform'
import { WelcomeScreen } from '../src/components/shared/WelcomeScreen'
import { DegradedBanner } from '../src/components/shared/DegradedBanner'
import { BrowserAppShell } from '../src/web/BrowserAppShell'
import { WebPhoneBar } from '../src/web/WebWorkspace'
import {
  WorkspaceComposition,
  WorkspaceDialogs,
  type WorkspacePanelProjection,
  type WorkspaceSurfaces,
} from '../src/components/workspace/WorkspaceComposition'
import {
  GALLERY_SURFACES,
  parseGallerySurface,
  selectGalleryPanel,
  type GallerySurface,
} from './surface-routing'

if (!import.meta.env.DEV) throw new Error('Gallery cannot run in production.')
const params = new URLSearchParams(location.search)
const fixtureState = params.get('state') ?? 'populated'
const requestedPanelWidth = Number(params.get('panelWidth'))
const edition = params.get('edition') === 'web' ? 'web' : 'desktop'
const initial = parseGallerySurface(params.get('surface'))
/** `open=<id>`: the Site data item opened under its row, or the item the Data library selects. */
const openItem = params.get('open')
const selectedSurface = signal<GallerySurface>(initial)
const galleryCanvasReady = signal(false)
const file = designFixture(fixtureState)
// `state=no-design`: no Design is open, as on the Start screen (the empty Data library's Import… is disabled).
if (initial !== 'start' && fixtureState !== 'no-design') designSessionStore.replaceCurrentDesignState(file, null, file.name)
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
// `plantDb=corrupt|missing` shows the plant database notice under the title bar.
const plantDb = params.get('plantDb')
plantDbStatus.value = plantDb === 'corrupt' || plantDb === 'missing' ? plantDb : 'available'
// `bearing=30` turns the map 30° clockwise from north once the Design is fitted (compass, turned grid).
const requestedBearing = Number(params.get('bearing') ?? 0)
// `platform=mac|linux`: F1 (Help › Keyboard shortcuts) lists the gestures as on a Mac whose WebKit delivers gesture
// events (Control-click, the trackpad twist), or as on Linux with Desktop's pinch note. Only F1 reads it.
const requestedPlatform = params.get('platform')
const shortcutsPlatform: Pick<InputPlatform, 'os' | 'gestureEvents'> | undefined = requestedPlatform === 'mac'
  ? { os: 'mac', gestureEvents: true }
  : requestedPlatform === 'linux' ? { os: 'linux', gestureEvents: false } : undefined
const bearingDeg = Number.isFinite(requestedBearing) ? requestedBearing : 0

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
  return (
    <GalleryCanvasSurface
      activeSurface={selectedSurface}
      design={file}
      dense={fixtureState === 'dense'}
      cameraState={fixtureState === 'overview'
        ? 'overview'
        : fixtureState === 'max-zoom' ? 'maximum' : 'site'}
      selectAll={fixtureState === 'zone'}
      bearingDeg={bearingDeg}
      onReadyChange={setGalleryCanvasReady}
      stampChooser={edition === 'desktop' ? StampChooser : undefined}
      profileLine={edition === 'desktop' ? profileLineMenu : undefined}
    />
  )
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
    <DegradedBanner />
    {selectedSurface.value === 'workspace' && <DesktopPanelRail />}
    {selectedSurface.value === 'workspace' && <WorkspaceDialogs />}
    <SettingsDialog folders={{ load: getAppFolders, show: showAppFolder }} />
    {keyboardShortcutsDialogOpen.value && (
      <KeyboardShortcutsDialog
        menus={appCommandGraphChromeProjection.value.menus}
        platform={shortcutsPlatform}
        linuxPinchNote={shortcutsPlatform?.os === 'linux'}
      />
    )}
  </>
}

function GalleryWebFrame({ children }: { readonly children: preact.ComponentChildren }) {
  const projection = galleryWebProjection()
  return <>
    <BrowserAppShell
      commandProjection={projection}
      designIdentity={{ name: file.name, saveStatus: 'draft', saveFailureReason: null }}
      placeSearch
      undo={workspaceCanvasCommandProjection.value.historyActions.find((action) => action.id === 'undo')}
    >
      {children}
    </BrowserAppShell>
    <WorkspaceDialogs />
    <SettingsDialog />
    {/* Browsers on Linux deliver a trackpad pinch as Ctrl + wheel: no Linux note on the Web Edition. */}
    {keyboardShortcutsDialogOpen.value && <KeyboardShortcutsDialog menus={projection.workspaceMenus} platform={shortcutsPlatform} />}
  </>
}

function GalleryStart() {
  return <>
    <WelcomeScreen />
    <GalleryDesktopFrame />
  </>
}

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

function GalleryLayersSurface() {
  return <LayersPanel />
}

function GallerySiteDataSurface() {
  return <SiteDataPanel />
}

function GalleryNotebookSurface() {
  return <DesignNotebookPanel workbench={notebookWorkbench} />
}

function WebCatalogSurface() {
  return <WebSpeciesCatalogPanel mode="catalog" />
}

function WebFavoritesSurface() {
  return <WebSpeciesCatalogPanel mode="favorites" />
}

function editionUrl(nextEdition: 'desktop' | 'web'): string {
  const url = new URL(location.href)
  if (nextEdition === 'web') url.searchParams.set('edition', 'web')
  else url.searchParams.delete('edition')
  return `${url.pathname}${url.search}`
}

selectGallerySurface(initial)
const root = document.getElementById('app')!
render(<Gallery />, root)
if (import.meta.hot) import.meta.hot.dispose(() => { render(null, root); disposeTheme() })
