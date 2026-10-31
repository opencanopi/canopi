import { useEffect, useState } from 'preact/hooks'
import { PDF_ZOOM, type PdfPage } from '../../app/canvas-pdf/types'
import type { PdfWorkflow } from '../../app/canvas-pdf/workflow'
import { t } from '../../i18n'
import styles from './canvas-pdf.module.css'

export function PdfPageToolbar({ page, workflow, disabled, inspecting, onInspect, onSplit }: {
  readonly page: PdfPage; readonly workflow: PdfWorkflow; readonly disabled: boolean
  readonly onSplit?: () => void
  readonly inspecting: boolean; readonly onInspect: () => void
}) {
  const view = workflow.setup.value.views?.[page.id], zoom = view?.zoom ?? 100
  const [draft, setDraft] = useState(String(zoom))
  useEffect(() => { setDraft(String(zoom)) }, [zoom])
  function commit(input: HTMLInputElement) {
    if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) { setDraft(String(zoom)); return }
    workflow.setPageView(page.id, { zoom: input.valueAsNumber })
  }
  return <section className={styles.pageOptions} aria-label={t('pdf.pageOptions')}>
    <h3 className={styles.optionLabel}>{t('pdf.pageOptions')}</h3>
    <fieldset disabled={disabled || inspecting} className={styles.toolbarGroup} aria-label={t('pdf.canvasZoom')}>
      {page.kind !== 'legend' && <>
        <button type="button" onClick={() => { setDraft('100'); workflow.fitPage(page.id) }}>{t('pdf.resetFit')}</button>
        <div className={styles.zoomControl}>
          <button type="button" aria-label={t('pdf.zoomOut')} disabled={zoom <= PDF_ZOOM.min}
            onClick={() => workflow.setPageView(page.id, { zoom: Math.max(PDF_ZOOM.min, Math.round(zoom / 1.1 * 10) / 10) })}>−</button>
          <label><input aria-label={t('pdf.canvasZoom')} type="number" min={PDF_ZOOM.min} max={PDF_ZOOM.max} step="any" required value={draft}
            onInput={(event) => setDraft(event.currentTarget.value)} onFocusOut={(event) => commit(event.currentTarget)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget) } }} /><span>%</span></label>
          <button type="button" aria-label={t('pdf.zoomIn')} disabled={zoom >= PDF_ZOOM.max}
            onClick={() => workflow.setPageView(page.id, { zoom: Math.min(PDF_ZOOM.max, Math.round(zoom * 1.1 * 10) / 10) })}>+</button>
        </div>
      </>}
    </fieldset>
    <fieldset disabled={disabled} className={styles.toolbarGroup} aria-label={t('pdf.orientation')}>
      {(['auto', 'portrait', 'landscape'] as const).map((orientation) => <button type="button" key={orientation}
        aria-pressed={(view?.orientation ?? 'auto') === orientation} onClick={() => workflow.setPageView(page.id, { orientation })}>{t(`pdf.${orientation}`)}</button>)}
    </fieldset>
    {page.kind === 'detail' && <button type="button" disabled={disabled || !onSplit} onClick={onSplit}>{t('pdf.splitSheets')}</button>}
    <button type="button" aria-pressed={inspecting} disabled={disabled} onClick={onInspect}>{t(inspecting ? 'pdf.doneInspect' : 'pdf.inspect')}</button>
  </section>
}
