import { useLayoutEffect, useRef } from 'preact/hooks'
import {
  supportedConsortiumStratum,
  useConsortiumDockWorkbench,
} from '../../app/consortium/dock-workbench'
import {
  CONSORTIUM_STRATA,
  CONSORTIUM_SUCCESSION_PHASES,
  type SuccessionPhaseDefinition,
} from '../../planning/time-model'
import type { ConsortiumListFilter } from '../../app/planning-view/state'
import type { ConsortiumPlanningRow } from '../../app/planning-projection'
import { navigateTo } from '../../app/shell/state'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { formatCount } from '../../utils/format-count'
import { ControlIcon } from '../shared/ControlIcon'
import { DockPanelHeader, closeDockPanel } from '../shared/DockPanelHeader'
import { Dropdown, type DropdownItem } from '../shared/Dropdown'
import { EmptyState } from '../shared/EmptyState'
import { PanelIcon } from '../shared/PanelIcon'
import { PlantFinder, StratumFormFilters, finderHighlight } from '../shared/PlantFinder'
import { SpeciesIdentity } from '../shared/SpeciesIdentity'
import { PlantSymbolGlyph } from '../canvas/PlantSymbolGlyph'
import { displayedPlantColor } from '../../app/plant-display/state'
import row from '../shared/species-row.module.css'
import styles from './ConsortiumPanel.module.css'

const UNASSIGNED = 'unassigned'
const PHASE_GROUPS = [
  { key: 'placenta', labelKey: 'canvas.consortium.phaseGroupPlacenta' },
  { key: 'secondaire', labelKey: 'canvas.consortium.phaseGroupSecondary' },
  { key: 'climax', labelKey: 'canvas.consortium.phaseGroupClimax' },
] as const

