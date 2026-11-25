// Real-browser probe for 2d-1 ScenePainter (contracts §6, ADR 0004, 2.1-M525):
// Runs the real Pixi ScenePainter inside a real MapLibre map through a 3-cycle
// initialize -> addLayer -> presentFor -> removeLayer -> dispose remount loop in
// Chromium and WebKit, verifying:
//   1. Exactly one painter.paint() per eligible rendered frame.
//   2. Zero WebGL context losses across dispose and remount cycles.
//   3. No surviving Pixi Ticker.system after init or dispose.
//   4. presentFor(view) resolves on the MapLibre render event after paint.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '../support/offline'
import { pageBundle } from '../support/page-bundle'
import { WEB_PORT } from '../support/ports'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAPLIBRE_WORKER_PATH = resolve(HERE, '../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs')
const MAPLIBRE_SHARED_PATH = resolve(HERE, '../../node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs')

const PROBE_SOURCE = `
import { signal } from '@preact/signals'
import * as maplibregl from 'maplibre-gl'
import { Ticker, WebGLRenderer } from 'pixi.js'
import { createPixiScenePainter } from '../../src/canvas/runtime/renderers/pixi-scene-painter'
import { createSceneHostLayer } from '../../src/maplibre/scene-host-layer'
import { createMapLibreCameraDriver } from '../../src/maplibre/camera-driver'
import { createMapLibreEmptyStyle } from '../../src/maplibre/config'
import { createSessionPlane } from '../../src/geo/session-plane'
import { createNavigationPolicy } from '../../src/geo/view/navigation-policy'

function minimalSnapshot() {
  return {
    speciesFocus: { kind: 'none' },
    scene: {
      plants: [],
      zones: [{
        id: 'probe-zone-1',
        name: 'Probe',
        zoneType: 'polygon',
        rotation: 0,
        points: [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }],
        fillColor: '#cc2222',
        notes: null,
        locked: false,
      }],
      annotations: [],
      measurementGuides: [],
      groups: [],
      layers: [
        { name: 'zones', visible: true, locked: false, opacity: 0.7 },
        { name: 'plants', visible: true, locked: false, opacity: 1 },
        { name: 'annotations', visible: true, locked: false, opacity: 1 },
        { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
      ],
      plantSpeciesColors: {},
      plantSpeciesSymbols: {},
      plantSpeciesCodes: {},
    },
    revealedAnnotationId: null,
    selectionLabelPlantIds: new Set(),
    selectedPlantIds: new Set(),
    selectedZoneIds: new Set(),
    selectedAnnotationIds: new Set(),
    selectedMeasurementGuideIds: new Set(),
    highlightedPlantIds: new Set(),
    highlightedZoneIds: new Set(),
    speciesCache: new Map(),
    localizedCommonNames: new Map(),
    hoveredCanonicalName: null,
    hoverTarget: null,
  }
}

export async function runScenePainterProbe(workerUrl, cycles = 3) {
  maplibregl.setWorkerUrl(workerUrl)
  const container = document.createElement('div')
  container.style.width = '400px'
  container.style.height = '300px'
  container.style.position = 'fixed'
  container.style.left = '0'
  container.style.top = '0'
  document.body.appendChild(container)

  const map = new maplibregl.Map({
    container,
    style: createMapLibreEmptyStyle(),
    center: [0, 49],
    zoom: 16,
    interactive: false,
    trackResize: false,
    attributionControl: false,
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MapLibre style.load timed out')), 15_000)
    map.once('style.load', () => { clearTimeout(timer); resolve() })
    map.once('error', (e) => { clearTimeout(timer); reject(new Error(String(e?.error ?? e))) })
  })

  const canvas = map.getCanvas()
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('WebGL2 context unavailable in probe')

  let contextLostCount = 0
  canvas.addEventListener('webglcontextlost', () => { contextLostCount += 1 })

  const plane = createSessionPlane({ lat: 49, lon: 0 })
  const policy = createNavigationPolicy(49, signal(true))
  const driver = createMapLibreCameraDriver(map, plane, {
    policy: () => policy,
    reducedMotion: signal(true),
  })
  driver.setScreen({ width: 400, height: 300, devicePixelRatio: window.devicePixelRatio || 1 })

  const cycleResults = []
  let resetStateCount = 0
  const origResetState = WebGLRenderer.prototype.resetState
  WebGLRenderer.prototype.resetState = function (...args) {
    resetStateCount += 1
    return origResetState.apply(this, args)
  }
  let triggerRepaintCount = 0
  const origTriggerRepaint = map.triggerRepaint.bind(map)
  map.triggerRepaint = () => {
    triggerRepaintCount += 1
    return origTriggerRepaint()
  }
  try {
    for (let i = 0; i < cycles; i += 1) {
      const resetStart = resetStateCount
      const inner = createPixiScenePainter()
      let paintsThisFrame = 0
      let maxPaintsPerFrame = 0
      let totalPaints = 0
      let totalRenders = 0
      const onRender = () => {
        totalRenders += 1
        if (paintsThisFrame > maxPaintsPerFrame) maxPaintsPerFrame = paintsThisFrame
        paintsThisFrame = 0
      }
      map.on('render', onRender)

      const painter = {
        init: (surface) => inner.init(surface),
        resize: (size) => inner.resize(size),
        paint: (frame) => {
          paintsThisFrame += 1
          totalPaints += 1
          inner.paint(frame)
        },
        setDraft: (draft) => inner.setDraft?.(draft),
        dispose: () => inner.dispose(),
      }

      const layerId = 'probe-scene-' + i
      const host = createSceneHostLayer({
        id: layerId,
        frames: driver.frames,
        painter,
      })

      await host.initialize(map, gl)
      const tickerAfterInit = Ticker.system.started
      map.addLayer(host.layer)

      const view = driver.frames.viewFrame.peek().view
      const wait = host.presentFor(view)
      host.setSnapshot(minimalSnapshot())
      await wait

      // Pan across several frames and verify <= 1 paint per frame.
      const paintsBeforePan = totalPaints
      for (let step = 0; step < 3; step += 1) {
        driver.apply({ kind: 'pan-by', deltaPx: { x: 15, y: -10 } })
        const pannedView = driver.frames.viewFrame.peek().view
        await host.presentFor(pannedView)
      }
      const paintsDuringPan = totalPaints - paintsBeforePan

      // Wait for settledViewFrame (SETTLE_MS = 150ms) to finish, then verify the host requests
      // zero repaints over 3 idle frames (and never paints more than MapLibre renders).
      await new Promise((r) => setTimeout(r, 250))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const triggerRepaintsBeforeIdle = triggerRepaintCount
      const paintsBeforeIdle = totalPaints
      const rendersBeforeIdle = totalRenders
      for (let f = 0; f < 3; f += 1) {
        await new Promise((r) => requestAnimationFrame(r))
      }
      const idleTriggerRepaints = triggerRepaintCount - triggerRepaintsBeforeIdle
      const idlePaints = totalPaints - paintsBeforeIdle
      const idleRenders = totalRenders - rendersBeforeIdle

      map.removeLayer(layerId)
      await host.dispose()
      map.off('render', onRender)

      cycleResults.push({
        cycle: i,
        phaseAfterDispose: host.phase,
        totalPaints,
        paintsDuringPan,
        idleTriggerRepaints,
        idlePaints,
        idleRenders,
        resetStateCalls: resetStateCount - resetStart,
        maxPaintsPerFrame,
        tickerAfterInit,
        tickerAfterDispose: Ticker.system.started,
        contextLost: gl.isContextLost(),
        contextLostCount,
      })
    }
  } finally {
    map.triggerRepaint = origTriggerRepaint
    WebGLRenderer.prototype.resetState = origResetState
    driver.dispose()
    map.remove()
    container.remove()
  }

  return { contextLostCount, cycleResults }
}
`

