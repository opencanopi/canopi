import { useCallback, useEffect, useState } from 'preact/hooks'
import { t } from '../../i18n'
import {
  communityView,
  importTemplateIntoCurrentSession,
  loadTemplateCatalog,
  selectTemplate,
  setClimateFilter,
  setStyleFilter,
} from '../../app/community/controller'
import type { TemplateMeta } from '../../types/community'
import styles from './WorldMapPanel.module.css'
import type { WorldMapSurface } from '../world-map/WorldMapSurface'

type SurfaceComponent = typeof WorldMapSurface

function getClimateZones(catalog: TemplateMeta[]): string[] {
  return Array.from(new Set(catalog.map((template) => template.climate_zone))).sort()
}

function getStyleTags(catalog: TemplateMeta[]): string[] {
  const tags = new Set<string>()
  for (const template of catalog) {
    for (const tag of template.tags) tags.add(tag)
  }
  return Array.from(tags).sort()
}

function getFilteredCatalog(
  catalog: TemplateMeta[],
  climate: string,
  style: string,
): TemplateMeta[] {
  return catalog.filter((template) => {
    if (climate && template.climate_zone !== climate) return false
    if (style && !template.tags.includes(style)) return false
    return true
  })
}

function FilterChips({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: string[]
  value: string
  onChange: (value: string) => void
}) {
  if (options.length === 0) return null

  return (
    <div className={styles.chipGroup}>
      <span className={styles.chipLabel}>{label}</span>
      <div className={styles.chips}>
        <button
          type="button"
          className={`${styles.chip} ${value === '' ? styles.chipActive : ''}`}
          onClick={() => onChange('')}
        >
          {t('worldMap.featured')}
        </button>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`${styles.chip} ${value === option ? styles.chipActive : ''}`}
            onClick={() => onChange(value === option ? '' : option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}

export function WorldMapPanel() {
  const [Surface, setSurface] = useState<SurfaceComponent | null>(null)
  const { catalog, loading, error, selected, climate, style, importPending, importError } = communityView.value

  useEffect(() => {
    void loadTemplateCatalog()
  }, [])

  useEffect(() => {
    let cancelled = false

    void import('../world-map/WorldMapSurface').then((module) => {
      if (!cancelled) {
        setSurface(() => module.WorldMapSurface)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  const handleSelect = useCallback((template: TemplateMeta) => {
    void selectTemplate(template)
  }, [])

  const filteredCatalog = getFilteredCatalog(catalog, climate, style)
  const climateZones = getClimateZones(catalog)
  const styleTags = getStyleTags(catalog)

  return (
    <div className={styles.panel}>
      <div className={styles.section}>
        <h2 className={styles.title}>{t('worldMap.title')}</h2>
        <p className={styles.summary}>{t('worldMap.discover')}</p>
      </div>

      <div className={styles.section}>
        <FilterChips
          label={t('worldMap.filterByClimate')}
          options={climateZones}
          value={climate}
          onChange={setClimateFilter}
        />
        <FilterChips
          label={t('worldMap.filterByStyle')}
          options={styleTags}
          value={style}
          onChange={setStyleFilter}
        />
      </div>

      <div className={styles.surfaceShell}>
        {Surface ? (
          <Surface
            templates={filteredCatalog}
            selectedId={selected?.id ?? null}
            onSelect={handleSelect}
          />
        ) : (
          <div className={styles.surfaceFallback}>{t('worldMap.zoomToExplore')}</div>
        )}
      </div>

      {error && <p className={styles.errorText}>{error}</p>}
      {importError && <p className={styles.errorText}>{importError}</p>}

      {selected && (
        <div className={styles.previewCard}>
          <div className={styles.previewHeader}>
            <div>
              <h3 className={styles.previewTitle}>{selected.title}</h3>
              <p className={styles.previewAuthor}>{t('worldMap.author', { author: selected.author })}</p>
            </div>
            <button
              type="button"
              className={styles.previewClose}
              onClick={() => { void selectTemplate(null) }}
              aria-label={t('canvas.file.cancel')}
            >
              ×
            </button>
          </div>
          <p className={styles.previewDescription}>{selected.description}</p>
          <div className={styles.previewMeta}>
            <span>{t('plantFinder.plants', { count: selected.plant_count })}</span>
            <span>{selected.climate_zone}</span>
          </div>
          <button
            type="button"
            className={styles.importButton}
            disabled={importPending}
            onClick={() => { void importTemplateIntoCurrentSession(selected) }}
          >
            {importPending ? t('worldMap.downloading') : t('worldMap.openTemplate')}
          </button>
        </div>
      )}

      <div className={styles.templateList}>
        {loading && <p className={styles.emptyText}>{t('plantDb.loading')}</p>}
        {!loading && filteredCatalog.length === 0 && (
          <p className={styles.emptyText}>{t('worldMap.noDesigns')}</p>
        )}
        {!loading && filteredCatalog.map((template) => (
          <button
            key={template.id}
            type="button"
            className={`${styles.templateCard} ${selected?.id === template.id ? styles.templateCardActive : ''}`}
            onClick={() => { void selectTemplate(template) }}
          >
            <span className={styles.templateName}>{template.title}</span>
            <span className={styles.templateMeta}>
              {t('worldMap.author', { author: template.author })}
            </span>
            <span className={styles.templateMeta}>
              {t('plantFinder.plants', { count: template.plant_count })}
            </span>
            <span className={styles.templateZone}>{template.climate_zone}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
