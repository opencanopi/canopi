import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { fetchItemSources, fetchProcessingHistory } from '../../../app/lidar/actions'
import { analysisTitle, findAnalysis, registryText } from '../../../app/analyses/registry'
import { formatRasterMetres, formatRasterRange } from '../../../app/lidar/display-legend'
import { itemTypeLabel } from '../../../app/lidar/item-types'
import type { LibraryItem } from '../../../app/lidar/library-items'
import { locale } from '../../../app/settings/state'
import type { ProcessingRun, Provenance } from '../../../generated/contracts'
import { t } from '../../../i18n'
import { Notice } from '../../shared/Notice'
import { formatTimestamp, paramValueText, staleReasonText } from '../analyze/analysis-text'
import { isRunning, isStale, itemStatusLabel } from './item-text'
import styles from './data-library.module.css'

/**
 * One library item's details: whether a result is out of date (with Refresh),
 * its facts (when it was added, and for a source its saved results) and
 * provenance, the caller's actions, its source files, and a derived item's
 * processing history. The source files and history are fetched only once
 * `rested` says the selection has settled, so moving through a list does not
 * fetch for every row it passes.
 */
export function ItemDetails({ item, nameOf, onOpenInput, onRefresh, busy, preview, actions, operation, results = [], rested = true }: {
  item: LibraryItem
  nameOf(id: string): string
  /** Open another item: an input the result was calculated from, or a saved result; omitted where they are plain text. */
  onOpenInput?(id: string): void
  onRefresh(): void
  busy: boolean
  preview?: ComponentChildren
  actions?: ComponentChildren
  operation?: ComponentChildren
  /** The results saved from this item, listed as links. */
  results?: readonly LibraryItem[]
  /** Whether the selection has rested, so the details may fetch. */
  rested?: boolean
}) {
  const [files, setFiles] = useState<string[] | null>(null)
  useEffect(() => {
    setFiles(null)
    if (!rested || item.role !== 'Source' || item.status !== 'ready') return
    let current = true
    void fetchItemSources(item.id)
      .then((page) => { if (current) setFiles(page.sources.map((source) => source.filename)) })
      .catch(() => { if (current) setFiles([]) })
    return () => { current = false }
  }, [item.id, item.status, rested])
  return (
    <div className={styles.details}>
      {preview}
      {isStale(item) && item.freshness.state === 'Stale' && (
        <Notice
          tone="warning"
          action={!isRunning(item) && (
            <button type="button" className={styles.noticeButton} disabled={busy} aria-label={t('analyses.details.refreshAria', { name: item.name })} onClick={onRefresh}>
              {t('analyses.details.refresh')}
            </button>
          )}
        >
          <strong>{t('analyses.details.outOfDate')}</strong>
          <ul className={styles.reasons}>
            {item.freshness.reasons.map((reason, index) => <li key={index}>{staleReasonText(reason, nameOf)}</li>)}
          </ul>
        </Notice>
      )}
      <dl className={styles.facts}>
        <dt>{t('canvas.lidar.library.factType')}</dt>
        <dd>{itemTypeLabel(item.itemType)}</dd>
        <dt>{t('canvas.lidar.library.factUnits')}</dt>
        <dd>{item.units === 'unknown' ? t('canvas.lidar.library.unitUnknown') : item.units}</dd>
        {item.resolutionM !== null && <>
          <dt>{t('canvas.lidar.library.factResolution')}</dt>
          <dd>{formatRasterMetres(item.resolutionM, locale.value)}</dd>
        </>}
        {item.displayRange && <>
          <dt>{t('canvas.lidar.library.factRange')}</dt>
          <dd>{formatRasterRange(item.displayRange, item.units, locale.value)}</dd>
        </>}
        <dt>{t('canvas.lidar.library.factStatus')}</dt>
        <dd>{item.status === 'ready' ? t('canvas.lidar.library.ready') : itemStatusLabel(item)}</dd>
        <dt>{t('canvas.lidar.library.factAdded')}</dt>
        <dd>{formatTimestamp(item.createdAt, locale.value)}</dd>
        {item.provenance && <ProvenanceFacts provenance={item.provenance} nameOf={nameOf} onOpenInput={onOpenInput} />}
        {results.length > 0 && <>
          <dt>{t('canvas.lidar.library.factResults')}</dt>
          <dd className={styles.links}>
            {results.map((result) => onOpenInput
              ? <button key={result.id} type="button" className={styles.link} onClick={() => onOpenInput(result.id)}>{result.name}</button>
              : <span key={result.id}>{result.name}</span>)}
          </dd>
        </>}
      </dl>
      {actions && <div className={styles.detailActions}>{actions}</div>}
      {operation}
      {item.role === 'Source' && files && files.length > 0 && (
        <details className={styles.disclosure}>
          <summary>{t('canvas.lidar.library.sourceFiles', { count: files.length })}</summary>
          <ol className={styles.files}>{files.map((file, index) => <li key={`${index}-${file}`} className={styles.filename}>{file}</li>)}</ol>
        </details>
      )}
      {item.provenance && rested && <ProcessingHistory key={item.provenance.definition_id} definitionId={item.provenance.definition_id} />}
      {item.provenance && <p className={styles.muted}>{t('analyses.details.refreshNote')}</p>}
    </div>
  )
}

