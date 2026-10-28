import { effect } from '@preact/signals'
import { createPdfDelivery } from '#canvas-pdf-platform'
import { currentCanvasQuerySurface } from '../../canvas/session'
import { designSessionStore } from '../document-session/store'
import { speciesCatalogWorkbench } from '../plant-browser'
import { locale } from '../settings/state'
import { t } from '../../i18n'
import { PLANT_SYMBOL_IDS } from '../../generated/known-canopi-keys'
import { createPdfWorkflow } from './workflow'
import { pdfFontUrls } from './font-urls'

export function canExportCanvasPdf(): boolean {
  return designSessionStore.currentDesign.value !== null && currentCanvasQuerySurface.value !== null
}
export const canvasPdf = createPdfWorkflow({
  capture() {
    const query = currentCanvasQuerySurface.value
    if (!query || !designSessionStore.currentDesign.value) return null
    const identity = designSessionStore.sessionIdentity.value
    const revision = query.revision.scene.value
    const language = locale.value
    const name = designSessionStore.designName.value
    const canvas = query.capturePrintSnapshot()
    if (!canvas) return null
    // Exact, not the rounded bearing signal: As on screen levels guides drawn level on the turned map. Read on every
    // capture; the workflow holds the first one read while the view is not turning, until the workspace closes.
    const viewBearingDeg = query.view.captureView().camera.bearingDeg
    const settled = query.view.settledCamera.value
    const turning = normalise(viewBearingDeg) !== normalise(settled.bearingDeg)
    return { identity, input: { name, locale: language, canvas, commonNames: {}, viewBearingDeg }, ...(turning ? { turning } : {}),
      isCurrent: () => designSessionStore.sessionIdentity.value === identity && currentCanvasQuerySurface.value === query
        && query.revision.scene.value === revision && locale.value === language && designSessionStore.designName.value === name
        && query.getSettledPlacedPlants() !== null && (!turning || query.view.settledCamera.value === settled) }
  },
  // The catalog's batch projections: the same names and habits every plant list shows, in both editions.
  resolveDisplayNames: (names, language) => speciesCatalogWorkbench.resolveDisplayNames(names, language),
  resolveHabits: (names) => speciesCatalogWorkbench.resolveHabits(names),
  prepare: async (input, signal, progress) => (await import('./job')).preparePdfJob(input, pdfFontUrls(), signal, progress),
  delivery: createPdfDelivery(),
  labels: () => ({ notes: t('pdf.notes'), observations: t('pdf.observations'), keyAndNotes: t('pdf.keyAndNotes'), overview: t('pdf.overview'), plants: t('pdf.plants'), actualSize: t('pdf.actualSize'),
    detail: t('pdf.detail'), measurementSummary: t('pdf.measurementSummary'), zone: t('pdf.zone'), longSide: t('pdf.longSide'), width: t('pdf.width'), guides: t('pdf.guides'),
    metres: t('pdf.metres'), diameters: t('pdf.diameters'), outerSides: t('pdf.outerSides'), quantity: t('pdf.quantity'), species: t('pdf.species'), plantKey: t('pdf.plantKey'),
    habitTree: t('pdf.habitTree'), habitShrub: t('pdf.habitShrub'), habitHerbaceous: t('pdf.habitHerbaceous'), habitClimber: t('pdf.habitClimber'),
    habitOther: t('pdf.habitOther'), continued: t('pdf.continued'), englishFallback: t('pdf.englishFallback', { mark: t('speciesName.englishMark') }), englishMark: t('speciesName.englishMark'), symbols: t('pdf.symbols'), north: t('pdf.north'),
    symbolNames: symbolNames() }),
  namePrintArea: (number) => t('pdf.areaName', { number }),
})
const disposeObservation = effect(() => {
  const identity = designSessionStore.sessionIdentity.value
  if (canvasPdf.open.value) {
    const query = currentCanvasQuerySurface.value
    void query?.revision.scene.value
    void query?.getSettledPlacedPlants()
    void query?.view.settledCamera.value
    void locale.value
    void designSessionStore.designName.value
  }
  canvasPdf.synchronize(identity)
})
const normalise = (deg: number) => ((deg % 360) + 360) % 360
function symbolNames(): Record<string, string> {
  return Object.fromEntries(PLANT_SYMBOL_IDS.map(symbol => [symbol, t(`canvas.plantSymbol.names.${symbol}`)]))
}
if (import.meta.hot) import.meta.hot.dispose(() => { disposeObservation(); canvasPdf.dispose() })
