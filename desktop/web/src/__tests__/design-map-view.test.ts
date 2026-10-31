// @vitest-environment jsdom

// U28 and U30: a Design keeps the view it was saved with (`map_view`, GeoLibre's mapView). Every write that happens anyway
// (continuous save after an edit, a Draft write) carries the live view, and a manual Save or Save As always writes it; panning
// alone edits nothing and writes nothing, so closing, switching Designs, page hide and focus loss write only what they would
// write without it. Driven through
// the real runtime and the real persistence, continuous-save, replacement and session paths.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppCanvasRuntimeAppAdapter } from '../app/canvas-runtime/app-adapter'
import { retryDesignSave } from '../app/document-session/actions'
import { createDesignSessionPersistence } from '../app/document-session/persistence'
import { createDesignSessionReplacement } from '../app/document-session/replacement'
import { createDesignSessionStateMachine } from '../app/document-session/state-machine'
import { createDesignSessionStore } from '../app/document-session/store'
import {
  prepareDesignWriteDestination,
  prepareSynchronousDesignWriteDestination,
} from '../app/document-session/write-admission'
import { persistLastView } from '../app/canvas-map-surface/last-view'
import { resetSettingsProjectionForTests } from '../app/settings/projection'
import { lastView } from '../app/settings/state'
import { savedViewCameraOf, savedViewZoom } from '../canvas/saved-view-framing'
import { geographicViewOfCamera } from '../canvas/session-plane'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { createBrowserAppDataStore } from '../web/browser-app-data'
import { createBrowserDesignSessionController } from '../web/browser-design-session'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from './support/live-canvas-runtime'
import type * as DocumentSessionTransitionModule from '../app/document-session/transition'

const SITE = { lon: -1.5536, lat: 47.2184 }
const PATH = '/designs/orchard.canopi'

