import { useEffect, useId, useState } from 'preact/hooks'
import { importLibraryItem } from '../../../app/lidar/actions'
import { checkImportCoverage, coverageCanvas, type ImportCoverage } from '../../../app/lidar/import-coverage'
import { IMPORTABLE_QUANTITIES, RASTER_QUANTITIES } from '../../../app/lidar/item-types'
import { suggestedItemName, takenItemNames } from '../../../app/lidar/library-items'
import { lidarLibrary } from '../../../app/lidar/library-store'
import { locale } from '../../../app/settings/state'
import type { RasterQuantity } from '../../../generated/contracts'
import { t } from '../../../i18n'
import { formatDistance } from '../../canvas/ZoomControls'
import { ButtonTooltip } from '../../shared/ButtonTooltip'
import { ControlIcon } from '../../shared/ControlIcon'
import { Dropdown } from '../../shared/Dropdown'
import { Notice } from '../../shared/Notice'
import { WorkspaceDialog } from '../../shared/WorkspaceDialog'
import { LibraryItemNameField, isItemNameTaken } from './LibraryItemNameField'
import styles from './data-library.module.css'

/**
 * Import terrain or height data: what Canopi accepts, the item's name (a name
 * the library already uses is refused with a free one suggested), what the
 * values measure, the files in priority order, and whether they cover the
 * open Design's site. The files were chosen in the native picker first, so
 * cancelling here creates nothing. The item joins this Design once it is
 * published, wherever the import was started (the one attach rule).
 */
