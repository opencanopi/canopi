import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { acceptsAnalysis, defaultAnalysisSource } from '../../../app/analyses/model'
import { designSessionStore } from '../../../app/document-session/store'
import { armCanvasTool } from '../../../app/keyboard/arming'
import { formatCoordinates } from '../../../app/geocoding/coordinates'
import { analyzeItem, beginDataImport, openDataLibrary } from '../../../app/data-library/library-navigation'
import { installLidarLibraryObserver, lidarLibrary, readCurrentLidarPresentation } from '../../../app/data-library/library-store'
import { armProfile, profileAvailable } from '../../../app/data-library/profile'
import { siteDataViewFor, type SiteDataView } from '../../../app/data-library/site-data-view'
import { pin, unpin } from '../../../app/data-library/site-transients'
import { siteValues } from '../../../app/data-library/site-values'
import { referenceRows } from '../../../app/data-library/reference-tree'
import { locale } from '../../../app/settings/state'
import { currentCanvasTool } from '../../../canvas/session'
import { t } from '../../../i18n'
import { ButtonTooltip } from '../../shared/ButtonTooltip'
import { ToolIcon } from '../../canvas/toolbar-icons'
import { ControlIcon } from '../../shared/ControlIcon'
import { DockPanelHeader } from '../../shared/DockPanelHeader'
import { ProfileChart } from './ProfileChart'
import { rowElement, SiteDataList } from './SiteData'
import styles from './site-data.module.css'

/** Decimals of the pinned point's coordinates (U49 Q21: about 0.1 m). */
const PIN_DECIMALS = 6

/**
 * The Site data panel (canopi-f47t.42, spec §1.10; Desktop, a Design panel):
 * the header with the Data library and close, the pinned point or the hint,
 * the toolbar (Import…, Analyze…, Profile), the Design's site data, and the
 * profile chart pinned to the bottom. GeoJSON is imported from File ▸
 * Import GeoJSON… only (U49 decision 13).
 */
export function SiteDataPanel() {
  useEffect(() => installLidarLibraryObserver(), [])
  const view = siteDataViewFor(designSessionStore.sessionIdentity.value)
  const libraryLabel = t('canvas.lidar.library.title')
  const body = useRef<HTMLDivElement>(null)

  // The list's scroll survives the dock unmounting the panel; a reveal scrolls its item into view once drawn.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = view.scrollTop
  }, [view])
  const reveal = view.reveal.value
  useLayoutEffect(() => {
    if (!reveal) return
    rowElement(body.current, reveal.id)?.scrollIntoView?.({ block: 'nearest' })
  }, [reveal])

  return (
    <aside className={styles.panel} aria-label={t('canvas.layers.siteData')}>
      <DockPanelHeader
        title={t('canvas.layers.siteData')}
        actions={(
          <button type="button" className={styles.headerButton} aria-label={libraryLabel} onClick={() => openDataLibrary(view.openItem.value)}>
            <ControlIcon name="folder-open" size={18} />
            <ButtonTooltip label={libraryLabel} side="bottom" />
          </button>
        )}
      />
      <PinLine />
      <Toolbar view={view} />
      <div ref={body} className={styles.body} onScroll={(event) => { view.scrollTop = event.currentTarget.scrollTop }}>
        <SiteDataList view={view} />
      </div>
      <ProfileChart />
    </aside>
  )
}

/**
 * The pinned point's coordinates with Unpin; with no pin and the pointer off
 * the map, a muted hint, but only while some row can show a value.
 */
function PinLine() {
  const point = pin.value
  if (point) {
    return (
      <div className={styles.pinLine}>
        <ControlIcon name="pin" size={16} />
        <span className={styles.coordinates}>{formatCoordinates(point.lat, point.lon, PIN_DECIMALS, locale.value)}</span>
        <button type="button" className={styles.stripButton} onClick={unpin}>{t('siteData.unpin')}</button>
      </div>
    )
  }
  if (siteValues.value) return null
  const readable = readCurrentLidarPresentation().some((item) => item.shown && item.availability === 'present' && item.state === 'Ready')
  if (!readable) return null
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  return <p className={styles.hint}>{coarse ? t('siteData.hintTouch') : t('siteData.hint')}</p>
}

function Toolbar({ view }: { readonly view: SiteDataView }) {
  const items = readCurrentLidarPresentation()
  const library = lidarLibrary.value
  // A ready item in this Design that an analysis accepts (spec §1.10 "Toolbar"): an engine or grid problem still counts,
  // and Analyze names it. Analyze runs on the item it is sent, with Analyze's own default Source.
  const eligible = referenceRows(items).filter((item) => {
    const summary = library?.items.find((candidate) => candidate.id === item.id)
    return summary?.state === 'Ready' && acceptsAnalysis(summary)
  })
  const sourceId = defaultAnalysisSource(eligible, items, view.openItem.value)
  const canProfile = profileAvailable.value
  const profiling = currentCanvasTool.value === 'profile'
  return (
    <div className={styles.toolbar}>
      <button type="button" className={styles.toolButton} onClick={() => { void beginDataImport() }}>
        {t('canvas.lidar.library.import')}
      </button>
      <button
        type="button"
        className={styles.toolButton}
        aria-disabled={sourceId ? undefined : true}
        onClick={() => { if (sourceId) analyzeItem(sourceId) }}
      >
        {t('canvas.lidar.library.analyze')}
        {!sourceId && <ButtonTooltip label={t('siteData.analyzeNeedsData')} side="bottom" />}
      </button>
      <button
        type="button"
        className={styles.toolButton}
        aria-pressed={profiling}
        aria-disabled={canProfile ? undefined : true}
        onClick={() => {
          if (!canProfile) return
          if (profiling) armCanvasTool('select', { from: 'panel' })
          else armProfile('panel')
        }}
      >
        <ToolIcon name="profile" className={styles.toolIcon} />
        {t('siteData.profile')}
        {!canProfile && <ButtonTooltip label={t('siteData.profileNeedsLayer')} side="bottom" />}
      </button>
    </div>
  )
}