function orchard(): CanopiFile {
  const plant = (id: string, lonOffset: number): CanopiFile['plants'][number] => ({
    id, locked: false, canonical_name: 'Malus domestica', common_name: null, color: null,
    pinned_name: false, position: { lon: SITE.lon + lonOffset, lat: SITE.lat }, rotation: null, scale: null, notes: null,
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

// The title bar's Retry acts on the app's Design Session; these tests point it at the session they opened.
const retryTarget = vi.hoisted(() => ({ continuousSave: null as unknown }))
vi.mock('../app/document-session/transition', async (importOriginal) => {
  const original = await importOriginal<typeof DocumentSessionTransitionModule>()
  return {
    ...original,
    get designContinuousSave() { return retryTarget.continuousSave ?? original.designContinuousSave },
  }
})

const hosts: CanvasRuntimeHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.destroy()
  resetSettingsProjectionForTests()
  lastView.value = null
  retryTarget.continuousSave = null
})

/** A live runtime on a map of `screen` whose clean state reaches `store`. */
function liveHost(
  store: ReturnType<typeof createDesignSessionStore>,
  screen = { width: 1200, height: 800 },
): CanvasRuntimeHost {
  const host = createLiveTestCanvasRuntimeHost({
    screen,
    appAdapter: {
      ...createAppCanvasRuntimeAppAdapter({ presentationData: {} }),
      cleanState: { setCanvasClean: (clean) => store.setCanvasClean(clean) },
    },
  })
  hosts.push(host)
  return host
}

/** A file opened through the replacement path, on a map of `screen` (1200 x 800) whose clean state reaches `store`. */
function openOrchard(
  file: CanopiFile = orchard(),
  screen = { width: 1200, height: 800 },
): { host: CanvasRuntimeHost; store: ReturnType<typeof createDesignSessionStore> } {
  const store = createDesignSessionStore({ file: null })
  const host = liveHost(store, screen)
  const replacement = createDesignSessionReplacement({ store, workflowRunner: { install: vi.fn(), dispose: vi.fn() } })
  replacement.replace({ file, kind: 'loaded', path: PATH, name: file.name }, host.surfaces.documents, () => true)
  return { host, store }
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

describe('the view a Design is saved with', () => {
  it('Save and the Web draft write the live view after a pan, zoom and turn', async () => {
    const { host, store } = openOrchard()
    const persistence = createDesignSessionPersistence({ store })
    persistence.attachCanvas(host.surfaces.documents)
    moveTheView(host)
    const expected = liveMapView(host)
    expect(expected.bearing).toBeCloseTo(35, 6)
    expect(expected.ground_size_m).toBeDefined()

    const saved: CanopiFile[] = []
    await persistence.beginSave().execute(prepareDesignWriteDestination({
      resource: `native-design:${PATH}`,
      destinationPath: PATH,
      write: (content) => { saved.push(content) },
    }))
    const drafted: CanopiFile[] = []
    persistence.beginBrowserDraft().executeImmediately(prepareSynchronousDesignWriteDestination({
      resource: 'browser-app-data:drafts',
      write: (content) => { drafted.push(content) },
    }))

    expect(saved.map((file) => file.map_view)).toEqual([expected])
    expect(drafted.map((file) => file.map_view)).toEqual([expected])
  })

  it('panning alone leaves the Design clean, adds no undo step, starts no write and keeps a replacement guard current', () => {
    const { host, store } = openOrchard()
    const persistence = createDesignSessionPersistence({ store })
    persistence.attachCanvas(host.surfaces.documents)
    const guard = persistence.beginReplacementGuard().guard
    const canvasRevision = store.canvasChangeRevision.value
    const designRevision = store.committedDesignRevision.value

    moveTheView(host)

    expect(store.isDesignDirty()).toBe(false)
    expect(host.surfaces.commands.history.canUndo.value).toBe(false)
    expect(store.canvasChangeRevision.value, 'continuous save writes on a canvas change').toBe(canvasRevision)
    expect(store.committedDesignRevision.value, 'or on a Design change').toBe(designRevision)
    expect(guard?.isCurrent(), 'a pan is not a change a replacement must guard').toBe(true)
  })
})

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

  it('an empty Design with a saved view opens north up on the new-Design overview', () => {
    const file = { ...orchard(), plants: [], map_view: savedOrchard().map_view }
    const { host } = openOrchard(file)

    expect(cameraOf(host).bearingDeg).toBe(0)
    expect(host.surfaces.queries.view.mode.value).toBe('overview')
  })

  it('a file without one opens with the fit at the live bearing, north up on the runtime\'s first open', () => {
    // A last view turned to 30 is this device's, not the file's: the first open is north up.
    persistLastView({ ...SITE, zoom: 18, bearing: 30 })
    const saved = savedOrchard()
    const { host, store } = openOrchard()

    expect(cameraOf(host).bearingDeg).toBeCloseTo(0, 6)
    expect(cameraOf(host).zoom).not.toBeCloseTo(saved.map_view!.zoom, 3)

    // A later open keeps the bearing the map shows.
    host.surfaces.commands.viewport.showCamera({ ...cameraOf(host), bearingDeg: 60 }, { motion: 'jump' })
    const replacement = createDesignSessionReplacement({ store, workflowRunner: { install: vi.fn(), dispose: vi.fn() } })
    replacement.replace({ file: orchard(), kind: 'loaded', path: PATH, name: 'Orchard' }, host.surfaces.documents, () => true)

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

/** One undoable Scene edit: every plant is locked. */
function editTheDesign(host: CanvasRuntimeHost): void {
  host.surfaces.commands.sceneEdits.selectAll()
  host.surfaces.commands.sceneEdits.lockSelected()
}

const SAVE_AS_PATH = '/designs/orchard-copy.canopi'

/**
 * The orchard opened from its file on Desktop through the real session state machine; `writes` collects each file write.
 * A write records its content when it starts and settles once `settle` (when given) resolves.
 */
async function openOnDesktop(file: CanopiFile = orchard(), settle?: () => Promise<void>) {
  const store = createDesignSessionStore({ file: null })
  const host = liveHost(store)
  const writes: { path: string; content: CanopiFile }[] = []
  const requestSaveDecision = vi.fn(async () => 'cancel')
  const machine = createDesignSessionStateMachine({
    store,
    getCurrentSession: () => host.surfaces.documents,
    selectDesignSavePath: async () => SAVE_AS_PATH,
    prepareDesignWrite: (path, _expectedFingerprint, onWritten) => prepareDesignWriteDestination({
      resource: `native-design:${path}`,
      destinationPath: path,
      write: async (content) => {
        writes.push({ path, content })
        const fingerprint = `fp-${writes.length}`
        await settle?.()
        onWritten(fingerprint)
      },
    }),
    prepareDraftWrite: (id) => prepareDesignWriteDestination({
      resource: `native-draft:${id}`,
      write: () => { throw new Error('the orchard has a file home') },
    }),
    deleteDesignDraft: async () => undefined,
    requestSaveDecision: requestSaveDecision as never,
    workflowRunner: { install: vi.fn(), dispose: vi.fn() },
  })
  machine.beginEmptyDocumentSession(host.surfaces.documents)
  await expect(machine.transitionDocument({
    source: 'open-path',
    dirtyGuard: 'flush',
    session: host.surfaces.documents,
    load: async () => ({ file, path: PATH, name: file.name, fingerprint: 'fp-0' }),
  })).resolves.toMatchObject({ status: 'applied' })
  return { host, store, machine, writes, requestSaveDecision }
}

/** The orchard restored from its browser Draft on the Web, through the real browser session controller. */
function openOnWeb() {
  const values = new Map<string, string>()
  const appDataStore = createBrowserAppDataStore({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  appDataStore.saveDraft({ id: 'draft-orchard', file: orchard(), now: '2026-10-05T08:00:00.000Z' })
  const store = createDesignSessionStore()
  const host = liveHost(store)
  const requestSaveDecision = vi.fn(async () => 'cancel')
  const controller = createBrowserDesignSessionController({
    store,
    appDataStore,
    now: () => new Date('2026-10-05T09:00:00.000Z'),
    createDraftId: () => 'draft-next',
    requestSaveDecision: requestSaveDecision as never,
    workflowRunner: { install: vi.fn(), dispose: vi.fn() },
  })
  const detach = controller.attachCanvasSession(host.surfaces.documents)
  expect(controller.restoreLatestDraft()).toBe(true)
  const page = {
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState }),
    window: new EventTarget(),
  }
  const uninstall = controller.installContinuousSave(page)
  const record = () => ({
    file: appDataStore.loadDraft('draft-orchard'),
    summary: appDataStore.listDrafts().find((draft) => draft.id === 'draft-orchard'),
  })
  return { host, store, controller, page, detach, uninstall, record, requestSaveDecision }
}

describe('the view reaches the home only with a write that already happens (U30)', () => {
  it('an edit, then a pan: the next continuous save writes the panned view, and reopening restores it', async () => {
    vi.useFakeTimers()
    try {
      const { host, machine, writes } = await openOnDesktop()
      const uninstall = machine.continuousSave.install()
      editTheDesign(host)
      moveTheView(host)
      const panned = liveMapView(host)

      await vi.advanceTimersByTimeAsync(10_000)
      uninstall()

      expect(writes.map((write) => write.content.map_view)).toEqual([panned])
      const { host: reopened } = openOrchard(writes[0]!.content)
      expectCameraAt(reopened, panned)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a manual Save writes the live view with the edits, and Save As writes it with no edit', async () => {
    const { host, machine, writes } = await openOnDesktop()
    editTheDesign(host)
    moveTheView(host)

    await expect(machine.saveCurrentDesign()).resolves.toBe(true)
    expect(writes.map((write) => [write.path, write.content.map_view])).toEqual([[PATH, liveMapView(host)]])

    host.cameraHost.current().apply({ kind: 'pan-by', deltaPx: { x: 30, y: 0 } })
    await expect(machine.saveAsCurrentDesign()).resolves.toMatchObject({ status: 'applied' })
    expect(writes.map((write) => write.path)).toEqual([PATH, SAVE_AS_PATH])
    expect(writes[1]?.content.map_view).toEqual(liveMapView(host))
  })

  it('a manual Save after panning only writes the live view, and reopening restores it', async () => {
    const { host, machine, writes, requestSaveDecision } = await openOnDesktop()
    moveTheView(host)
    const panned = liveMapView(host)

    await expect(machine.saveCurrentDesign()).resolves.toBe(true)

    expect(writes.map((write) => [write.path, write.content.map_view])).toEqual([[PATH, panned]])
    expect(machine.continuousSave.status.value).toBe('saved')
    expect(machine.continuousSave.hasPendingChanges()).toBe(false)
    expect(requestSaveDecision).not.toHaveBeenCalled()
    const { host: reopened } = openOrchard(writes[0]!.content)
    expectCameraAt(reopened, panned)
  })

  it('a manual Save while a continuous save is writing follows it with the view moved since', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const { host, machine, writes } = await openOnDesktop(orchard(), () => held)
    editTheDesign(host)
    const inFlight = machine.continuousSave.flush()
    expect(writes).toHaveLength(1)
    moveTheView(host)

    const saved = machine.saveCurrentDesign()
    release()

    await inFlight
    await expect(saved).resolves.toBe(true)
    expect(writes).toHaveLength(2)
    expect(writes[1]?.content.map_view).toEqual(liveMapView(host))
  })

  it('a second Save while a Save is writing follows it with the view moved since', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const { host, machine, writes } = await openOnDesktop(orchard(), () => held)
    moveTheView(host)
    const first = machine.saveCurrentDesign()
    expect(writes).toHaveLength(1)
    host.cameraHost.current().apply({ kind: 'pan-by', deltaPx: { x: -90, y: 45 } })
    const panned = liveMapView(host)
    expect(panned).not.toEqual(writes[0]?.content.map_view)

    const second = machine.saveCurrentDesign()
    release()

    await first
    await expect(second).resolves.toBe(true)
    expect(writes.map((write) => write.content.map_view)).toEqual([writes[0]?.content.map_view, panned])
    expect(machine.continuousSave.hasPendingChanges()).toBe(false)
  })

  it('a manual Save that the file refuses after panning only shows the error, then focus loss, switching and closing write and ask nothing', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { host, machine, writes, requestSaveDecision } = await openOnDesktop(orchard(), async () => {
        throw new Error('EACCES: permission denied')
      })
      moveTheView(host)

      await expect(machine.saveCurrentDesign()).resolves.toBe(false)
      expect(machine.continuousSave.status.value, 'the refused Save shows').toBe('error')
      expect(machine.continuousSave.hasPendingChanges(), 'nothing was edited').toBe(false)

      await expect(machine.continuousSave.flush(), 'focus loss does not retry the Save').resolves.toBe(true)
      await expect(machine.transitionDocument({
        source: 'open-path',
        dirtyGuard: 'flush',
        session: host.surfaces.documents,
        load: async () => ({ file: orchard(), path: '/designs/next.canopi', name: 'Next', fingerprint: 'fp-next' }),
      })).resolves.toMatchObject({ status: 'applied' })
      await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'applied' })

      expect(writes, 'only the Save tried to write').toHaveLength(1)
      expect(requestSaveDecision).not.toHaveBeenCalled()
    } finally {
      failures.mockRestore()
    }
  })

  it('Retry after a Save the file refused with only the view moved writes the live view again, and clears the error once it lands', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let refuse = true
      const { host, machine, writes } = await openOnDesktop(orchard(), async () => {
        if (refuse) throw new Error('EACCES: permission denied')
      })
      retryTarget.continuousSave = machine.continuousSave
      moveTheView(host)
      await expect(machine.saveCurrentDesign()).resolves.toBe(false)
      expect(machine.continuousSave.status.value).toBe('error')

      await retryDesignSave()
      expect(writes, 'Retry tries the Save again').toHaveLength(2)
      expect(machine.continuousSave.status.value, 'a refused Retry keeps the error').toBe('error')

      refuse = false
      host.cameraHost.current().apply({ kind: 'pan-by', deltaPx: { x: 25, y: 10 } })
      await retryDesignSave()
      expect(writes.map((write) => write.content.map_view)).toHaveLength(3)
      expect(writes[2]?.content.map_view).toEqual(liveMapView(host))
      expect(machine.continuousSave.status.value).toBe('saved')
      expect(machine.continuousSave.hasPendingChanges()).toBe(false)
    } finally {
      failures.mockRestore()
    }
  })

  it('Retry after a Save the file refused with an edit pending writes the edit', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let refuse = true
      const { host, machine, writes } = await openOnDesktop(orchard(), async () => {
        if (refuse) throw new Error('EACCES: permission denied')
      })
      retryTarget.continuousSave = machine.continuousSave
      editTheDesign(host)
      await expect(machine.saveCurrentDesign()).resolves.toBe(false)
      expect(machine.continuousSave.status.value).toBe('error')
      expect(machine.continuousSave.hasPendingChanges()).toBe(true)

      refuse = false
      await retryDesignSave()
      expect(writes).toHaveLength(2)
      expect(writes[1]?.content.plants.every((plant) => plant.locked)).toBe(true)
      expect(machine.continuousSave.status.value).toBe('saved')
      expect(machine.continuousSave.hasPendingChanges()).toBe(false)
    } finally {
      failures.mockRestore()
    }
  })

  it('adding a clean Design with a file home to a notebook writes nothing, even after a pan', async () => {
    const { host, machine, writes, requestSaveDecision } = await openOnDesktop()
    moveTheView(host)

    await expect(machine.saveCurrentDesignEdits()).resolves.toBe(true)

    expect(writes, 'only Save writes when nothing was edited').toEqual([])
    expect(requestSaveDecision).not.toHaveBeenCalled()
    editTheDesign(host)
    await expect(machine.saveCurrentDesignEdits()).resolves.toBe(true)
    expect(writes.map((write) => write.content.map_view)).toEqual([liveMapView(host)])
  })

  it('on Desktop, panning only, then losing focus, switching Designs or closing writes nothing and asks nothing', async () => {
    const { host, machine, writes, requestSaveDecision } = await openOnDesktop()
    moveTheView(host)

    expect(machine.continuousSave.status.value, 'nothing reads as unsaved').toBe('saved')
    await expect(machine.continuousSave.flush(), 'focus loss flushes').resolves.toBe(true)
    await expect(machine.transitionDocument({
      source: 'open-path',
      dirtyGuard: 'flush',
      session: host.surfaces.documents,
      load: async () => ({ file: orchard(), path: '/designs/next.canopi', name: 'Next', fingerprint: 'fp-next' }),
    })).resolves.toMatchObject({ status: 'applied' })
    moveTheView(host)
    await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'applied' })

    expect(writes, 'the files keep their bytes and mtime').toEqual([])
    expect(requestSaveDecision).not.toHaveBeenCalled()
  })

  it('on the Web, panning only, then page hide, detaching the canvas or closing leaves the Draft as it was', async () => {
    const web = openOnWeb()
    try {
      const stored = web.record()
      expect(stored.file).not.toBeNull()

      moveTheView(web.host)
      expect(web.controller.continuousSave.status.value, 'nothing reads as unsaved').toBe('draft')
      web.page.window.dispatchEvent(new Event('pagehide'))
      expect(web.record()).toEqual(stored)
      web.detach()
      expect(web.record(), 'switching the primary surface to Templates').toEqual(stored)
      web.controller.attachCanvasSession(web.host.surfaces.documents)
      moveTheView(web.host)
      await web.controller.closeDesign()
      expect(web.record()).toEqual(stored)
      expect(web.requestSaveDecision).not.toHaveBeenCalled()
    } finally {
      web.uninstall()
    }
  })

  it('on the Web, panning only, then switching to a new Design leaves the Draft as it was', async () => {
    const web = openOnWeb()
    try {
      const stored = web.record()
      moveTheView(web.host)
      await web.controller.newDesign()
      expect(web.record()).toEqual(stored)
      expect(web.requestSaveDecision).not.toHaveBeenCalled()
    } finally {
      web.uninstall()
    }
  })
})