export function ImportDataDialog({ paths, onClose }: {
  readonly paths: readonly string[]
  onClose(): void
}) {
  const formId = useId()
  const [files, setFiles] = useState<readonly string[]>(paths)
  const [name, setName] = useState(() => suggestedItemName(paths))
  const [quantity, setQuantity] = useState<RasterQuantity | ''>('')
  const [unitLabel, setUnitLabel] = useState('')
  const [unitUnknown, setUnitUnknown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<ImportCoverage | null>(null)
  const taken = takenItemNames(lidarLibrary.value)
  const trimmed = name.trim()
  const duplicate = isItemNameTaken(name, taken)
  const declaresUnits = quantity !== '' && RASTER_QUANTITIES[quantity].declaresUnits
  const unitReady = !declaresUnits || unitUnknown || unitLabel.trim() !== ''
  const ready = !busy && quantity !== '' && trimmed !== '' && !duplicate && unitReady && files.length > 0
  const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path
  const move = (index: number, by: -1 | 1) => {
    const next = [...files]
    const [moved] = next.splice(index, 1)
    next.splice(index + by, 0, moved!)
    setFiles(next)
  }

  const filesKey = files.join('\n')
  const canvas = coverageCanvas()
  useEffect(() => {
    let current = true
    setCoverage(null)
    void checkImportCoverage(files).then((next) => { if (current) setCoverage(next) })
    return () => { current = false }
  }, [filesKey, canvas])

  const submit = async () => {
    if (!ready || !quantity) return
    setBusy(true)
    setError(null)
    try {
      await importLibraryItem([...files], trimmed, quantity, declaresUnits
        ? { label: unitUnknown ? null : unitLabel.trim(), unknown: unitUnknown }
        : { label: null, unknown: false })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <WorkspaceDialog
      title={t('canvas.lidar.import.title')}
      onClose={onClose}
      footer={<>
        <button type="button" className={styles.dialogButton} onClick={onClose}>{t('canvas.lidar.library.cancel')}</button>
        <button type="submit" form={formId} className={`${styles.dialogButton} ${styles.primary}`} disabled={!ready}>
          {t('canvas.lidar.import.submit', { count: files.length })}
        </button>
      </>}
    >
      <form id={formId} className={styles.form} noValidate onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <Notice tone="info">
          <strong>{t('canvas.lidar.import.supportedTitle')}</strong> {t('canvas.lidar.import.supported')}
        </Notice>
        <LibraryItemNameField value={name} taken={taken} onInput={setName} initialFocus />
        <div className={styles.pair}>
          <div className={styles.field}>
            <span aria-hidden="true">{t('canvas.lidar.library.quantityLabel')}</span>
            <Dropdown<RasterQuantity | ''>
              ariaLabel={t('canvas.lidar.library.quantityLabel')}
              trigger={quantity ? t(RASTER_QUANTITIES[quantity].labelKey) : t('canvas.lidar.library.chooseQuantity')}
              items={IMPORTABLE_QUANTITIES.map((value) => ({ value, label: t(RASTER_QUANTITIES[value].labelKey) }))}
              value={quantity}
              onChange={setQuantity}
            />
          </div>
          {declaresUnits && (
            <div className={styles.field}>
              <label className={styles.field}>
                <span>{t('canvas.lidar.library.unit')}</span>
                <input value={unitLabel} disabled={unitUnknown} onInput={(event) => setUnitLabel(event.currentTarget.value)} />
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={unitUnknown} onChange={(event) => setUnitUnknown(event.currentTarget.checked)} />
                {t('canvas.lidar.library.unitUnknown')}
              </label>
            </div>
          )}
        </div>
        {quantity !== '' && !declaresUnits && (
          <p className={styles.fieldHint}>{t('canvas.lidar.import.metres')}</p>
        )}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('canvas.lidar.import.files', { count: files.length })}</span>
          <ol className={styles.fileList}>
            {files.map((path, index) => {
              const file = fileName(path)
              const up = t('canvas.lidar.import.moveFileUp', { name: file })
              const down = t('canvas.lidar.import.moveFileDown', { name: file })
              const remove = t('canvas.lidar.import.removeFile', { name: file })
              return (
                <li key={path} className={styles.file}>
                  <span className={styles.filename}>{file}</span>
                  <button type="button" className={styles.fileButton} aria-label={up} disabled={index === 0} onClick={() => move(index, -1)}>
                    <ControlIcon name="chevron-down" className={styles.flip} />
                    <ButtonTooltip label={up} side="left" />
                  </button>
                  <button type="button" className={styles.fileButton} aria-label={down} disabled={index === files.length - 1} onClick={() => move(index, 1)}>
                    <ControlIcon name="chevron-down" />
                    <ButtonTooltip label={down} side="left" />
                  </button>
                  <button type="button" className={styles.fileButton} aria-label={remove} disabled={files.length === 1}
                    onClick={() => setFiles(files.filter((candidate) => candidate !== path))}>
                    <ControlIcon name="close" />
                    <ButtonTooltip label={remove} side="left" />
                  </button>
                </li>
              )
            })}
          </ol>
          {files.length > 1 && <span className={styles.fieldHint}>{t('canvas.lidar.library.priorityNote')}</span>}
        </div>
        {coverage && <CoverageNotice coverage={coverage} />}
        <p className={styles.fieldHint}>{t('canvas.lidar.import.toDesign')}</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </WorkspaceDialog>
  )
}

/** "Covers your site": where the chosen files lie against the open Design. */
function CoverageNotice({ coverage }: { readonly coverage: ImportCoverage }) {
  // Rough ground sizes: whole metres ("891 m"), tenths of a kilometre ("2.1 km"), whole kilometres from 10 km.
  const distance = (metres: number) =>
    formatDistance(metres >= 10_000 ? Math.round(metres / 1000) * 1000 : Math.max(1, Math.round(metres)), locale.value)
  if (coverage.kind === 'apart') {
    return (
      <Notice tone="warning">
        <strong>{t('canvas.lidar.import.coverage.apartTitle')}</strong>{' '}
        {t('canvas.lidar.import.coverage.apartBody', { distance: distance(coverage.distanceM) })}
      </Notice>
    )
  }
  const span = t('canvas.lidar.import.coverage.span', { width: distance(coverage.widthM), height: distance(coverage.heightM) })
  return (
    <Notice tone="info">
      <strong>{t(coverage.kind === 'covers' ? 'canvas.lidar.import.coverage.coversTitle' : 'canvas.lidar.import.coverage.partialTitle')}</strong>{' '}
      {coverage.kind === 'covers' ? span : `${span} ${t('canvas.lidar.import.coverage.partialBody')}`}
    </Notice>
  )
}
