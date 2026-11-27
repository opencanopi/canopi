import { batch, signal } from '@preact/signals'
import type { PrintBounds } from '../../canvas/print'
import type { PrintScaleV10, PrintSetupV10 } from '../../generated/contracts'
import { createSessionPlane } from '../../geo/session-plane'
import { splitPrintArea } from './split-sheets'
import { areaContains, areaFromFrame, layoutAngle, pageFrame } from './page-frame'
import {
  applyPrintEdit,
  defaultPrintSetup,
  inPlane,
  normalisePrintAngle,
  type PrintSetupEdit,
} from './print-setup'
import type {
  PdfHabit,
  PdfPageView,
  PdfInput,
  PdfLabels,
  PdfSetup,
  PreparedPdf,
  PdfPlan,
  PdfLayoutCache,
} from './types'
import { PDF_HABITS, PDF_ZOOM, pdfAreaKey } from './types'
import type { PdfPreparation } from './prepare'
import type { FileDeliveryPort } from '../../platform/file-delivery'
import type { SpeciesDisplayNames } from '../plant-browser/workbench'
interface PdfPrintSetupPersistence {
  read(): PrintSetupV10 | null
  write(setup: PrintSetupV10, coalesceKey: string): void
  endCoalesce(coalesceKey: string): void
}
export interface PdfCapture {
  readonly identity: object
  readonly input: PdfInput
  /** The view is still turning: its live bearing is not the settled one, so `viewBearingDeg` may be an angle a flight only
   *  passes through (a turn jumps, U34, but settles 150 ms later). `isCurrent` turns false once the view settles. */
  readonly turning?: boolean
  isCurrent(): boolean
}
export interface PdfWorkflowDependencies {
  capture(): PdfCapture | null
  /** The catalog's display-name projection: the chosen language's names, English marked for the rest. */
  resolveDisplayNames(names: readonly string[], locale: string): Promise<SpeciesDisplayNames>
  /** Catalog habit (`Tree`, `Shrub`, ...) by canonical name. */
  resolveHabits(names: readonly string[]): Promise<Record<string, string>>
  prepare(input: PdfPreparation, signal: AbortSignal, progress?: (plan: PdfPlan) => void): Promise<PreparedPdf>
  readonly delivery: FileDeliveryPort
  labels(): PdfLabels
  namePrintArea(number: number): string
  /** Optional Document `print_setup` persistence through Design Edit (`2.1-Q152`, `2.1-M90`, `2.1-M160`). */
  readonly printSetup?: PdfPrintSetupPersistence
}
export interface PdfWorkflowState {
  readonly status: 'idle' | 'preparing' | 'ready' | 'error' | 'delivering' | 'saved' | 'downloaded'
  readonly error: string | null
  readonly result: PreparedPdf | null
}
const IDLE: PdfWorkflowState = { status: 'idle', error: null, result: null }
const EXPORTABLE = new Set(['plants', 'zones', 'annotations', 'measurement-guides'])
export function createPdfWorkflow(deps: PdfWorkflowDependencies) {
  const open = signal(false)
  const state = signal<PdfWorkflowState>(IDLE)
  const defaults = (): PdfSetup => ({ paper: 'A4', layers: [] })
  const setup = signal<PdfSetup>(defaults())
  const splitPreview = signal<PdfSetup | null>(null)
  const availableLayers = signal<readonly string[]>([])
  const viewBearingDeg = signal(0)
  const savedViews = signal<readonly NonNullable<PdfInput['savedViews']>[number][]>([])
  let cache: PdfLayoutCache = {}
  let priority = 'overview'
  let nextAreaId = 0
  let nextSplitId = 0
  let sessionCount = 0
  let sessionCoalesceKey = 'pdf-setup:0'
  let persistedSetup: PrintSetupV10 | null = null
  let identity: object | null = null
  let capture: PdfCapture | null = null
  // As on screen lays pages out at the bearing the view rests at when the workspace opens, held until it closes:
  // a flight still turning then (a saved view or story step) is waited for, and any later turn never moves the pages.
  let heldBearing: number | null = null
  let controller: AbortController | null = null
  let generation = 0
  let disposed = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  function stop() { generation++; controller?.abort(); controller = null; clearTimeout(refreshTimer); refreshTimer = undefined }
  function endSessionCoalesce() {
    deps.printSetup?.endCoalesce(sessionCoalesceKey)
  }
  function commitPersisted(edit: PrintSetupEdit) {
    if (!deps.printSetup) return
    const origin = capture?.input.canvas.planeOrigin
    if (!origin) return
    const plane = createSessionPlane(origin)
    const base = persistedSetup ?? deps.printSetup.read() ?? defaultPrintSetup(setup.peek().layers)
    const next = applyPrintEdit(base, edit, plane)
    persistedSetup = next
    deps.printSetup.write(next, sessionCoalesceKey)
  }
  function refreshSoon() {
    stop(); capture = null
    state.value = { status: 'preparing', error: null, result: null }
    // Leave the reactive observer before capturing; rapid revisions share one job.
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void rebuild() }, 100)
  }
  function synchronize(nextIdentity: object) {
    if (disposed) return
    if (identity !== null && identity !== nextIdentity) {
      endSessionCoalesce()
      stop(); cache = {}; splitPreview.value = null; identity = null; capture = null; heldBearing = null; nextAreaId = 0; nextSplitId = 0; persistedSetup = null
      batch(() => { open.value = false; state.value = IDLE; setup.value = defaults(); availableLayers.value = []; viewBearingDeg.value = 0; savedViews.value = [] })
    } else if (open.peek() && ((capture && !capture.isCurrent()) || state.peek().error === 'canvas-busy')) {
      refreshSoon()
    }
  }
  function syncStoredSetup(stored: PrintSetupV10 | null, captured: PdfCapture, defaultLayers: string[]): void {
    if (stored && captured.input.canvas.planeOrigin) {
      persistedSetup = stored
      const projected = inPlane(stored, createSessionPlane(captured.input.canvas.planeOrigin), defaultLayers)
      const numericIds = (projected.areas ?? []).map((a) => Number(a.id)).filter(Number.isFinite)
      nextAreaId = numericIds.length ? Math.max(...numericIds) : 0
      nextSplitId = (stored.splits ?? []).length
      setup.value = projected
    } else {
      persistedSetup = null
      nextAreaId = 0
      nextSplitId = 0
      setup.value = { paper: 'A4', layers: defaultLayers }
    }
  }
  async function rebuild(): Promise<void> {
    if (disposed || !open.peek() || state.peek().status === 'delivering') return
    stop()
    let next: PdfCapture | null
    try { next = deps.capture() } catch {
      state.value = { status: 'error', error: 'prepare-failed', result: null }; return
    }
    if (!next) { state.value = { status: 'error', error: 'canvas-busy', result: null }; return }
    const defaultLayers = next.input.canvas.layers.filter((l) => EXPORTABLE.has(l.name) && l.visible && l.opacity > 0).map((l) => l.name)
    const stored = deps.printSetup?.read() ?? null
    if (identity !== next.identity) {
      identity = next.identity
      heldBearing = null
      syncStoredSetup(stored, next, defaultLayers)
    } else if (deps.printSetup && stored !== persistedSetup) {
      syncStoredSetup(stored, next, defaultLayers)
    }
    availableLayers.value = next.input.canvas.layers.filter((layer) => EXPORTABLE.has(layer.name) && layer.opacity > 0).map((layer) => layer.name)
    savedViews.value = next.input.savedViews ?? []
    if (heldBearing === null && next.turning) {
      capture = next; state.value = { status: 'preparing', error: null, result: null }; return
    }
    heldBearing ??= next.input.viewBearingDeg
    viewBearingDeg.value = normalisePrintAngle(heldBearing)
    next = { ...next, input: { ...next.input, viewBearingDeg: heldBearing } }
    capture = next
    if (setup.peek().layers.some((name) => !availableLayers.peek().includes(name))) {
      state.value = { status: 'error', error: 'selection-missing', result: null }; return
    }
    const abort = new AbortController(); controller = abort
    const ticket = generation
    const previous = state.peek().result
    state.value = { status: 'preparing', error: null, result: previous ? { ...previous, bytes: null } : null }
    const current = () => {
      if (disposed || !open.peek() || ticket !== generation || abort.signal.aborted) return false
      if (next.isCurrent()) return true
      refreshSoon()
      return false
    }
    try {
      const choices = splitPreview.peek() ?? setup.peek()
      const progress = (plan: PdfPlan) => { if (current()) state.value = { status: 'preparing', error: null, result: { plan, bytes: null } } }
      if (choices.areas?.length && !previous) {
        const overview = await deps.prepare({ input: next.input, setup: { ...choices, areas: [] }, labels: deps.labels() }, abort.signal)
        if (!current()) return
        progress(overview.plan)
      }
      const defaultAngle = layoutAngle(choices, next.input)
      const names = choices.areas?.length && choices.layers.includes('plants')
        ? Array.from(new Set(next.input.canvas.plants.filter(plant => choices.areas!.some(area => {
          const areaFrame = pageFrame(area.angleDeg ?? defaultAngle)
          // A manually displaced/zoomed view can include plants outside its original rectangle.
          return choices.views?.[pdfAreaKey(area)] || area.wholeDesign ? true : areaContains(areaFrame, area.bounds, plant.position, area.pivot)
        })).map(plant => plant.canonicalName))) : []
      // Catalog failure retains full canonical identities on chosen detail sheets.
      const identities = names.length ? await resolvePrintIdentities(deps, names, next.input.locale, abort.signal) : { commonNames: {} }
      if (!current()) return
      const result = await deps.prepare({ input: { ...next.input, ...identities }, setup: choices, labels: deps.labels(),
        cache, priority }, abort.signal, progress)
      if (!current()) return
      cache = result.layoutCache ?? {}
      state.value = { status: 'ready', error: null, result }
    } catch (error) {
      if (!current()) return
      const message = error instanceof Error ? error.message : ''
      state.value = { status: 'error', error: ['unsupported-text', 'text-too-wide', 'prepare-timeout', 'coverage-too-large'].includes(message) ? message : 'prepare-failed', result: null }
    } finally {
      if (controller === abort) controller = null
    }
  }
  function show(): void {
    if (disposed) return
    sessionCoalesceKey = `pdf-setup:${++sessionCount}`
    open.value = true
    void rebuild()
  }
  function close(): void {
    if (state.peek().status === 'delivering') return
    endSessionCoalesce()
    stop(); cache = {}; splitPreview.value = null; capture = null; heldBearing = null; batch(() => { open.value = false; state.value = IDLE; availableLayers.value = [] })
  }
  function configure(value: Partial<PdfSetup>, persist = true): void {
    if (disposed || state.peek().status === 'delivering') return
    splitPreview.value = null
    setup.value = { ...setup.peek(), ...value }
    if (persist) {
      if (value.paper !== undefined) commitPersisted({ kind: 'set-paper', paper: value.paper })
      if (value.layers !== undefined) commitPersisted({ kind: 'set-layers', layers: value.layers })
      if (value.plantColors !== undefined) commitPersisted({ kind: 'set-plant-colors', plantColors: value.plantColors })
      if (value.northArrow !== undefined) commitPersisted({ kind: 'set-north-arrow', northArrow: value.northArrow })
    }
    void rebuild()
  }
  function selectLayer(name: string, selected: boolean): void {
    const layers = setup.peek().layers.filter((layer) => layer !== name)
    configure({ layers: selected ? [...layers, name] : layers })
  }
  /** `bounds` is the area in plan metres: an unturned box about its centre (`PdfPrintArea`). */
  function addPrintArea(bounds: PrintBounds): string | undefined { return addArea(bounds, false) }
  function addArea(bounds: PrintBounds, wholeDesign: boolean): string | undefined {
    if (!open.peek() || disposed || state.peek().status === 'delivering') return
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return
    const number = ++nextAreaId
    const id = String(number)
    const name = deps.namePrintArea(number)
    const angleDeg = state.peek().result?.plan.angleDeg ?? 0
    priority = `area:${number}`
    configure({ areas: [...setup.peek().areas ?? [], { id, name, bounds: { ...bounds }, angleDeg,
      ...wholeDesign ? { wholeDesign } : {} }] }, false)
    commitPersisted(wholeDesign
      ? { kind: 'add-whole-design', id, name, fallbackBounds: bounds, angleDeg }
      : { kind: 'add-box', id, name, bounds, angleDeg })
    return `area:${number}`
  }
  function addWholeDesign(): string | undefined {
    const plan = state.peek().result?.plan
    return plan?.pickerPage ? addArea(areaFromFrame(pageFrame(plan.pickerPage.angleDeg ?? plan.angleDeg), plan.pickerPage.ground), true) : undefined
  }
  let pendingSplit: { parentPageId: string; splitId: string; pivot: { x: number; y: number }; angleDeg: number; parts: { id: string; name: string; bounds: PrintBounds }[] } | null = null
  function previewSplit(id: string): void {
    const plan = state.peek().result?.plan, page = plan?.pages.find(p => p.id === id && p.kind === 'detail')
    if (!page || !capture?.isCurrent() || !['ready', 'saved', 'downloaded', 'error'].includes(state.peek().status)) return
    const parent = setup.peek().areas?.find(area => pdfAreaKey(area) === id)
    const angleDeg = page.angleDeg ?? plan!.angleDeg
    const splitId = parent?.splitId ?? `split-${++nextSplitId}`
    const parts = splitPrintArea(page.ground, setup.peek().layers.includes('plants') ? capture.input.canvas.plants : [], pageFrame(angleDeg), parent?.pivot, splitId)
    const areas = parts.map((part, index) => ({ id: String(nextAreaId + index + 1), name: deps.namePrintArea(nextAreaId + index + 1), ...part }))
    const parentScale = setup.peek().views?.[id]?.scale
    const views: Record<string, PdfPageView> = Object.fromEntries(Object.entries(setup.peek().views ?? {}).filter(([key]) => key !== id && !key.startsWith(`${id}:legend:`)))
    if (parentScale) {
      for (const area of areas) views[pdfAreaKey(area)] = { scale: parentScale }
    }
    pendingSplit = {
      parentPageId: id,
      splitId,
      pivot: parts[0]!.pivot,
      angleDeg,
      parts: areas.map((a) => ({ id: a.id, name: a.name, bounds: a.bounds })),
    }
    splitPreview.value = { ...setup.peek(), areas: setup.peek().areas?.flatMap(a => pdfAreaKey(a) === id ? areas : [a]), views }
    priority = pdfAreaKey(areas[0]!)
    void rebuild()
  }
  function applySplit(): void {
    const preview = splitPreview.peek()
    if (!preview || state.peek().status !== 'ready' || !capture?.isCurrent()) return
    nextAreaId = Math.max(nextAreaId, ...preview.areas!.map(a => Number(a.id)))
    const applied = pendingSplit
    pendingSplit = null
    batch(() => { setup.value = preview; splitPreview.value = null })
    if (applied) {
      commitPersisted({ kind: 'apply-split', ...applied })
    }
  }
  function cancelSplit(): void { if (!splitPreview.peek()) return; pendingSplit = null; splitPreview.value = null; void rebuild() }
  function prioritize(id: string): void { priority = id.split(':legend:')[0]! }
  function removeArea(key: string): void {
    const views = Object.fromEntries(Object.entries(setup.peek().views ?? {}).filter(([id]) => id !== key && !id.startsWith(`${key}:legend:`)))
    configure({ areas: (setup.peek().areas ?? []).filter((area) => pdfAreaKey(area) !== key), views }, false)
    commitPersisted({ kind: 'remove-page', pageId: key })
  }
  function setPageAngle(id: string, angleDeg: number): void {
    if (disposed || state.peek().status === 'delivering' || !Number.isFinite(angleDeg)) return
    const angle = normalisePrintAngle(angleDeg)
    if (id === 'overview') {
      const views = setup.peek().views ?? {}
      if ((views.overview?.angleDeg ?? 0) === angle) return
      configure({ views: { ...views, overview: { ...views.overview, angleDeg: angle } } }, false)
      commitPersisted({ kind: 'set-page-angle', pageId: 'overview', angleDeg: angle })
      return
    }
    const areas = setup.peek().areas ?? []
    const target = areas.find((a) => pdfAreaKey(a) === id)
    if (!target) return
    const nextAreas = target.splitId
      ? areas.map((a) => (a.splitId === target.splitId ? { ...a, angleDeg: angle } : a))
      : areas.map((a) => (pdfAreaKey(a) === id ? { ...a, angleDeg: angle } : a))
    configure({ areas: nextAreas }, false)
    commitPersisted({ kind: 'set-page-angle', pageId: id, angleDeg: angle })
  }
  function setPageScale(id: string, scale: PrintScaleV10): void {
    if (disposed || state.peek().status === 'delivering') return
    const views = setup.peek().views ?? {}
    configure({ views: { ...views, [id]: { ...views[id], scale, zoom: 100 } } }, false)
    commitPersisted({ kind: 'set-page-scale', pageId: id, scale })
  }
  function setPageView(id: string, value: PdfPageView): void {
    if (value.zoom !== undefined && (!Number.isFinite(value.zoom) || value.zoom < PDF_ZOOM.min || value.zoom > PDF_ZOOM.max)) return
    if (value.orientation !== undefined && !['auto', 'portrait', 'landscape'].includes(value.orientation)) return
    if (value.offset && ![value.offset.x, value.offset.y].every(Number.isFinite)) return
    const views = setup.peek().views ?? {}
    if ((value.zoom === undefined || value.zoom === (views[id]?.zoom ?? 100))
      && value.scale === undefined
      && value.angleDeg === undefined
      && (value.orientation === undefined || value.orientation === (views[id]?.orientation ?? 'auto'))
      && (!value.offset || (value.offset.x === (views[id]?.offset?.x ?? 0) && value.offset.y === (views[id]?.offset?.y ?? 0)))) return
    configure({ views: { ...views, [id]: { ...views[id], ...value, ...(value.offset ? { offset: { ...value.offset } } : {}) } } }, false)
    if (value.scale !== undefined) commitPersisted({ kind: 'set-page-scale', pageId: id, scale: value.scale })
    if (value.orientation !== undefined || value.offset !== undefined) {
      commitPersisted({
        kind: 'set-page-framing',
        pageId: id,
        ...(value.orientation !== undefined ? { orientation: value.orientation } : {}),
        ...(value.offset !== undefined ? { offset: value.offset } : {}),
      })
    }
  }
  function fitPage(id: string): void { setPageView(id, { scale: { kind: 'fit' }, zoom: 100, offset: { x: 0, y: 0 } }) }
  async function save(): Promise<void> {
    if (splitPreview.peek()) return
    const snapshot = state.peek(), source = capture
    if (!source || !source.isCurrent() || !['ready', 'saved', 'downloaded', 'error'].includes(snapshot.status) || !snapshot.result?.bytes || snapshot.result.plan.blocked) return
    const abort = new AbortController(); controller = abort
    const ticket = ++generation
    state.value = { ...snapshot, status: 'delivering', error: null }
    try {
      const outcome = await deps.delivery.deliverFile('pdf', source.input.name, { bytes: snapshot.result.bytes }, abort.signal)
      if (disposed || ticket !== generation || !source.isCurrent()) return
      if (outcome === 'refused') {
        state.value = { ...snapshot, status: 'error', error: 'delivery-refused' }
        return
      }
      state.value = { ...snapshot, status: outcome === 'cancelled' ? 'ready' : outcome, error: null }
    } catch {
      if (disposed || ticket !== generation || !source.isCurrent()) return
      state.value = { ...snapshot, status: 'error', error: 'delivery-failed' }
    } finally { if (controller === abort) controller = null }
  }
  function dispose(): void { if (disposed) return; disposed = true; endSessionCoalesce(); stop(); cache = {}; splitPreview.value = null; deps.delivery.dispose?.(); open.value = false; state.value = IDLE; capture = null; heldBearing = null; persistedSetup = null; setup.value = defaults(); availableLayers.value = []; viewBearingDeg.value = 0; savedViews.value = [] }
  return { open, state, setup, splitPreview, availableLayers, viewBearingDeg, savedViews, prioritize, addWholeDesign, previewSplit, applySplit, cancelSplit, show, close, rebuild, configure, selectLayer, addPrintArea, removeArea, setPageAngle, setPageScale, setPageView, fitPage, save, synchronize, dispose }
}
export type PdfWorkflow = ReturnType<typeof createPdfWorkflow>