interface ProbeResult {
  contextLostCount: number
  cycleResults: Array<{
    cycle: number
    phaseAfterDispose: string
    totalPaints: number
    paintsDuringPan: number
    idleTriggerRepaints: number
    idlePaints: number
    idleRenders: number
    resetStateCalls: number
    maxPaintsPerFrame: number
    tickerAfterInit: boolean
    tickerAfterDispose: boolean
    contextLost: boolean
    contextLostCount: number
  }>
}

test('real Pixi ScenePainter survives dispose and remount inside real MapLibre with one present per frame and zero context loss', async ({ page }) => {
  const script = await pageBundle(PROBE_SOURCE, HERE, '__scenePainterProbe')
  const workerSource = readFileSync(MAPLIBRE_WORKER_PATH, 'utf8')
  const sharedSource = readFileSync(MAPLIBRE_SHARED_PATH, 'utf8')
  const origin = `http://localhost:${WEB_PORT}`
  const probeUrl = `${origin}/__scene_painter_probe__.html`
  const workerUrl = `${origin}/__scene_painter_worker__.js`
  const sharedUrl = `${origin}/maplibre-gl-shared.mjs`
  await page.route(probeUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
  await page.route(workerUrl, (route) => route.fulfill({ contentType: 'application/javascript', body: workerSource }))
  await page.route(sharedUrl, (route) => route.fulfill({ contentType: 'application/javascript', body: sharedSource }))
  await page.goto(probeUrl)
  await page.addScriptTag({ content: script })

  const result = await page.evaluate(async (url) => {
    const api = (window as unknown as { __scenePainterProbe: { runScenePainterProbe: (workerUrl: string, n: number) => Promise<ProbeResult> } }).__scenePainterProbe
    return await api.runScenePainterProbe(url, 3)
  }, workerUrl)

  expect(result.contextLostCount).toBe(0)
  expect(result.cycleResults).toHaveLength(3)
  for (const cycle of result.cycleResults) {
    expect(cycle.phaseAfterDispose).toBe('disposed')
    expect(cycle.totalPaints).toBeGreaterThanOrEqual(4)
    expect(cycle.paintsDuringPan).toBeGreaterThanOrEqual(3)
    expect(cycle.idleTriggerRepaints).toBe(0)
    expect(cycle.idlePaints).toBeLessThanOrEqual(cycle.idleRenders)
    expect(cycle.resetStateCalls).toBe(cycle.totalPaints)
    expect(cycle.maxPaintsPerFrame).toBe(1)
    expect(cycle.tickerAfterInit).toBe(false)
    expect(cycle.tickerAfterDispose).toBe(false)
    expect(cycle.contextLost).toBe(false)
    expect(cycle.contextLostCount).toBe(0)
  }
})
