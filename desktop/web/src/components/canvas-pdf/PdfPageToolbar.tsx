import { useEffect, useState } from 'preact/hooks'
import { pdfAreaKey, type PdfPage } from '../../app/canvas-pdf/types'
import { normalisePrintAngle, printScaleKey, scalePickerOptions } from '../../app/canvas-pdf/print-setup'
import type { PdfWorkflow } from '../../app/canvas-pdf/workflow'
import { locale, unitSystem } from '../../app/settings/state'
import { t } from '../../i18n'
import { Dropdown } from '../shared/Dropdown'
import styles from './canvas-pdf.module.css'

function PageAngleControl({
  pageId,
  currentAngle,
  disabled,
  workflow,
}: {
  readonly pageId: string
  readonly currentAngle: number
  readonly disabled: boolean
  readonly workflow: PdfWorkflow
}) {
  const rounded = String(Math.round(currentAngle * 10) / 10)
  const [angleDraft, setAngleDraft] = useState(rounded)
  useEffect(() => { setAngleDraft(rounded) }, [rounded])

  function commitAngle(input: HTMLInputElement) {
    const parsed = Number(input.value)
    if (!Number.isFinite(parsed)) { setAngleDraft(rounded); return }
    workflow.setPageAngle(pageId, normalisePrintAngle(parsed))
  }

  return <fieldset disabled={disabled} className={styles.toolbarGroup} aria-label={t('pdf.pageAngle')}>
    <button type="button" aria-pressed={currentAngle === 0} onClick={() => workflow.setPageAngle(pageId, 0)}>
      {t('pdf.mapOrientationNorthUp')}
    </button>
    <label className={styles.zoomControl}>
      <input
        aria-label={t('pdf.angleDegrees')}
        type="number"
        step="any"
        value={angleDraft}
        onInput={(event) => setAngleDraft(event.currentTarget.value)}
        onFocusOut={(event) => commitAngle(event.currentTarget)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitAngle(event.currentTarget) } }}
      />
      <span>°</span>
    </label>
  </fieldset>
}

export function PdfPageToolbar({ page, workflow, disabled, inspecting, onInspect, onSplit }: {
  readonly page: PdfPage; readonly workflow: PdfWorkflow; readonly disabled: boolean
  readonly onSplit?: () => void
  readonly inspecting: boolean; readonly onInspect: () => void
}) {
  const setup = workflow.setup.value
  const view = setup.views?.[page.id]
  const area = setup.areas?.find((a) => pdfAreaKey(a) === page.id)
  const currentAngle = page.kind === 'overview'
    ? (view?.angleDeg ?? page.angleDeg ?? 0)
    : (area?.angleDeg ?? page.angleDeg ?? 0)
  const currentScale = view?.scale ?? page.scaleSpec ?? { kind: 'fit' as const }
  const options = scalePickerOptions(unitSystem.value, locale.value, t('pdf.resetFit'))
  const currentScaleKey = printScaleKey(currentScale)
  const currentScaleLabel = options.find((o) => o.key === currentScaleKey)?.label ?? t('pdf.resetFit')
  const framingDisabled = disabled || inspecting

  return <section className={styles.pageOptions} aria-label={t('pdf.pageOptions')}>
    <h3 className={styles.optionLabel}>{t('pdf.pageOptions')}</h3>
    {page.kind !== 'legend' && <>
      <fieldset disabled={framingDisabled} className={styles.toolbarGroup} aria-label={t('pdf.scale')}>
        <button type="button" onClick={() => workflow.fitPage(page.id)}>{t('pdf.resetFit')}</button>
        <Dropdown<string>
          ariaLabel={t('pdf.scale')}
          trigger={currentScaleLabel}
          value={currentScaleKey}
          items={options.map((o) => ({ value: o.key, label: o.label }))}
          onChange={(key) => {
            const chosen = options.find((o) => o.key === key)
            if (chosen) workflow.setPageScale(page.id, chosen.scale)
          }}
          preserveOverlays
        />
      </fieldset>
      <PageAngleControl pageId={page.id} currentAngle={currentAngle} disabled={framingDisabled} workflow={workflow} />
    </>}
    <fieldset disabled={disabled} className={styles.toolbarGroup} aria-label={t('pdf.orientation')}>
      {(['auto', 'portrait', 'landscape'] as const).map((orientation) => <button type="button" key={orientation}
        aria-pressed={(view?.orientation ?? 'auto') === orientation} onClick={() => workflow.setPageView(page.id, { orientation })}>{t(`pdf.${orientation}`)}</button>)}
    </fieldset>
    {page.kind === 'detail' && <button type="button" disabled={disabled || !onSplit} onClick={onSplit}>{t('pdf.splitSheets')}</button>}
    <button type="button" aria-pressed={inspecting} disabled={disabled} onClick={onInspect}>{t(inspecting ? 'pdf.doneInspect' : 'pdf.inspect')}</button>
  </section>
}
