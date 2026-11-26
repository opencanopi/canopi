// @vitest-environment jsdom

// U28 and U30: a Design keeps the view it was saved with (`map_view`, GeoLibre's mapView). Every write that happens anyway
// (continuous save after an edit, a Draft write) carries the live view, and a manual Save or Save As always writes it; panning
// alone edits nothing and writes nothing. Driven through the real runtime and SessionCore.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppCanvasRuntimeAppAdapter } from '../app/canvas-runtime/app-adapter'
import { scenePortOf } from '../app/canvas-map-surface/scene-port'
import { persistLastView } from '../app/canvas-map-surface/last-view'
import { designSaveStatus, retryDesignSave, saveCurrentDesign } from '../app/document-session/actions'
import { designSessionStore } from '../app/document-session/store'
import { resetSettingsProjectionForTests } from '../app/settings/projection'
import { lastView } from '../app/settings/state'
import { savedViewCameraOf, savedViewZoom } from '../canvas/saved-view-framing'
import { geographicViewOfCamera } from '../geo/session-plane'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from './support/live-canvas-runtime'
import { createTestSessionCore, type TestSessionCoreHandle } from './support/session-core-fixture'

const SITE = { lon: -1.5536, lat: 47.2184 }
const PATH = '/designs/orchard.canopi'

function orchard(): CanopiFile {
  const plant = (id: string, lonOffset: number): CanopiFile['plants'][number] => ({
    id, locked: false, canonical_name: 'Malus domestica', common_name: null, color: null,
    pinned_name: false, position: { lon: SITE.lon + lonOffset, lat: SITE.lat }, rotation: null, canopy_spread_m: null, notes: null,
    planted_date: null, quantity: null,
  })
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Orchard',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [plant('a', 0), plant('b', 0.0004)],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
  }
}

const hosts: CanvasRuntimeHost[] = []
const handles: TestSessionCoreHandle[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.destroy()
  for (const h of handles.splice(0)) h.dispose()
  resetSettingsProjectionForTests()
  lastView.value = null
})

function openOrchard(
  file: CanopiFile = orchard(),
  screen = { width: 1200, height: 800 },
): { host: CanvasRuntimeHost; handle: TestSessionCoreHandle } {
  const handle = createTestSessionCore({
    file,
    path: PATH,
    name: file.name,
    newDesignFactory: () => orchard(),
  })
  handles.push(handle)
  const host = createLiveTestCanvasRuntimeHost({
    screen,
    appAdapter: createAppCanvasRuntimeAppAdapter({ presentationData: {} }),
  })
  hosts.push(host)
  handle.core.attachScene(scenePortOf(host.surfaces.documents))
  return { host, handle }
}

/** Pans, zooms and turns the live view, as the map's gestures move it. */
function moveTheView(host: CanvasRuntimeHost): void {
  const camera = host.cameraHost.current()
  camera.apply({ kind: 'pan-by', deltaPx: { x: 140, y: -60 } })
  camera.apply({ kind: 'zoom-around', anchorPx: { x: 300, y: 200 }, factor: 1.6 })
  camera.apply({ kind: 'rotate-around', anchorPx: 'centre', bearingDeg: 35 })
}

/** What saving now should write: the live view as stored, with the ground the whole map shows. */
function liveMapView(host: CanvasRuntimeHost) {
  const { camera, screen } = host.surfaces.queries.view.captureView()
  return savedViewCameraOf(geographicViewOfCamera(camera), screen)!
}

/** The orchard as saved after a pan, zoom and turn on a 1200 x 800 map. */
function savedOrchard(): CanopiFile {
  const { host } = openOrchard()
  moveTheView(host)
  return { ...orchard(), map_view: liveMapView(host) }
}

function cameraOf(host: CanvasRuntimeHost) {
  return host.surfaces.queries.view.captureView().camera
}

function expectCameraAt(host: CanvasRuntimeHost, at: { lon: number; lat: number; zoom: number; bearing: number }): void {
  const camera = cameraOf(host)
  expect(camera.center.lon).toBeCloseTo(at.lon, 9)
  expect(camera.center.lat).toBeCloseTo(at.lat, 9)
  expect(camera.zoom).toBeCloseTo(at.zoom, 9)
  expect(camera.bearingDeg).toBeCloseTo(at.bearing, 9)
}

/** One undoable Scene edit: every plant is locked. */
function editTheDesign(host: CanvasRuntimeHost): void {
  host.surfaces.commands.sceneEdits.selectAll()
  host.surfaces.commands.sceneEdits.lockSelected()
}

function readWrittenFile(handle: TestSessionCoreHandle, key = PATH): CanopiFile {
  const entry = handle.home.files.get(key)
  if (!entry) throw new Error(`Expected written file at ${key}`)
  return JSON.parse(new TextDecoder().decode(entry.bytes)) as CanopiFile
}