export function ConsortiumPanel() {
  const workbench = useConsortiumDockWorkbench()
  const scrollRef = useRef<HTMLDivElement>(null)
  const filterSummaryRef = useRef<HTMLButtonElement>(null)
  const cancelledEditorFocus = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = workbench.scrollTop
  }, [workbench.scrollTop])
  useLayoutEffect(() => {
    if (workbench.movedOutsideFilter) filterSummaryRef.current?.focus()
  }, [workbench.movedOutsideFilter])
  useLayoutEffect(() => {
    if (workbench.editor !== null || cancelledEditorFocus.current === null) return
    document.querySelector<HTMLButtonElement>(
      `button[data-consortium-edit="${encodeURIComponent(cancelledEditorFocus.current)}"]`,
    )?.focus()
    cancelledEditorFocus.current = null
  }, [workbench.editor])

  function cancelEditorAndRestoreFocus(): void {
    const canonicalName = workbench.editor?.canonicalName
    if (canonicalName) cancelledEditorFocus.current = canonicalName
    workbench.cancelEditor()
  }

  const { projection, finder } = workbench
  const withoutStratum = projection.rows.filter((item) => item.stratum === UNASSIGNED).length
  const matchedCells = countMatchedCells(workbench)

  return (
    <section
      className={styles.panel}
      aria-label={t('canvas.consortium.title')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        if (workbench.editor) {
          cancelEditorAndRestoreFocus()
          return
        }
        closeDockPanel()
      }}
    >
      <DockPanelHeader title={t('canvas.consortium.title')} />
      {projection.activeSpeciesCount === 0 ? (
        <EmptyState icon={<PanelIcon panel="consortium" />} action={{ label: t('speciesKey.openCatalog'), onClick: () => navigateTo('plant-db') }}>
          {t('canvas.consortium.empty')}
        </EmptyState>
      ) : (
        <>
          <p className={styles.subtitle}>
            {t('plantFinder.species', { count: projection.activeSpeciesCount })}
            {withoutStratum > 0 && <>
              {' · '}
              <button
                type="button"
                className={styles.inlineLink}
                aria-pressed={workbench.filter?.stratum === UNASSIGNED}
                onClick={() => workbench.setFilter(workbench.filter?.stratum === UNASSIGNED ? null : { stratum: UNASSIGNED, phase: null })}
              >{t('canvas.consortium.noStratumYet', { count: withoutStratum })}</button>
            </>}
          </p>
          <div className={styles.controls}>
            <PlantFinder
              value={workbench.search}
              onChange={workbench.setSearch}
              correction={finder.correction}
              selectedOnMap={{
                pressed: workbench.selectedOnMap,
                plantCount: workbench.mapSelectionPlantCount,
                onChange: workbench.setSelectedOnMap,
              }}
              filters={<StratumFormFilters filters={workbench.quickFilters} onChange={workbench.setQuickFilters} />}
              summary={workbench.highlightedSpecies
                ? t('canvas.consortium.foundInCells', {
                  count: matchedCells,
                  species: t('plantFinder.species', { count: workbench.highlightedSpecies.size }),
                })
                : undefined}
            />
          </div>
          <div ref={scrollRef} className={styles.scroll} onScroll={(event) => workbench.setScrollTop(event.currentTarget.scrollTop)}>
            <ConsortiumMatrix workbench={workbench} />
            <div className={styles.listHead}>
              <ListHeading workbench={workbench} filterSummaryRef={filterSummaryRef} />
              {workbench.movedOutsideFilter && (
                <p className={styles.confirmation} role="status">
                  {t('canvas.consortium.movedOutsideFilter')}
                </p>
              )}
            </div>
            {workbench.list.visibleCount === 0 ? (
              <EmptyState status action={{ label: t('canvas.consortium.clearFilters'), onClick: workbench.clearFilters }}>
                {t('canvas.consortium.noResults')}
              </EmptyState>
            ) : (
              <div className={styles.list} onMouseLeave={workbench.clearHover}>
                {workbench.list.groups.map((group) => {
                  const expanded = workbench.list.restricted || workbench.expandedStrata.has(group.stratum)
                  return (
                    <section key={group.stratum} className={styles.group}>
                      <button
                        type="button"
                        className={styles.groupHeader}
                        aria-expanded={expanded}
                        onClick={() => workbench.toggleStratum(group.stratum)}
                      >
                        <ControlIcon name={expanded ? 'chevron-down' : 'chevron-right'} />
                        <span className={styles.groupName}>{stratumLabel(group.stratum)}</span>
                        <small>{t('canvas.consortium.groupCounts', {
                          species: t('plantFinder.species', { count: group.speciesCount }),
                          plants: t('plantFinder.plants', { count: group.plantCount }),
                        })}</small>
                      </button>
                      {expanded && group.rows.length > 0 && (
                        <div className={styles.columns} aria-hidden="true">
                          <span className={styles.countColumn}>{t('canvas.consortium.plants')}</span>
                          <span className={styles.phaseColumn}>{t('canvas.consortium.phases')}</span>
                        </div>
                      )}
                      {expanded && group.rows.map((item) => (
                        workbench.editor?.canonicalName === item.canonicalName
                          ? <ConsortiumRowEditor key={item.canonicalName} row={item} workbench={workbench} onCancel={cancelEditorAndRestoreFocus} />
                          : <ConsortiumRow key={item.canonicalName} row={item} workbench={workbench} />
                      ))}
                    </section>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

type Workbench = ReturnType<typeof useConsortiumDockWorkbench>

function ListHeading({ workbench, filterSummaryRef }: {
  workbench: Workbench
  filterSummaryRef: { current: HTMLButtonElement | null }
}) {
  if (workbench.filter) {
    return (
      <button
        ref={filterSummaryRef}
        type="button"
        className={styles.filterChip}
        aria-label={t('canvas.consortium.clearCellFilter', { filter: filterLabel(workbench.filter) })}
        onClick={() => {
          workbench.setFilter(null)
          workbench.dismissMovedConfirmation()
        }}
      >
        {filterLabel(workbench.filter)}
        <ControlIcon name="close" />
      </button>
    )
  }
  if (workbench.finder.active) {
    return <div className={styles.matchHeading}>
      <h3>{t('canvas.consortium.matching', {
        query: workbench.finder.correction ?? workbench.search.trim(),
        species: t('plantFinder.species', { count: workbench.list.visibleCount }),
      })}</h3>
      <button type="button" className={styles.inlineLink} onClick={() => workbench.setSearch('')}>
        {t('canvas.consortium.clearMatches')}
      </button>
    </div>
  }
  return <p className={styles.legend}>{t('canvas.consortium.matrixLegend')}</p>
}

function ConsortiumMatrix({ workbench }: { workbench: Workbench }) {
  const strata = workbench.projection.matrix.filter((item) => item.stratum !== UNASSIGNED)
  return (
    <div className={styles.matrixRegion}>
      <table className={styles.matrix}>
        <caption className={row.srOnly}>{t('canvas.consortium.matrixCaption')}</caption>
        <colgroup><col className={styles.stratumColumn} /></colgroup>
        {PHASE_GROUPS.map((group) => (
          <colgroup key={group.key} span={phasesOf(group.key).length} />
        ))}
        <thead>
          <tr>
            <td />
            {PHASE_GROUPS.map((group) => (
              <th key={group.key} scope="colgroup" colSpan={phasesOf(group.key).length} className={styles.phaseGroup}>
                {t(group.labelKey)}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col" className={row.srOnly}>{t('canvas.consortium.stratum')}</th>
            {CONSORTIUM_SUCCESSION_PHASES.map((phase) => (
              <th key={phase.key} scope="col" className={styles.phaseHeader}>
                <span className={row.srOnly}>{t(phase.labelKey)}, </span>
                <span className={styles.phaseNumber} aria-hidden="true">{phaseNumber(phase)}</span>
                <span className={styles.phaseDuration}>{t(phase.durationKey)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strata.map((item) => (
            <tr key={item.stratum}>
              <th scope="row">
                <button
                  type="button"
                  className={styles.stratumButton}
                  aria-pressed={workbench.filter?.stratum === item.stratum && workbench.filter.phase === null}
                  onMouseEnter={() => workbench.hoverRows(workbench.projection.rows.filter((entry) => entry.stratum === item.stratum))}
                  onMouseLeave={workbench.clearHover}
                  onClick={() => workbench.setFilter(sameFilter(workbench.filter, item.stratum, null)
                    ? null
                    : { stratum: item.stratum, phase: null })}
                >{stratumLabel(item.stratum)}</button>
              </th>
              {item.counts.map((count, phase) => {
                const selected = sameFilter(workbench.filter, item.stratum, phase)
                const cellRows = rowsInCell(workbench.projection.rows, item.stratum, phase)
                const match = Boolean(workbench.highlightedSpecies && cellRows.some((entry) => workbench.highlightedSpecies!.has(entry.canonicalName)))
                const definition = CONSORTIUM_SUCCESSION_PHASES[phase]!
                return (
                  <td key={phase}>
                    <button
                      type="button"
                      className={styles.cell}
                      data-level={heatLevel(count)}
                      aria-label={t(match ? 'canvas.consortium.cellWithMatch' : 'canvas.consortium.cell', {
                        stratum: stratumLabel(item.stratum),
                        phase: t(definition.labelKey),
                        duration: t(definition.durationKey),
                        species: t('plantFinder.species', { count }),
                      })}
                      aria-pressed={selected}
                      onMouseEnter={() => workbench.hoverRows(cellRows)}
                      onMouseLeave={workbench.clearHover}
                      onClick={() => workbench.setFilter(selected ? null : { stratum: item.stratum, phase })}
                    >
                      {count === 0 ? '·' : count}
                      {match && <span className={styles.matchDot} data-match-dot aria-hidden="true" />}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ConsortiumRow({ row: item, workbench }: { row: ConsortiumPlanningRow; workbench: Workbench }) {
  return (
    <article
      className={`${row.row} ${styles.row}`}
      data-selected={workbench.focusedCanonical === item.canonicalName}
      onMouseEnter={() => workbench.hoverRow(item)}
      onMouseLeave={workbench.clearHover}
    >
      <button
        type="button"
        className={row.main}
        aria-pressed={workbench.focusedCanonical === item.canonicalName}
        onClick={() => workbench.toggleSpeciesFocus(item.canonicalName)}
      >
        <span className={row.srOnly}>{t('canvas.consortium.showOnMap')} </span>
        <span className={row.glyph} aria-hidden="true">
          {item.appearances.slice(0, 1).map((appearance) => (
            <span key={`${appearance.color}:${appearance.symbol}`} style={{ color: displayedPlantColor(appearance.color, item.canonicalName) }}>
              <PlantSymbolGlyph symbol={appearance.symbol} size={22} />
            </span>
          ))}
        </span>
        <SpeciesIdentity
          commonName={item.commonName}
          canonicalName={item.canonicalName}
          englishFallback={item.englishFallback}
          highlight={finderHighlight(workbench.finder.byKey.get(item.canonicalName))}
        />
        <span className={row.code}>{item.code}</span>
        <span className={styles.countColumn}>{formatCount(item.count, locale.value)}</span>
      </button>
      <span className={styles.phaseColumn}>{phaseSpanLabel(item.startPhase, item.endPhase)}</span>
      <button
        type="button"
        className={styles.editButton}
        data-consortium-edit={encodeURIComponent(item.canonicalName)}
        aria-label={t('canvas.consortium.editSpecies', { name: item.commonName })}
        onClick={() => workbench.openEditor(item)}
      >{t('canvas.consortium.edit')}</button>
    </article>
  )
}

function ConsortiumRowEditor({ row: item, workbench, onCancel }: { row: ConsortiumPlanningRow; workbench: Workbench; onCancel: () => void }) {
  const draft = workbench.editor!.draft
  const stratumItems: DropdownItem<string>[] = [
    ...(!supportedConsortiumStratum(draft.stratum)
      ? [{ value: draft.stratum, label: `${draft.stratum} · ${t('canvas.consortium.unsupported')}` }]
      : []),
    ...CONSORTIUM_STRATA.map((stratum) => ({ value: stratum, label: stratumLabel(stratum) })),
  ]
  const phaseItems: DropdownItem<number>[] = CONSORTIUM_SUCCESSION_PHASES.map((phase, index) => ({
    value: index,
    label: `${t(phase.labelKey)} · ${t(phase.durationKey)}`,
  }))
  return (
    <article className={styles.rowEditor}>
      <SpeciesIdentity commonName={item.commonName} canonicalName={item.canonicalName} englishFallback={item.englishFallback} />
      <div className={styles.editorFields}>
        <div className={styles.editorField}>
          <span>{t('canvas.consortium.stratum')}</span>
          <Dropdown
            trigger={stratumItems.find((option) => option.value === draft.stratum)?.label}
            items={stratumItems}
            value={draft.stratum}
            onChange={(stratum) => workbench.updateDraft({ stratum })}
            ariaLabel={t('canvas.consortium.stratum')}
            floating
          />
        </div>
        <div className={styles.editorField}>
          <span>{t('canvas.consortium.firstPhase')}</span>
          <Dropdown
            trigger={phaseItems[draft.startPhase]?.label ?? String(draft.startPhase)}
            items={phaseItems}
            value={draft.startPhase}
            onChange={(startPhase) => workbench.updateDraft({ startPhase })}
            ariaLabel={t('canvas.consortium.firstPhase')}
            floating
          />
        </div>
        <div className={styles.editorField}>
          <span>{t('canvas.consortium.lastPhase')}</span>
          <Dropdown
            trigger={phaseItems[draft.endPhase]?.label ?? String(draft.endPhase)}
            items={phaseItems}
            value={draft.endPhase}
            onChange={(endPhase) => workbench.updateDraft({ endPhase })}
            ariaLabel={t('canvas.consortium.lastPhase')}
            floating
          />
        </div>
        {workbench.editorInvalid && (
          <p className={styles.validation} role="alert">{t('canvas.consortium.phaseError')}</p>
        )}
      </div>
      <div className={styles.editorActions}>
        <button type="button" onClick={onCancel}>{t('canvas.timeline.cancel')}</button>
        <button type="button" className={styles.primaryButton} onClick={workbench.saveEditor}>{t('canvas.timeline.save')}</button>
      </div>
    </article>
  )
}

/** Species-count steps of the bark heat ramp (Consortium board). */
function heatLevel(count: number): number {
  if (count <= 0) return 0
  if (count <= 5) return 1
  if (count <= 10) return 2
  if (count <= 15) return 3
  return count <= 20 ? 4 : 5
}

function countMatchedCells(workbench: Workbench): number {
  const species = workbench.highlightedSpecies
  if (!species) return 0
  let cells = 0
  for (const item of workbench.projection.matrix) {
    if (item.stratum === UNASSIGNED) continue
    item.counts.forEach((_, phase) => {
      if (rowsInCell(workbench.projection.rows, item.stratum, phase).some((entry) => species.has(entry.canonicalName))) cells += 1
    })
  }
  return cells
}

function rowsInCell(rows: readonly ConsortiumPlanningRow[], stratum: string, phase: number): ConsortiumPlanningRow[] {
  return rows.filter((entry) => entry.stratum === stratum && entry.startPhase <= phase && entry.endPhase >= phase)
}

function phasesOf(groupKey: string): readonly SuccessionPhaseDefinition[] {
  return CONSORTIUM_SUCCESSION_PHASES.filter((phase) => phase.key.startsWith(groupKey))
}

function phaseNumber(phase: SuccessionPhaseDefinition): string {
  const digit = phase.key.at(-1)
  return digit && /\d/.test(digit) ? digit : ''
}

function sameFilter(filter: ConsortiumListFilter | null, stratum: string, phase: number | null): boolean {
  return filter?.stratum === stratum && filter.phase === phase
}

function filterLabel(filter: ConsortiumListFilter): string {
  const stratum = stratumLabel(filter.stratum)
  return filter.phase === null
    ? stratum
    : `${stratum} · ${t(CONSORTIUM_SUCCESSION_PHASES[filter.phase]!.labelKey)}`
}

function stratumLabel(stratum: string): string {
  return supportedConsortiumStratum(stratum)
    ? t(`canvas.consortium.${stratum}`)
    : t('canvas.consortium.unsupportedStratum', { value: stratum })
}

function phaseSpanLabel(start: number, end: number): string {
  const first = CONSORTIUM_SUCCESSION_PHASES[start]
  const last = CONSORTIUM_SUCCESSION_PHASES[end]
  if (!first || !last) return `${start}–${end}`
  return start === end ? t(first.labelKey) : `${t(first.labelKey)} → ${t(last.labelKey)}`
}

