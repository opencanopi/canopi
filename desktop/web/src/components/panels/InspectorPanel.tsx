import { useEffect, useState } from 'preact/hooks'
import { closeInspector } from '../../app/planning-view/state'
import { locale, unitSystem } from '../../app/settings/state'
import {
  readPolygonDimensions,
  readRectOrEllipseDimensions,
  readSegmentDimensions,
} from '../../canvas/runtime/dimension-math'
import {
  currentCanvasQuerySurface,
  currentCanvasSceneEditCommandSurface,
} from '../../canvas/session'
import type { CanvasDesignObjectSelectionTarget, CanvasSceneEditCommandSurface } from '../../canvas/runtime/runtime'
import type {
  SceneAnnotationEntity,
  SceneMeasurementGuideEntity,
  ScenePersistedState,
  ScenePlantEntity,
  SceneZoneEntity,
} from '../../canvas/runtime/scene'
import type { SessionPlane } from '../../geo/session-plane'
import { t } from '../../i18n'
import { formatLength, formatNumber, formatPercent, parseQuantity } from '../../utils/format'
import { CanopiColorPicker } from '../canvas/CanopiColorPicker'
import styles from './InspectorPanel.module.css'

function InspectorTextField({
  id,
  label,
  formatted,
  parseAndCommit,
}: {
  readonly id: string
  readonly label: string
  readonly formatted: string
  readonly parseAndCommit: (raw: string) => boolean
}) {
  const [draft, setDraft] = useState(formatted)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setDraft(formatted)
    setInvalid(false)
  }, [formatted])

  const commit = () => {
    setInvalid(!parseAndCommit(draft))
  }

  return (
    <label className={styles.field} htmlFor={id}>
      <span className={styles.label}>{label}</span>
      <input
        id={id}
        type="text"
        className={styles.input}
        value={draft}
        aria-invalid={invalid ? 'true' : 'false'}
        onInput={(e) => {
          setDraft(e.currentTarget.value)
          setInvalid(false)
        }}
        onFocusOut={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </label>
  )
}

function DimensionField({
  id,
  label,
  valueM,
  onCommit,
}: {
  readonly id: string
  readonly label: string
  readonly valueM: number
  readonly onCommit: (meters: number) => void
}) {
  const unit = unitSystem.value
  const activeLocale = locale.value
  return (
    <InspectorTextField
      id={id}
      label={label}
      formatted={formatLength(valueM, unit, activeLocale)}
      parseAndCommit={(raw) => {
        const parsed = parseQuantity('length', raw, unit, activeLocale)
        if (parsed === null || parsed <= 0) return false
        onCommit(parsed)
        return true
      }}
    />
  )
}

function NumberField({
  id,
  label,
  value,
  decimals = 1,
  onCommit,
}: {
  readonly id: string
  readonly label: string
  readonly value: number
  readonly decimals?: number
  readonly onCommit: (next: number) => void
}) {
  return (
    <InspectorTextField
      id={id}
      label={label}
      formatted={formatNumber(value, locale.value, { maximumFractionDigits: decimals })}
      parseAndCommit={(raw) => {
        const n = Number(raw.replace(',', '.').trim())
        if (!Number.isFinite(n)) return false
        onCommit(n)
        return true
      }}
    />
  )
}