// The catalog reader is shared with the app. Stop waiting without disposing it;
// a late answer must not keep an export job or its captured Design alive.
type PrintIdentities = Pick<PdfInput, 'commonNames' | 'englishFallbacks' | 'habits'>
/**
 * Names in the chosen language, English for the rest (marked as fallbacks), and catalog habits.
 * One deadline bounds every lookup; a failed or late lookup contributes nothing.
 */
const NO_DISPLAY_NAMES: SpeciesDisplayNames = { names: {}, englishFallbacks: [] }
async function resolvePrintIdentities(deps: PdfWorkflowDependencies, names: readonly string[], locale: string, signal: AbortSignal): Promise<PrintIdentities> {
  let timer: ReturnType<typeof setTimeout> | undefined, onAbort = () => {}
  const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, 30_000) })
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  const bounded = <T>(lookup: () => Promise<T>, fallback: T) =>
    Promise.race([(async () => { try { return await lookup() } catch { return fallback } })(), expired.then(() => fallback), aborted])
  try {
    const [display, catalogHabits] = await Promise.all([
      bounded(() => deps.resolveDisplayNames(names, locale), NO_DISPLAY_NAMES),
      bounded(() => deps.resolveHabits(names), {} as Record<string, string>),
    ])
    const habits: Record<string, PdfHabit> = {}
    for (const [name, habit] of Object.entries(catalogHabits)) {
      const key = habit.trim().toLowerCase() as PdfHabit
      if (PDF_HABITS.includes(key)) habits[name] = key
    }
    return { commonNames: { ...display.names },
      ...display.englishFallbacks.length ? { englishFallbacks: [...display.englishFallbacks] } : {}, ...Object.keys(habits).length ? { habits } : {} }
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort)
  }
}
