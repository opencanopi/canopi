import { DockPanelHeader } from '../shared/DockPanelHeader'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { formatCount } from '../../utils/format-count'
import type { CanvasLayerPresentationDetail, CanvasLayerPresentationRow } from '../../app/canvas-layer-presentation/presentation'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { Dropdown } from '../shared/Dropdown'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { BasemapStyle } from '../../generated/contracts'
import type { MapBackground } from '../../app/settings/state'
import { Slider } from '../shared/Slider'
import { Switch } from '../shared/Switch'
import { LayerVisibilityIcon } from '../shared/LayerVisibilityIcon'
import { ControlIcon } from '../shared/ControlIcon'
import { PanelIcon } from '../shared/PanelIcon'
import layerRow from '../shared/layer-row.module.css'
import styles from './LayerPanel.module.css'

function LayerIcon({ id }: { id: string }) {
  const path = {
    annotations: 'M4 3h8M8 3v10M5 13h6', plants: 'M8 13V7M8 10C2 10 2 4 2 4s6 0 6 6ZM8 7c0-5 6-5 6-5s0 5-6 5Z',
    'measurement-guides': 'm2 11 9-9 3 3-9 9ZM7 6l2 2M10 3l2 2M4 9l2 2', zones: 'M2 3l7-1 5 6-4 6-8-3Z',
    basemap: 'm1 4 5-2 4 2 5-2v11l-5 2-4-2-5 2ZM6 2v11M10 4v11',
    satellite: 'M3 13 13 3M5 5l6 6M2 9l3 3-2 2-3-3ZM9 2l3 3-2 2-3-3ZM11 12a3 3 0 0 0 3-3M11 15a6 6 0 0 0 4-4',
    contours: 'M1 6c4-7 8 7 14-2M1 10c4-7 8 7 14-2M1 14c4-7 8 7 14-2',
    hillshade: 'm1 13 5-9 3 5 2-3 4 7ZM6 4l3 9',
  }[id]
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="7" width="8" height="6.2" rx="1.2" stroke="currentColor" stroke-width="1.3" />
      {locked ? (
        <path
          d="M5.8 7V5.4C5.8 4.1 6.8 3.1 8 3.1C9.2 3.1 10.2 4.1 10.2 5.4V7"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
      ) : (
        <path
          d="M5.8 7V5.4C5.8 4.1 6.8 3.1 8 3.1C9 3.1 9.8 3.8 10.1 4.7"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
      )}
      <path d="M8 9.2V11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  )
}

export interface LayerPanelActions {
  /** Opens a row's settings under it, or closes them when it is open (one row at a time). */
  open(id: string): void
  visibility(id: string, visible: boolean): void
  locked(id: string, locked: boolean): void
  opacity(id: string, opacity: number): void
  contourInterval(meters: number): void
  basemapStyle(style: BasemapStyle): void
  saveGoogleKey(key: string | null): void
  /** Background › Satellite, Street map or None. */
  background(choice: MapBackground): void
  /** Soften background: dims the chosen background under the Design. */
  softenBackground(soften: boolean): void
}

/**
 * The Site data summary row between Design and Map. Desktop: one eye that hides
 * or shows all site data (the items keep their own eyes), "N of M shown", and
 * Site data's panel command on the name area and ›. Web: how many terrain or
 * height layers the Design has and that they need Canopi Desktop; no row at 0.
 */
export type SiteDataSummary =
  | {
      readonly kind: 'available'
      readonly count: number
      /** Entries not missing whose own eye is on, while the summary eye is on. */
      readonly shown: number
      /** The summary eye: the Design's Site data flag. */
      readonly visible: boolean
      /** Site data's panel command (label, shortcut), which the name area and › run. */
      readonly command: { readonly label: string; readonly shortcut?: string; readonly ariaShortcut?: string }
      setVisible(visible: boolean): void
      open(): void
    }
  | { readonly kind: 'needs-desktop'; readonly count: number }

/** Background sources are proper names, the same in every language. */
const BACKGROUND_SOURCES = { satellite: 'Google', basemap: 'OpenFreeMap' } as const