function ZoneDimensionsSection({
  zone,
  plane,
  edits,
}: {
  readonly zone: SceneZoneEntity
  readonly plane: SessionPlane
  readonly edits: CanvasSceneEditCommandSurface
}) {
  const rectDims = readRectOrEllipseDimensions(zone, plane)
  if (rectDims) {
    return (
      <div className={styles.grid}>
        <DimensionField id="inspector-width" label={t('inspector.width')} valueM={rectDims.widthM} onCommit={(widthM) => edits.editZoneDimensions(zone.id, { widthM })} />
        <DimensionField id="inspector-height" label={t('inspector.height')} valueM={rectDims.heightM} onCommit={(heightM) => edits.editZoneDimensions(zone.id, { heightM })} />
        <NumberField id="inspector-rotation" label={t('inspector.rotation')} value={rectDims.rotationDeg} onCommit={(rotationDeg) => edits.editZoneDimensions(zone.id, { rotationDeg })} />
        <NumberField id="inspector-center-lat" label={t('inspector.centerLat')} value={rectDims.center.lat} decimals={6} onCommit={(lat) => edits.editZoneDimensions(zone.id, { center: { lon: rectDims.center.lon, lat } })} />
        <NumberField id="inspector-center-lon" label={t('inspector.centerLon')} value={rectDims.center.lon} decimals={6} onCommit={(lon) => edits.editZoneDimensions(zone.id, { center: { lon, lat: rectDims.center.lat } })} />
      </div>
    )
  }
  const polyDims = readPolygonDimensions(zone, plane)
  if (polyDims) {
    return (
      <div className={styles.grid}>
        {polyDims.sideLengthsM.map((lenM, idx) => (
          <DimensionField key={`side-${idx}`} id={`inspector-side-${idx}`} label={t('inspector.side', { index: idx + 1 })} valueM={lenM} onCommit={(sideLengthM) => edits.editZoneDimensions(zone.id, { sideIndex: idx, sideLengthM })} />
        ))}
        {polyDims.interiorAnglesDeg.map((deg, idx) => (
          <NumberField key={`angle-${idx}`} id={`inspector-corner-${idx}`} label={t('inspector.cornerAngle', { index: idx + 1 })} value={deg} onCommit={(cornerAngleDeg) => edits.editZoneDimensions(zone.id, { cornerIndex: idx, cornerAngleDeg })} />
        ))}
        <NumberField id="inspector-center-lat" label={t('inspector.centerLat')} value={polyDims.center.lat} decimals={6} onCommit={(lat) => edits.editZoneDimensions(zone.id, { center: { lon: polyDims.center.lon, lat } })} />
        <NumberField id="inspector-center-lon" label={t('inspector.centerLon')} value={polyDims.center.lon} decimals={6} onCommit={(lon) => edits.editZoneDimensions(zone.id, { center: { lon, lat: polyDims.center.lat } })} />
      </div>
    )
  }
  if (zone.points.length < 2) return null
  const lineDims = readSegmentDimensions(zone.points[0]!, zone.points[zone.points.length - 1]!, plane)
  return (
    <div className={styles.grid}>
      <DimensionField id="inspector-length" label={t('inspector.length')} valueM={lineDims.lengthM} onCommit={(lengthM) => edits.editZoneDimensions(zone.id, { lengthM })} />
      <NumberField id="inspector-angle" label={t('inspector.angle')} value={lineDims.angleDeg} onCommit={(angleDeg) => edits.editZoneDimensions(zone.id, { angleDeg })} />
      <NumberField id="inspector-center-lat" label={t('inspector.centerLat')} value={lineDims.center.lat} decimals={6} onCommit={(lat) => edits.editZoneDimensions(zone.id, { center: { lon: lineDims.center.lon, lat } })} />
      <NumberField id="inspector-center-lon" label={t('inspector.centerLon')} value={lineDims.center.lon} decimals={6} onCommit={(lon) => edits.editZoneDimensions(zone.id, { center: { lon, lat: lineDims.center.lat } })} />
    </div>
  )
}

function ZoneStyleSection({ zone, edits }: { readonly zone: SceneZoneEntity; readonly edits: CanvasSceneEditCommandSurface }) {
  const opacity = typeof zone.opacity === 'number' ? zone.opacity : 1
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('inspector.style')}</h3>
      <div className={styles.styleRow}>
        <span className={styles.label}>{t('inspector.fillColor')}</span>
        <CanopiColorPicker value={zone.fillColor ?? '#4caf50'} onChange={(fillColor) => edits.setZoneStyle(zone.id, { fillColor })} />
      </div>
      <div className={styles.styleRow}>
        <span className={styles.label}>{t('inspector.strokeColor')}</span>
        <CanopiColorPicker value={zone.strokeColor ?? zone.fillColor ?? '#2e7d32'} onChange={(strokeColor) => edits.setZoneStyle(zone.id, { strokeColor })} />
      </div>
      <label className={styles.field} htmlFor="inspector-zone-opacity">
        <span className={styles.label}>{t('inspector.opacity')} ({formatPercent(opacity, locale.value)})</span>
        <input
          id="inspector-zone-opacity"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={opacity}
          onInput={(e) => {
            const v = Number(e.currentTarget.value)
            if (Number.isFinite(v)) edits.setZoneStyle(zone.id, { opacity: v })
          }}
        />
      </label>
    </section>
  )
}

function GuideInspectorSection({
  guide,
  plane,
  edits,
}: {
  readonly guide: SceneMeasurementGuideEntity
  readonly plane: SessionPlane
  readonly edits: CanvasSceneEditCommandSurface
}) {
  const dims = readSegmentDimensions(guide.start, guide.end, plane)
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('inspector.dimensions')}</h3>
      <div className={styles.grid}>
        <DimensionField id="inspector-guide-length" label={t('inspector.length')} valueM={dims.lengthM} onCommit={(lengthM) => edits.editMeasurementGuideDimensions(guide.id, { lengthM })} />
        <NumberField id="inspector-guide-angle" label={t('inspector.angle')} value={dims.angleDeg} onCommit={(angleDeg) => edits.editMeasurementGuideDimensions(guide.id, { angleDeg })} />
        <NumberField id="inspector-center-lat" label={t('inspector.centerLat')} value={dims.center.lat} decimals={6} onCommit={(lat) => edits.editMeasurementGuideDimensions(guide.id, { center: { lon: dims.center.lon, lat } })} />
        <NumberField id="inspector-center-lon" label={t('inspector.centerLon')} value={dims.center.lon} decimals={6} onCommit={(lon) => edits.editMeasurementGuideDimensions(guide.id, { center: { lon, lat: dims.center.lat } })} />
      </div>
    </section>
  )
}