describe('the view a Design is saved with', () => {
  it('panning alone leaves the Design clean, adds no undo step, and keeps a capture current', () => {
    const { host } = openOrchard()
    const capture = host.surfaces.documents.captureForPersistence(
      { name: designSessionStore.readDesignName() },
      designSessionStore.readCurrentDesign()!,
    )

    moveTheView(host)

    expect(designSessionStore.isDesignDirty()).toBe(false)
    expect(host.surfaces.commands.history.canUndo.value).toBe(false)
    expect(capture.isCurrent(), 'a pan is not a change a replacement must guard').toBe(true)
  })

  it('an edit, then a pan: flushing writes the panned view, and reopening restores it', async () => {
    const { host, handle } = openOrchard()
    editTheDesign(host)
    moveTheView(host)
    const panned = liveMapView(host)

    expect(await saveCurrentDesign()).toBe(true)

    const written = readWrittenFile(handle)
    expect(written.map_view).toEqual(panned)
    const { host: reopened } = openOrchard(written)
    expectCameraAt(reopened, panned)
  })

  it('Save As writes the live view to the new file', async () => {
    const { host, handle } = openOrchard()
    moveTheView(host)
    const panned = liveMapView(host)
    const saveAsPath = '/designs/orchard-copy.canopi'
    handle.fileAccess.setPickHomeTarget({ kind: 'picked', grant: saveAsPath })

    await expect(handle.core.saveAs()).resolves.toBe('saved')
    expect(readWrittenFile(handle, saveAsPath).map_view).toEqual(panned)
  })

  it('Retry after a Save the file refused with an edit pending writes the edit and live view', async () => {
    const { host, handle } = openOrchard()
    handle.home.setWriteResult({
      kind: 'failed',
      failure: { code: { kind: 'io', io: 'other' }, op: 'design.write', operation: 'design.write' as never, detail: 'EACCES: permission denied' as never, user_may_retry: true },
    })
    editTheDesign(host)
    moveTheView(host)
    const panned = liveMapView(host)

    await expect(saveCurrentDesign()).resolves.toBe(false)
    expect(designSaveStatus.value).toBe('error')

    handle.home.setWriteResult(null)
    await retryDesignSave()

    expect(designSaveStatus.value).toBe('saved')
    const written = readWrittenFile(handle)
    expect(written.plants.every((plant) => plant.locked)).toBe(true)
    expect(written.map_view).toEqual(panned)
  })

  it('panning only, then closing or switching Designs writes nothing', async () => {
    const { host, handle } = openOrchard()
    const writeSpy = vi.spyOn(handle.home, 'write')
    moveTheView(host)

    expect(designSaveStatus.value).toBe('saved')
    await expect(handle.core.flushNow()).resolves.toBe(true)
    handle.home.seedFile('/designs/next.canopi', orchard())
    await expect(handle.core.openFrom({ kind: 'file', grant: '/designs/next.canopi' })).resolves.toMatchObject({ status: 'opened' })
    moveTheView(host)
    await expect(handle.core.close('close')).resolves.toBe('closed')

    expect(writeSpy).not.toHaveBeenCalled()
  })
})

describe('opening a Design at the view it was saved with', () => {
  it('the window it was saved in restores the exact camera', () => {
    const file = savedOrchard()
    const { host } = openOrchard(file)

    expectCameraAt(host, file.map_view!)
  })

  it('a smaller window zooms out just enough to show the framed ground, at the same centre and bearing', () => {
    const file = savedOrchard()
    const smaller = { width: 800, height: 600 }
    const { host } = openOrchard(file, smaller)

    const zoom = savedViewZoom(file.map_view!, smaller)
    expect(zoom).toBeLessThan(file.map_view!.zoom - 0.1)
    expectCameraAt(host, { ...file.map_view!, zoom })
  })

  it('canopi-eon8.9: an empty Design with a saved view opens at that view, north up (2.1-Q28)', () => {
    const file = { ...orchard(), plants: [], map_view: savedOrchard().map_view }
    const { host } = openOrchard(file)

    expectCameraAt(host, { ...file.map_view!, bearing: 0 })
  })

  it('a file without one opens with the fit at the live bearing, north up on the runtime\'s first open', () => {
    // A last view turned to 30 is this device's, not the file's: the first open is north up.
    persistLastView({ ...SITE, zoom: 18, bearing: 30 })
    const saved = savedOrchard()
    const { host } = openOrchard()

    expect(cameraOf(host).bearingDeg).toBeCloseTo(0, 6)
    expect(cameraOf(host).zoom).not.toBeCloseTo(saved.map_view!.zoom, 3)

    // A later open keeps the bearing the map shows.
    host.surfaces.commands.viewport.showCamera({ ...cameraOf(host), bearingDeg: 60 }, { motion: 'jump' })
    host.surfaces.documents.loadDocument(orchard())
    host.surfaces.documents.zoomToFit()

    expect(cameraOf(host).bearingDeg).toBeCloseTo(60, 6)
  })

  it('a cold open restores it, and the renderer mount does not fit over it', async () => {
    const file = savedOrchard()
    const host = createLiveTestCanvasRuntimeHost({
      screen: { width: 1200, height: 800 },
    })
    hosts.push(host)
    host.surfaces.documents.loadDocument(file)
    host.surfaces.documents.zoomToFit()
    expectCameraAt(host, file.map_view!)

    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1200 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 800 })
    await host.init(container)

    expectCameraAt(host, file.map_view!)
  })
})