/** Which background the map draws: Satellite hides the Basemap under it. */
function chosenBackground(background: readonly CanvasLayerPresentationRow[]): MapBackground {
  if (background.find((row) => row.id === 'satellite')?.visible) return 'satellite'
  return background.find((row) => row.id === 'basemap')?.visible ? 'basemap' : 'none'
}

/**
 * The Layers panel of both editions, top to bottom: the Design's own objects,
 * the Site data summary row, and the Map (contour lines and hillshading from
 * online elevation, then the background: one choice of Satellite, Street map
 * or None, whose settings always show under it). A row's name opens its
 * settings under it; one row is open at a time. There is no footer.
 */
export function LayerPanel({ rows, actions, siteData }: {
  readonly rows: readonly CanvasLayerPresentationRow[]
  readonly actions: LayerPanelActions
  readonly siteData?: SiteDataSummary
}) {
  const inGroup = (group: CanvasLayerPresentationRow['group']) => rows.filter((row) => row.group === group)
  const terrain = inGroup('map')
  const background = inGroup('background')
  return (
    <aside className={styles.panel} aria-label={t('canvas.layers.layerPanel')}>
      <DockPanelHeader title={t('canvas.layers.layerPanel')} />
      <div className={styles.scroll}>
        <section className={styles.section} aria-labelledby="layers-design">
          <div className={styles.groupHeading}><h3 id="layers-design">{t('canvas.layers.design')}</h3></div>
          <div role="list">{inGroup('design').map((row) => <LayerRow key={row.id} row={row} actions={actions} />)}</div>
        </section>
        {siteData && <SiteDataSummaryRow summary={siteData} />}
        {(terrain.length > 0 || background.length > 0) && (
          <section className={styles.section} aria-labelledby="layers-map">
            <div className={styles.groupHeading}><h3 id="layers-map">{t('canvas.layers.map')}</h3></div>
            {terrain.length > 0 && (
              <div role="list">
                {terrain.map((row) => <LayerRow key={row.id} row={row} actions={actions} caption={terrainCaption(row)} />)}
              </div>
            )}
            {background.length > 0 && <>
              <h4 className={styles.subHeading} id="layers-background">{t('canvas.layers.background')}</h4>
              <BackgroundChoice rows={background} actions={actions} />
            </>}
          </section>
        )}
      </div>
    </aside>
  )
}

/** The Site data glyph (the rail's topographic rings) at the rows' 16 px. */
function SiteDataGlyph() {
  return <span className={styles.glyph}><PanelIcon panel="site-data" /></span>
}

function SiteDataSummaryRow({ summary }: { readonly summary: SiteDataSummary }) {
  const name = t('canvas.layers.siteData')
  if (summary.kind === 'needs-desktop') {
    if (summary.count === 0) return null
    return (
      <section className={`${styles.section} ${styles.summary}`} aria-label={name}>
        <div className={`${layerRow.row} ${styles.summaryRow}`} data-edition="web">
          <span className={styles.summaryName}>
            <SiteDataGlyph />
            <span className={styles.nameText}>
              <span>{name}</span>
              <small className={styles.caption}>{t('canvas.layers.siteDataWeb', { count: summary.count })}</small>
            </span>
          </span>
        </div>
      </section>
    )
  }
  const caption = summary.count === 0
    ? t('canvas.layers.siteDataNone')
    : t('canvas.layers.siteDataShown', { shown: summary.shown, count: summary.count })
  const eyeLabel = t(summary.visible ? 'canvas.lidar.layers.hide' : 'canvas.lidar.layers.show', { name })
  const openLabel = t('canvas.layers.openSiteData')
  return (
    <section className={`${styles.section} ${styles.summary}`} aria-label={name}>
      <div className={`${layerRow.row} ${styles.summaryRow}`} data-hidden={summary.count > 0 && !summary.visible ? 'true' : 'false'}>
        {summary.count > 0 ? (
          <button
            type="button"
            className={layerRow.eye}
            aria-label={eyeLabel}
            aria-pressed={summary.visible}
            onClick={() => summary.setVisible(!summary.visible)}
          >
            <LayerVisibilityIcon open={summary.visible} />
            <ButtonTooltip label={eyeLabel} side="right" />
          </button>
        ) : <span className={styles.lockSlot} aria-hidden="true" />}
        <button
          type="button"
          className={`${layerRow.name} ${styles.layerName} ${styles.summaryName}`}
          aria-keyshortcuts={summary.command.ariaShortcut}
          onClick={summary.open}
        >
          <SiteDataGlyph />
          <span className={styles.nameText}>
            <span>{name}</span>
            <small className={styles.caption}>{caption}</small>
          </span>
          {/* The name and caption name the button; the tooltip only adds the shortcut. Below the row, inside the panel's
              scroll box, which clips anything beside it. */}
          <span aria-hidden="true"><ButtonTooltip label={summary.command.label} shortcut={summary.command.shortcut} side="bottom" /></span>
        </button>
        <button type="button" className={styles.lockBtn} aria-label={openLabel} onClick={summary.open}>
          <ControlIcon name="chevron-right" size={16} />
          <ButtonTooltip label={openLabel} side="left" />
        </button>
      </div>
    </section>
  )
}

