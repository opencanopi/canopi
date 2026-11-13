import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { t } from '../../i18n'
import { clearSpeciesDetailOnMap, selectSpeciesPlants, showSpeciesDetailOnMap, zoomToSpeciesPlants } from '../../app/plant-finder/map-matches'
import { currentCanvasTool } from '../../canvas/session'
import type { PlantStampSourceInput } from '../../canvas/plant-stamp-source'
import { PlantSymbolGlyph } from '../canvas/PlantSymbolGlyph'
import { useCatalogDesignSpecies } from '../plant-db/design-species'
import { catalogHabitSymbol } from '../plant-db/habit-symbol'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon } from '../shared/ControlIcon'
import { closeDockPanel } from '../shared/DockPanelHeader'
import { SpeciesCommonName } from '../shared/SpeciesIdentity'
import styles from './SpeciesDetail.module.css'
import { placeSpeciesOnMap } from '../plant-db/place-species'

export interface SpeciesDetailIdentity {
  readonly canonicalName: string
  /** The name in the interface language, when the catalog has one. */
  readonly commonName: string | null
  /** Shown, marked "(en)", when there is no name in the interface language. */
  readonly englishName: string | null
  readonly family: string | null
  /** The catalog habit key (`Tree`, …) that picks the glyph of a species not in the Design. */
  readonly habitKey: string | null
}

/**
 * Species detail in both editions: Back, favourite star and Close; the glyph, names and
 * code; a scrolling body; and a footer with the species' plants in this Design (Select
 * them, Zoom to them) and Place. Each edition loads its own data and fills the body.
 */
export function SpeciesDetailLayout({ identity, favorite, favoriteLockedReason, onToggleFavorite, onBack, place, children }: {
  readonly identity: SpeciesDetailIdentity
  readonly favorite: boolean
  /** Why the favourite star is off (lists a newer Canopi saved, 2.1-Q320); the star stays focusable and shows it. */
  readonly favoriteLockedReason?: string
  readonly onToggleFavorite: () => void
  readonly onBack: () => void
  /** The species to place; null until the detail has loaded. */
  readonly place: PlantStampSourceInput | null
  readonly children: ComponentChildren
}) {
  const backRef = useRef<HTMLButtonElement>(null)
  const inDesign = useCatalogDesignSpecies().get(identity.canonicalName)
  const { canonicalName, commonName, englishName, family } = identity
  const englishFallback = !commonName && Boolean(englishName)
  const title = commonName || englishName || canonicalName
  const titleIsScientific = title === canonicalName
  const favoriteLabel = favorite
    ? t('plantDb.removeFavoriteNamed', { name: title })
    : t('plantDb.addFavoriteNamed', { name: title })

  // Opening the detail moves focus to Back, whichever list opened it.
  useLayoutEffect(() => { backRef.current?.focus({ preventScroll: true }) }, [])

  // The species' plants stay ringed on the map while its detail is open, so
  // Zoom to them shows which plants they are.
  const hasPlantsInDesign = Boolean(inDesign)
  // Placing plants never keeps a species ringed: the chooser rings a species only while its row is pointed at.
  const placing = currentCanvasTool.value === 'plant-stamp'
  useEffect(() => {
    if (!hasPlantsInDesign || placing) return undefined
    showSpeciesDetailOnMap(canonicalName)
    return clearSpeciesDetailOnMap
  }, [canonicalName, hasPlantsInDesign, placing])

  return (
    <article className={styles.detail} aria-label={title} data-testid="species-detail">
      <header className={styles.header}>
        <div className={styles.toolbar}>
          <button ref={backRef} type="button" data-detail-back className={styles.iconButton} aria-label={t('plantDetail.back')} onClick={onBack}>
            <ControlIcon name="chevron-left" size={18} />
            <ButtonTooltip label={t('plantDetail.back')} side="right" />
          </button>
          <span className={styles.toolbarSpacer} />
          <button
            type="button"
            className={`${styles.iconButton} ${favorite ? styles.favoriteOn : ''}`}
            aria-label={favoriteLabel}
            aria-pressed={favorite}
            aria-disabled={favoriteLockedReason ? true : undefined}
            onClick={favoriteLockedReason ? undefined : onToggleFavorite}
          >
            <ControlIcon name={favorite ? 'star' : 'star-outline'} size={18} />
            <ButtonTooltip label={favoriteLockedReason ?? favoriteLabel} side="left" />
          </button>
          <button type="button" className={styles.iconButton} aria-label={t('sidebar.close')} onClick={closeDockPanel}>
            <ControlIcon name="close" size={18} />
            <ButtonTooltip label={t('sidebar.close')} side="left" />
          </button>
        </div>
        <div className={styles.identity}>
          <span className={`${styles.glyph} ${inDesign ? '' : styles.glyphMuted}`} style={inDesign ? { color: inDesign.color } : undefined} aria-hidden="true">
            <PlantSymbolGlyph symbol={inDesign?.symbol ?? catalogHabitSymbol(identity.habitKey)} size={28} />
          </span>
          <div className={styles.names}>
            <h2 className={styles.title}>
              {titleIsScientific ? <i lang="la">{title}</i> : <SpeciesCommonName name={title} englishFallback={englishFallback} />}
            </h2>
            {(!titleIsScientific || family) && (
              <p className={styles.subtitle}>
                {!titleIsScientific && <i lang="la">{canonicalName}</i>}
                {!titleIsScientific && family && ' · '}
                {family}
              </p>
            )}
          </div>
          {inDesign && <span className={styles.code} title={t('plantDetail.codeInDesign')}>{inDesign.code}</span>}
        </div>
      </header>
      <div className={styles.body}>{children}</div>
      <footer className={styles.footer}>
        {inDesign && (
          <div className={styles.inDesign}>
            <span className={styles.inDesignCount}>{t('plantDetail.inThisDesign', { count: inDesign.count })}</span>
            <button type="button" className={styles.footerLink} onClick={() => selectSpeciesPlants([canonicalName])}>
              {t('plantDetail.selectThem', { count: inDesign.count })}
            </button>
            <button type="button" className={styles.footerLink} onClick={() => { zoomToSpeciesPlants([canonicalName]) }}>
              {t('speciesKey.zoomToThem')}
            </button>
          </div>
        )}
        <button
          type="button"
          className={styles.primary}
          disabled={place === null}
          aria-label={t('plantDb.placeSpecies', { name: title })}
          onClick={() => { if (place) placeSpeciesOnMap(place) }}
        >
          {t('plantDb.place')}
        </button>
      </footer>
    </article>
  )
}