function PlantInspectorSection({ plant, edits }: { readonly plant: ScenePlantEntity; readonly edits: CanvasSceneEditCommandSurface }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('inspector.dimensions')}</h3>
      <div className={styles.grid}>
        <DimensionField id="inspector-plant-spread" label={t('inspector.canopySpread')} valueM={plant.canopySpreadM ?? 0} onCommit={(canopySpreadM) => edits.editPlantFields(plant.id, { canopySpreadM })} />
        <NumberField id="inspector-plant-quantity" label={t('inspector.quantity')} value={plant.quantity ?? 1} decimals={0} onCommit={(q) => edits.editPlantFields(plant.id, { quantity: Math.max(1, Math.round(q)) })} />
      </div>
      <label className={styles.field} htmlFor="inspector-plant-date">
        <span className={styles.label}>{t('inspector.plantedDate')}</span>
        <input
          id="inspector-plant-date"
          type="date"
          className={styles.input}
          value={plant.plantedDate ?? ''}
          onInput={(e) => {
            const v = e.currentTarget.value.trim()
            edits.editPlantFields(plant.id, { plantedDate: v || null })
          }}
        />
      </label>
      <label className={styles.field} htmlFor="inspector-plant-notes">
        <span className={styles.label}>{t('inspector.notes')}</span>
        <textarea
          id="inspector-plant-notes"
          className={styles.textarea}
          rows={3}
          value={plant.notes ?? ''}
          onFocusOut={(e) => {
            const v = e.currentTarget.value.trim()
            edits.editPlantFields(plant.id, { notes: v || null })
          }}
        />
      </label>
    </section>
  )
}

function NoteInspectorSection({ note, edits }: { readonly note: SceneAnnotationEntity; readonly edits: CanvasSceneEditCommandSurface }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('inspector.dimensions')}</h3>
      <label className={styles.field} htmlFor="inspector-note-text">
        <span className={styles.label}>{t('inspector.noteText')}</span>
        <textarea
          id="inspector-note-text"
          className={styles.textarea}
          rows={3}
          value={note.text}
          onFocusOut={(e) => edits.editAnnotationFields(note.id, { text: e.currentTarget.value })}
        />
      </label>
      <NumberField id="inspector-note-font-size" label={t('inspector.fontSize')} value={note.fontSize} decimals={0} onCommit={(fontSize) => edits.editAnnotationFields(note.id, { fontSize })} />
    </section>
  )
}

function renderTargetInspector(
  target: CanvasDesignObjectSelectionTarget,
  persisted: ScenePersistedState,
  plane: SessionPlane,
  edits: CanvasSceneEditCommandSurface,
) {
  if (target.kind === 'zone') {
    const zone = persisted.zones.find((z) => z.id === target.id)
    if (!zone) return null
    return (
      <>
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('inspector.dimensions')}</h3>
          <ZoneDimensionsSection zone={zone} plane={plane} edits={edits} />
        </section>
        <ZoneStyleSection zone={zone} edits={edits} />
      </>
    )
  }
  if (target.kind === 'measurement-guide') {
    const guide = persisted.measurementGuides.find((g) => g.id === target.id)
    return guide ? <GuideInspectorSection guide={guide} plane={plane} edits={edits} /> : null
  }
  if (target.kind === 'plant') {
    const plant = persisted.plants.find((p) => p.id === target.id)
    return plant ? <PlantInspectorSection plant={plant} edits={edits} /> : null
  }
  if (target.kind === 'annotation') {
    const note = persisted.annotations.find((a) => a.id === target.id)
    return note ? <NoteInspectorSection note={note} edits={edits} /> : null
  }
  return null
}

/**
 * Docked Edit dimensions & Style inspector (panel on desktop, sheet on phones;
 * 2.1-Q149, 2.1-Q153, 2.1-Q160, 2.1-Q353, 2.1-Q355).
 * No typed target area; polygons expose side lengths, interior angles, and centre lat/lon only.
 */
export function InspectorPanel() {
  const queries = currentCanvasQuerySurface.value
  const edits = currentCanvasSceneEditCommandSurface.value
  void queries?.revision.scene.value
  const plane = queries?.sessionPlane?.value ?? null
  const selection = queries?.getDesignObjectSelection() ?? null
  const persisted = queries?.getSceneSnapshot() ?? null
  const primaryTarget = selection?.editableTargets.length === 1 ? selection.editableTargets[0]! : null
  const content = primaryTarget && persisted && plane && edits
    ? renderTargetInspector(primaryTarget, persisted, plane, edits)
    : null

  return (
    <aside className={styles.panel} data-inspector-panel aria-label={t('inspector.title')}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('inspector.title')}</h2>
        <button type="button" className={styles.closeButton} onClick={closeInspector}>
          {t('inspector.close')}
        </button>
      </header>
      <div className={styles.body}>{content ?? <p className={styles.empty}>{t('inspector.empty')}</p>}</div>
    </aside>
  )
}
