import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { findInPdfKey, pdfKeyLocations, type PdfKeyLocation } from '../../app/canvas-pdf/key-finder'
import { canvasPdf } from '../../app/canvas-pdf/live'
import { isFindPlantsShortcut } from '../../app/plant-finder/focus'
import type { PdfWorkflow } from '../../app/canvas-pdf/workflow'
import { PDF_MAP_ORIENTATIONS, PDF_PLANT_COLORS, type PdfMapOrientation, type PdfPlan, type PdfPaper } from '../../app/canvas-pdf/types'
import { t } from '../../i18n'
import { Dropdown } from '../shared/Dropdown'
import { useModalLayer } from '../shared/useModalLayer'
import { PdfKeyFinder } from './PdfKeyFinder'
import { PdfPageEditor } from './PdfPageEditor'
import { PdfPageRail } from './PdfPageRail'
import { PdfPageToolbar } from './PdfPageToolbar'
import styles from './canvas-pdf.module.css'

export function CanvasPdfDialog({ workflow = canvasPdf }: { readonly workflow?: PdfWorkflow }) {
  if (!workflow.open.value) return null
  return <PrintWorkspace workflow={workflow} />
}
function PrintWorkspace({ workflow }: { readonly workflow: PdfWorkflow }) {
  const root = useRef<HTMLElement>(null)
  const [pageId, setPageId] = useState('overview')
  const lastPlan = useRef<PdfPlan | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [hoveredPage, setHoveredPage] = useState<string | null>(null)
  const returnPage = useRef('overview')
  const focusPage = useRef<string | null>(null)
  const splitPreview = workflow.splitPreview.value
  const state = workflow.state.value, setup = splitPreview ?? workflow.setup.value
  if (state.result) lastPlan.current = state.result.plan
  const plan = state.result?.plan ?? (state.status === 'preparing' ? lastPlan.current : undefined)
  const delivering = state.status === 'delivering', preparing = state.status === 'preparing'
  const page = adding ? plan?.pickerPage ?? plan?.pages[0] : plan?.pages.find((page) => page.id === pageId)
    ?? (!preparing ? plan?.pages.find((page) => page.id === pageId.split(':legend:')[0]) ?? plan?.pages[0] : undefined)
  const disabled = delivering || preparing
  const [keyQuery, setKeyQuery] = useState('')
  // The entry last shown from Find in key, by page and species so a rebuilt plan keeps it.
  const [keyTarget, setKeyTarget] = useState<{ pageId: string; canonicalName: string } | null>(null)
  const keyLocations = useMemo(() => pdfKeyLocations(plan), [plan])
  const keySearch = useMemo(() => findInPdfKey(keyLocations, keyQuery), [keyLocations, keyQuery])
  const keyCurrent = keyTarget && keySearch.active
    ? keyLocations.find((location) => location.pageId === keyTarget.pageId && location.entry.canonicalName === keyTarget.canonicalName) ?? null
    : null
  const keyMatchesOnPage = page && !adding
    ? keySearch.results.filter((result) => result.location.pageId === page.id).map((result) => result.location.bounds)
    : []
  useModalLayer()
  // Focus goes in as the dialog commits, with its modal layer, so an Esc at once is the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])
  // After paint on purpose (focus-only-in-layout-effect entry): the page editor takes focus once a page added or chosen has rendered.
  useEffect(() => {
    if (page && focusPage.current === page.id && !preparing) {
      root.current?.querySelector<SVGSVGElement>('[data-pdf-editor]')?.focus(); focusPage.current = null
    }
  }, [page, preparing])
  useEffect(() => {
    if (page && !adding && !preparing && page.id !== pageId) setPageId(page.id)
  }, [page, adding, preparing, pageId])
  function selectPage(id: string) { workflow.prioritize(id); setPageId(id); setAdding(false); setInspecting(false) }
  function beginAdd() { focusPage.current = 'overview'; returnPage.current = pageId; setAdding(true); setInspecting(false); setPageId('overview') }
  function openCreatedPage(id: string) { focusPage.current = id; selectPage(id) }
  function cancelAdd() { focusPage.current = returnPage.current; setAdding(false); setPageId(returnPage.current) }
  function showKeyEntry(location: PdfKeyLocation) { setKeyTarget({ pageId: location.pageId, canonicalName: location.entry.canonicalName }); selectPage(location.pageId) }
  function keyDown(event: KeyboardEvent) {
    event.stopPropagation()
    // Ctrl F finds in the key while the export screen is open.
    const keyField = root.current?.querySelector<HTMLInputElement>('[data-pdf-key-finder] input')
    if (keyField && isFindPlantsShortcut(event)) {
      event.preventDefault()
      keyField.focus()
      keyField.select()
      return
    }
    if (event.key === 'Escape') {
      if (root.current?.querySelector('[aria-expanded="true"]')) return
      event.preventDefault()
      if (splitPreview) { workflow.cancelSplit(); selectPage('overview') }
      else if (adding) cancelAdd()
      else if (inspecting) setInspecting(false)
      else workflow.close()
    }
    if (event.key === 'Tab') {
      const items = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }
  return <div className={styles.overlay}>
    <section ref={root} role="dialog" aria-modal="true" aria-labelledby="canvas-pdf-title" className={styles.workspace}
      data-preserve-overlays="true" onKeyDown={keyDown}>
      <div className={styles.body}>
        <aside className={styles.sheet} aria-labelledby="canvas-pdf-title">
          <div className={styles.sheetScroll}>
            <header className={styles.sheetHeader}>
              <button type="button" disabled={delivering} onClick={() => workflow.close()}>← {t('pdf.backToDesign')}</button>
              <h2 id="canvas-pdf-title">{t('pdf.title')}</h2>
            </header>
            <div className={styles.options}>
              <fieldset disabled={delivering || !!splitPreview} className={styles.option}>
                <span className={styles.optionLabel}>{t('pdf.paper')}</span>
                <Dropdown<PdfPaper> ariaLabel={t('pdf.paper')} trigger={setup.paper} value={setup.paper}
                  items={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'US Letter' }]}
                  onChange={(paper) => workflow.configure({ paper })} preserveOverlays />
              </fieldset>
              <fieldset className={styles.segmented} disabled={delivering || !!splitPreview}>
                <legend className={styles.optionLabel}>{t('pdf.plantColors')}</legend>
                <div role="radiogroup" aria-label={t('pdf.plantColors')}>
                  {PDF_PLANT_COLORS.map((mode) => <label key={mode}>
                    <input type="radio" name="pdf-plant-colors" value={mode} checked={(setup.plantColors ?? 'design') === mode}
                      onChange={() => workflow.configure({ plantColors: mode })} />
                    <span>{t(`pdf.plantColorModes.${mode}`)}</span>
                  </label>)}
                </div>
              </fieldset>
              <fieldset className={styles.segmented} disabled={delivering || !!splitPreview}>
                <legend className={styles.optionLabel}>{t('pdf.mapOrientation')}</legend>
                <div role="radiogroup" aria-label={t('pdf.mapOrientation')}>
                  {PDF_MAP_ORIENTATIONS.map((orientation) => <label key={orientation}>
                    <input type="radio" name="pdf-map-orientation" value={orientation} checked={(setup.mapOrientation ?? 'north-up') === orientation}
                      onChange={() => workflow.configure({ mapOrientation: orientation })} />
                    <span>{t(MAP_ORIENTATION_LABELS[orientation])}</span>
                  </label>)}
                </div>
              </fieldset>
              <fieldset className={styles.include} disabled={delivering || !!splitPreview}>
                <legend className={styles.optionLabel}>{t('pdf.include')}</legend>
                {Array.from(new Set([...workflow.availableLayers.value, ...setup.layers])).map((name) => <label key={name} className={styles.check}>
                  <input type="checkbox" checked={setup.layers.includes(name)} onChange={(event) => workflow.selectLayer(name, event.currentTarget.checked)} />
                  <span>{t(`canvas.layers.${name}`, { defaultValue: name })}</span>
                </label>)}
                <label className={styles.check}>
                  <input type="checkbox" role="switch" checked={setup.northArrow !== false}
                    onChange={(event) => workflow.configure({ northArrow: event.currentTarget.checked })} />
                  <span>{t('pdf.northArrow')}</span>
                </label>
              </fieldset>
            </div>
            {splitPreview ? <section className={styles.pageOptions} aria-label={t('pdf.splitSheets')}>
              <p role="status" className={styles.sheetStatus}>{preparing ? t('pdf.preparing') : t('pdf.splitPreview', { count: plan?.pages.length ?? 0 })}</p>
              <div className={styles.sheetActions}>
                <button type="button" className={styles.primary} disabled={disabled || !!state.error} onClick={() => workflow.applySplit()}>{t('pdf.applySheets')}</button>
                <button type="button" onClick={() => { workflow.cancelSplit(); selectPage('overview') }}>{t('pdf.cancel')}</button>
              </div>
            </section>
              : page && !adding && <PdfPageToolbar key={page.id} page={page} workflow={workflow} disabled={delivering} inspecting={inspecting}
                onSplit={disabled ? undefined : () => { workflow.previewSplit(page.id); selectPage('overview') }} onInspect={() => setInspecting(!inspecting)} />}
            {keyLocations.length > 0 && !splitPreview && <PdfKeyFinder query={keyQuery} search={keySearch} current={keyCurrent}
              sheetName={(location) => plan?.pages.find((source) => source.id === location.sourceId)?.areaName ?? t('pdf.overview')}
              onQuery={setKeyQuery} onShow={showKeyEntry} />}
            <div className={styles.sheetPages}>
              {adding ? <button type="button" onClick={cancelAdd}>← {t('pdf.cancel')}</button>
                : <button type="button" className={styles.addPage} aria-label={t('pdf.addPage')} disabled={disabled || !!splitPreview || !plan?.pages.length}
                  onClick={beginAdd}>+ {t('pdf.addPage')}</button>}
              {adding && <button type="button" disabled={disabled} onClick={() => { const id = workflow.addWholeDesign(); if (id) openCreatedPage(id) }}>{t('pdf.wholeDesign')}</button>}
              <PdfPageRail plan={plan} setup={setup} selected={pageId} disabled={delivering || !!splitPreview} onSelect={selectPage}
                onHover={setHoveredPage} onRemove={(id) => { workflow.removeArea(id); if (pageId === id || page?.sourceId === id) selectPage('overview') }} />
            </div>
          </div>
          <button type="button" aria-label={t('pdf.export')} className={`${styles.primary} ${styles.save}`}
            disabled={preparing || delivering || !!splitPreview || !!plan?.blocked || !state.result?.bytes} onClick={() => void workflow.save()}>
            {t('pdf.export')} <span aria-hidden="true" className={styles.exportCount}>{plan?.pages.length ?? '·'}</span>
          </button>
        </aside>
        <main className={styles.preview}>
          <div className={styles.previewHeading}>
            <strong>{adding ? t('pdf.addPage') : page?.areaName ?? (page?.kind === 'legend' ? (plan?.pages.find((source) => source.id === page.sourceId)?.detailNumber ?? t('pdf.overview')) + ' · ' + t(page.sourceId === 'overview' ? 'pdf.measurementSummary' : 'pdf.keyAndNotes') : t('pdf.overview'))}</strong>
            <span role="status">{preparing ? t('pdf.preparing') : page ? t('pdf.pageCount', { page: page.number, count: plan!.pages.length }) : ''}</span>
          </div>
          <p id="pdf-editor-hint" className={styles.editorHint}>{t(splitPreview ? 'pdf.splitHint' : adding ? 'pdf.addHint' : inspecting || page?.kind === 'legend' ? 'pdf.inspectHint' : page?.kind === 'overview' && (setup.areas?.length ?? 0) > 0 ? 'pdf.overviewHint' : 'pdf.frameHint')}</p>
          <div className={styles.paper} aria-busy={preparing}>
            {page && plan && <PdfPageEditor page={page} plan={plan} adding={adding} inspecting={inspecting} navigationOnly={!!splitPreview} disabled={disabled}
              highlightedPage={hoveredPage} onPage={selectPage}
              keyMatches={keyMatchesOnPage} keyCurrent={keyCurrent?.pageId === page.id ? keyCurrent.bounds : null}
              onPrintArea={(bounds) => { const id = workflow.addPrintArea(bounds); if (id) openCreatedPage(id) }}
              onMove={(delta) => {
                const offset = setup.views?.[page.id]?.offset ?? { x: 0, y: 0 }
                workflow.setPageView(page.id, { offset: { x: offset.x + delta.x, y: offset.y + delta.y } })
              }} />}
          </div>
          {state.error && <div role="alert" className={styles.notice}><span>{t(`pdf.errors.${state.error}`)}</span>
            {state.error !== 'selection-missing' && <button type="button" disabled={delivering} onClick={() => void (state.error === 'delivery-failed' ? workflow.save() : workflow.rebuild())}>{t('pdf.retry')}</button>}</div>}
          {plan?.blocked === 'empty' && <p role="status" className={styles.notice}>{t('pdf.empty')}</p>}
        </main>
      </div>
      <footer className={styles.footer}>
        <span>{t('pdf.actualSize')}</span>
        <span role="status">{state.status === 'saved' ? t('pdf.saved') : state.status === 'downloaded' ? t('pdf.downloaded') : ''}</span>
      </footer>
    </section>
  </div>
}

const MAP_ORIENTATION_LABELS: Readonly<Record<PdfMapOrientation, string>> = {
  'north-up': 'pdf.mapOrientationNorthUp',
  'as-on-screen': 'pdf.mapOrientationAsOnScreen',
}