/**
 * Background as one choice: Satellite, Street map or None. The chosen
 * background's settings always show under the choice: the satellite key or
 * the map style, then opacity and Soften background.
 */
function BackgroundChoice({ rows, actions }: {
  readonly rows: readonly CanvasLayerPresentationRow[]
  readonly actions: LayerPanelActions
}) {
  const choice = chosenBackground(rows)
  const options: { value: MapBackground; label: string; source: string; row?: CanvasLayerPresentationRow }[] = [
    { value: 'satellite', label: t('canvas.layers.satellite'), source: BACKGROUND_SOURCES.satellite, row: rows.find((row) => row.id === 'satellite') },
    { value: 'basemap', label: t('canvas.layers.backgroundMap'), source: BACKGROUND_SOURCES.basemap, row: rows.find((row) => row.id === 'basemap') },
    { value: 'none', label: t('canvas.layers.backgroundNone'), source: t('canvas.layers.backgroundPlainPaper') },
  ]
  const chosen = options.find((option) => option.value === choice)?.row
  return <>
    <div role="radiogroup" aria-labelledby="layers-background" className={styles.backgroundChoice}>
      {options.filter((option) => option.value === 'none' || option.row).map((option) => (
        <label key={option.value} className={styles.backgroundOption}>
          <input
            type="radio"
            name="layers-background"
            value={option.value}
            checked={option.value === choice}
            onChange={() => actions.background(option.value)}
          />
          <span className={styles.nameText}>
            <span>{option.label}</span>
            <small className={styles.caption}>{option.source}</small>
          </span>
        </label>
      ))}
    </div>
    {chosen && <LayerDetail row={chosen} actions={actions} />}
  </>
}

/** Contour lines and hillshading say which elevation they are drawn from. */
function terrainCaption(row: CanvasLayerPresentationRow): string {
  if (row.detail.type === 'contours') {
    return row.detail.contourIntervalMeters > 0
      ? t('canvas.terrain.contoursEvery', {
        interval: new Intl.NumberFormat(locale.value).format(row.detail.contourIntervalMeters),
      })
      : t('canvas.terrain.contoursByZoom')
  }
  return t('canvas.terrain.fromOnlineElevation')
}

/**
 * One row: eye, icon, name (with a caption and count) and lock. Its name opens
 * the row's settings under it, scrolled into view.
 */