/** What produced a derived item: analysis, method version, settings, inputs, engine and date. */
function ProvenanceFacts({ provenance, nameOf, onOpenInput }: {
  provenance: Provenance
  nameOf(id: string): string
  onOpenInput?(id: string): void
}) {
  const language = locale.value
  const entry = findAnalysis(provenance.analysis_id)
  const tool = provenance.tool
  return <>
    <dt>{t('analyses.details.analysis')}</dt>
    <dd>{analysisTitle(provenance.analysis_id)} · {t('analyses.details.methodVersion', { version: provenance.recipe_version })}</dd>
    <dt>{t('analyses.details.inputs')}</dt>
    <dd>
      {provenance.inputs.map((input) => onOpenInput
        ? (
          <button key={input.key} type="button" className={styles.link} onClick={() => onOpenInput(input.item_id)}>
            {nameOf(input.item_id)}
          </button>
        )
        : <span key={input.key}>{nameOf(input.item_id)}</span>)}
    </dd>
    {provenance.parameters.map((parameter) => {
      const spec = entry?.params.find((param) => param.key === parameter.key)
      return [
        <dt key={`${parameter.key}-label`}>{spec ? registryText(spec.labelKey) : parameter.key}</dt>,
        <dd key={`${parameter.key}-value`}>{paramValueText(entry, parameter, language)}</dd>,
      ]
    })}
    {tool && <>
      <dt>{t('analyses.details.engine')}</dt>
      <dd className={styles.filename}>{tool.version} ({tool.revision.slice(0, 12)})</dd>
    </>}
    <dt>{t('analyses.details.created')}</dt>
    <dd>{formatTimestamp(provenance.created_at, language)}</dd>
  </>
}

/** The runs of one definition, newest first, paged on request. */
function ProcessingHistory({ definitionId }: { definitionId: string }) {
  const [runs, setRuns] = useState<ProcessingRun[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const language = locale.value
  const load = (from: string | null) => {
    setLoading(true)
    setFailed(false)
    void fetchProcessingHistory(definitionId, from)
      .then((page) => {
        setRuns((previous) => [...(from ? previous ?? [] : []), ...page.runs])
        setCursor(page.next_cursor)
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load(null) }, [definitionId])
  return (
    <section className={styles.history} aria-label={t('analyses.details.history')}>
      <h4>{t('analyses.details.history')}</h4>
      {runs !== null && runs.length === 0 && <p className={styles.muted}>{t('analyses.details.historyEmpty')}</p>}
      {runs !== null && runs.length > 0 && (
        <ol>
          {runs.map((entry, index) => (
            <li key={entry.job_id} data-state={entry.state}>
              <strong>{t(`analyses.details.runState.${entry.state}`)}{index === 0 && entry.state === 'Complete' ? ` · ${t('analyses.details.current')}` : ''}</strong>
              <span className={styles.muted}>
                {formatTimestamp(entry.created_at, language)}{entry.tool ? ` · ${entry.tool.version}` : ''} · {runOutputs(entry, language)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {loading && <p className={styles.muted} role="status">{t('analyses.details.historyLoading')}</p>}
      {failed && <p className={styles.error} role="alert">{t('analyses.details.historyFailed')}</p>}
      {cursor && !loading && (
        <button type="button" onClick={() => load(cursor)}>{t('analyses.details.showMore')}</button>
      )}
    </section>
  )
}

function runOutputs(run: ProcessingRun, language: string): string {
  if (run.outputs.length === 0) return t('analyses.details.noOutputs')
  const cells = run.outputs.reduce((total, output) => total + Number(output.coverage_cells ?? 0), 0)
  return t('analyses.details.coverage', { cells: new Intl.NumberFormat(language).format(cells) })
}