function LayerRow({ row, actions, caption }: {
  readonly row: CanvasLayerPresentationRow
  readonly actions: LayerPanelActions
  readonly caption?: string
}) {
  const lockLabel = row.locked ? t('canvas.layers.unlockLayer') : t('canvas.layers.lockLayer')
  const eyeLabel = t(row.visible ? 'canvas.lidar.layers.hide' : 'canvas.lidar.layers.show', { name: row.label })
  const item = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (row.open) item.current?.scrollIntoView?.({ block: 'nearest' })
  }, [row.open])
  return (
    <div
      ref={item}
      role="listitem"
      className={styles.item}
    >
      <div
        className={`${layerRow.row} ${styles.layerRow}`}
        data-hidden={row.visible ? 'false' : 'true'}
        data-locked={row.locked ? 'true' : 'false'}
      >
        <button
          type="button"
          className={layerRow.eye}
          aria-label={eyeLabel}
          aria-pressed={row.visible}
          onClick={() => {
            actions.visibility(row.id, !row.visible)
          }}
        >
          <LayerVisibilityIcon open={row.visible} />
          <ButtonTooltip label={eyeLabel} side="right" />
        </button>
        <button
          type="button"
          className={`${layerRow.name} ${styles.layerName}`}
          aria-expanded={row.open}
          title={row.label}
          onClick={() => actions.open(row.id)}
        >
          <LayerIcon id={row.id} />
          <span className={styles.nameText}>
            <span>{row.label}</span>
            {caption && <small className={styles.caption}>{caption}</small>}
          </span>
          {row.count !== undefined && <span className={styles.count}>{formatCount(row.count, locale.value)}</span>}
        </button>
        {row.canLock ? (
          <button
            type="button"
            className={styles.lockBtn}
            aria-label={`${lockLabel}: ${row.label}`}
            aria-pressed={row.locked}
            onClick={() => {
              actions.locked(row.id, !row.locked)
            }}
          >
            <LockIcon locked={row.locked} />
            <ButtonTooltip label={lockLabel} side="left" />
          </button>
        ) : (
          <span className={styles.lockSlot} aria-hidden="true" />
        )}
      </div>
      {row.open && <LayerDetail row={row} actions={actions} />}
    </div>
  )
}

function LayerDetail({ row, actions }: { row: CanvasLayerPresentationRow; actions: LayerPanelActions }) {
  switch (row.detail.type) {
    case 'basemap':
      return <BasemapLayerDetail row={row} detail={row.detail} actions={actions} />
    case 'satellite':
      return <SatelliteLayerDetail row={row} detail={row.detail} actions={actions} />
    case 'contours':
      return <ContourLayerDetail row={row} detail={row.detail} actions={actions} />
    case 'hillshade':
      return <HillshadeLayerDetail row={row} actions={actions} />
    case 'scene':
      return <SceneLayerDetail row={row} actions={actions} />
  }
}

function BasemapLayerDetail({ row, detail, actions }: {
  actions: LayerPanelActions
  row: CanvasLayerPresentationRow
  detail: Extract<CanvasLayerPresentationDetail, { type: 'basemap' }>
}) {
  return (
    <div className={styles.layerDetail}>
      <div className={styles.controlRow}>
        <span className={styles.controlLabel}>{t('canvas.basemap.style')}</span>
        <Dropdown
          trigger={t(`canvas.basemap.styles.${detail.style}`)}
          items={detail.styles.map((style) => ({ value: style, label: t(`canvas.basemap.styles.${style}`) }))}
          value={detail.style}
          onChange={(style) => actions.basemapStyle(style)}
          ariaLabel={t('canvas.basemap.style')}
          floating
        />
      </div>
      <OpacitySlider actions={actions} row={row} />
      <SoftenBackgroundSwitch soften={detail.softenBackground} actions={actions} />
    </div>
  )
}

function SatelliteLayerDetail({ row, detail, actions }: {
  actions: LayerPanelActions
  row: CanvasLayerPresentationRow
  detail: Extract<CanvasLayerPresentationDetail, { type: 'satellite' }>
}) {
  return (
    <div className={styles.layerDetail}>
      <GoogleKeyForm hasKey={detail.hasGoogleKey} onSave={(key) => actions.saveGoogleKey(key)} />
      <OpacitySlider actions={actions} row={row} />
      <SoftenBackgroundSwitch soften={detail.softenBackground} actions={actions} />
    </div>
  )
}

function SoftenBackgroundSwitch({ soften, actions }: { soften: boolean; actions: LayerPanelActions }) {
  return (
    <Switch
      label={t('speciesKey.softenBackground')}
      hint={t('speciesKey.softenBackgroundHint')}
      checked={soften}
      onChange={(next) => actions.softenBackground(next)}
    />
  )
}

/**
 * The device-local Google key. The field never shows a stored key; saving
 * trims it, and it never reaches a Design, export, diagnostic bundle or log.
 */
function GoogleKeyForm({ hasKey, onSave }: { hasKey: boolean; onSave(key: string | null): void }) {
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  return (
    <form
      className={styles.keyForm}
      onSubmit={(event) => {
        event.preventDefault()
        if (!draft.trim()) return
        onSave(draft)
        setDraft('')
        setSaved(true)
      }}
    >
      {!hasKey && <p className={styles.layerNote}>{t('canvas.satellite.googleKeyOptional')}</p>}
      <label className={styles.controlRow}>
        <span className={styles.controlLabel}>{t('canvas.basemap.googleKey')}</span>
        <input
          type="password"
          className={styles.keyInput}
          autoComplete="off"
          spellcheck={false}
          value={draft}
          placeholder={hasKey ? '••••••••' : ''}
          onInput={(event) => {
            setSaved(false)
            setDraft(event.currentTarget.value)
          }}
        />
      </label>
      <div className={styles.keyActions}>
        <button type="submit" className={styles.keyButton} disabled={!draft.trim()}>{t('canvas.basemap.saveKey')}</button>
        {hasKey && (
          <button
            type="button"
            className={styles.keyButton}
            onClick={() => {
              setDraft('')
              setSaved(false)
              onSave(null)
            }}
          >
            {t('canvas.basemap.clearKey')}
          </button>
        )}
      </div>
      {saved && <p className={styles.layerNote} role="status">{t('canvas.basemap.keySaved')}</p>}
      <p className={styles.layerNote}>{t('canvas.basemap.keyLocalOnly')}</p>
    </form>
  )
}

function ContourLayerDetail({ row, detail, actions }: {
  actions: LayerPanelActions
  row: CanvasLayerPresentationRow
  detail: Extract<CanvasLayerPresentationDetail, { type: 'contours' }>
}) {
  return (
    <div className={styles.layerDetail}>
      <OpacitySlider actions={actions} row={row} />
      <div className={styles.controlRow}>
        <span className={styles.controlLabel}>{t('canvas.terrain.contourInterval')}</span>
        <input
          type="number"
          min="0"
          step="1"
          className={styles.numericInput}
          value={String(detail.contourIntervalMeters)}
          aria-label={t('canvas.terrain.contourInterval')}
          onInput={(event) => {
            const raw = event.currentTarget.value
            const value = Number(raw)
            if (raw.trim() && Number.isFinite(value) && value >= 0) actions.contourInterval(value)
          }}
        />
      </div>
    </div>
  )
}

function HillshadeLayerDetail({ row, actions }: {
  actions: LayerPanelActions
  row: CanvasLayerPresentationRow
}) {
  return (
    <div className={styles.layerDetail}>
      <OpacitySlider actions={actions} row={row} />
    </div>
  )
}

function SceneLayerDetail({ row, actions }: { row: CanvasLayerPresentationRow; actions: LayerPanelActions }) {
  return (
    <div className={styles.layerDetail}>
      <OpacitySlider actions={actions} row={row} />
    </div>
  )
}

function OpacitySlider({ row, actions }: { row: CanvasLayerPresentationRow; actions: LayerPanelActions }) {
  return (
    <Slider
      label={t('canvas.layers.opacity')}
      ariaLabel={`${t('canvas.layers.opacity')}: ${row.label}`}
      min={0}
      max={100}
      value={Math.round(row.opacity * 100)}
      format={(percent) => new Intl.NumberFormat(locale.value, { style: 'percent' }).format(percent / 100)}
      onInput={(percent) => actions.opacity(row.id, percent / 100)}
    />
  )
}
