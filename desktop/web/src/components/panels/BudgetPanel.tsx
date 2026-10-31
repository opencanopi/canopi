import { useLayoutEffect, useRef } from 'preact/hooks'
import { useBudgetItemWorkbench } from '../../app/budget/workbench'
import type { BudgetSort } from '../../app/planning-view/state'
import { navigateTo } from '../../app/shell/state'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { formatCount } from '../../utils/format-count'
import { DockPanelHeader, closeDockPanel } from '../shared/DockPanelHeader'
import { Dropdown, type DropdownItem } from '../shared/Dropdown'
import { EmptyState } from '../shared/EmptyState'
import { PanelIcon } from '../shared/PanelIcon'
import { PlantFinder, QuickFilterChip, StratumFormFilters, finderHighlight, finderSummary } from '../shared/PlantFinder'
import { SpeciesIdentity } from '../shared/SpeciesIdentity'
import { PlantSymbolGlyph } from '../canvas/PlantSymbolGlyph'
import { displayedPlantColor } from '../../app/plant-display/state'
import { CURRENCY_ITEMS } from '../canvas/budget-currencies'
import row from '../shared/species-row.module.css'
import styles from './BudgetPanel.module.css'

export function BudgetPanel() {
  const workbench = useBudgetItemWorkbench()
  const scrollRef = useRef<HTMLUListElement>(null)
  const { projection, list, finder } = workbench
  const sortItems: DropdownItem<BudgetSort>[] = [
    { value: 'name', label: t('canvas.budget.sortName') },
    { value: 'highest-total', label: t('canvas.budget.sortHighestTotal') },
    { value: 'most-plants', label: t('canvas.budget.sortMostPlants') },
  ]
  const sortLabel = sortItems.find((item) => item.value === workbench.sort)?.label ?? ''

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = workbench.scrollTop
  }, [workbench.scrollTop])
  // Enter moves the editor to the next row; move focus with it.
  useLayoutEffect(() => {
    if (workbench.editingCanonical === null) return
    const input = document.getElementById(priceInputId(workbench.editingCanonical))
    if (input && document.activeElement !== input && scrollRef.current?.contains(document.activeElement)) {
      (input as HTMLInputElement).focus()
      ;(input as HTMLInputElement).select()
    }
  }, [workbench.editingCanonical])
  // Set unit cost… from the map focuses the requested price wherever focus was.
  useLayoutEffect(() => {
    if (workbench.priceFocusRequest === 0 || workbench.editingCanonical === null) return
    const input = document.getElementById(priceInputId(workbench.editingCanonical)) as HTMLInputElement | null
    input?.scrollIntoView?.({ block: 'nearest' })
    input?.focus()
    input?.select()
  }, [workbench.priceFocusRequest])

  const filtered = finder.active || workbench.selectedOnMap || workbench.missingPriceOnly || workbench.quickFilters.allowed !== null
  const listPlants = list.rows.reduce((sum, item) => sum + item.count, 0)

  return (
    <section
      className={styles.panel}
      aria-label={t('canvas.budget.title')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || workbench.editingCanonical !== null) return
        event.preventDefault()
        event.stopPropagation()
        closeDockPanel()
      }}
    >
      <DockPanelHeader title={t('canvas.budget.title')} />
      {projection.rows.length === 0 ? (
        <EmptyState icon={<PanelIcon panel="budget" />} action={{ label: t('speciesKey.openCatalog'), onClick: () => navigateTo('plant-db') }}>
          {t('canvas.budget.emptyCanvas')}
        </EmptyState>
      ) : <>
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
            filters={<>
              <StratumFormFilters filters={workbench.quickFilters} onChange={workbench.setQuickFilters} />
              <QuickFilterChip
                pressed={workbench.missingPriceOnly}
                onChange={workbench.setMissingPriceOnly}
                label={t('canvas.budget.missingPrice', { count: workbench.missingPriceCount })}
              />
              <Dropdown
                className={styles.sort}
                trigger={t('canvas.budget.sortTrigger', { sort: sortLabel })}
                items={sortItems}
                value={workbench.sort}
                onChange={workbench.setSort}
                ariaLabel={t('canvas.budget.sortLabel')}
              />
            </>}
            summary={filtered ? finderSummary(list.rows.length, listPlants, workbench.selectedOnMap) : undefined}
          />
        </div>

        {list.rows.length === 0 ? (
          <EmptyState status action={{ label: t('canvas.budget.clearFilters'), onClick: workbench.clearFilters }}>
            {t('canvas.budget.noResults')}
          </EmptyState>
        ) : <>
          <div className={`${row.columns} ${styles.columns}`} aria-hidden="true">
            <span className={styles.plantsCaption}>{t('canvas.budget.plants')}</span>
            <span className={styles.priceCaption}>{t('canvas.budget.unitCost')}</span>
            <span className={styles.totalCaption}>{t('canvas.budget.lineTotal')}</span>
          </div>
          <ul
            ref={scrollRef}
            className={styles.list}
            onScroll={(event) => workbench.setScrollTop(event.currentTarget.scrollTop)}
            onMouseLeave={workbench.clearHover}
          >
            {list.rows.map((item) => {
              const name = item.commonName || item.canonical
              const editing = workbench.editingCanonical === item.canonical
              const inputId = priceInputId(item.canonical)
              const errorId = `${inputId}-error`
              const invalid = editing && workbench.priceInvalid
              return (
                <li
                  key={item.canonical}
                  className={`${row.row} ${styles.row}`}
                  data-selected={workbench.focusedCanonical === item.canonical}
                  onMouseEnter={() => workbench.hoverRow(item)}
                  onMouseLeave={workbench.clearHover}
                >
                  <button
                    type="button"
                    className={`${row.main} ${styles.rowMain}`}
                    aria-pressed={workbench.focusedCanonical === item.canonical}
                    onClick={() => workbench.toggleSpeciesFocus(item.canonical)}
                  >
                    <span className={row.glyph} aria-hidden="true">
                      {item.appearances.slice(0, 1).map((appearance) => (
                        <span key={`${appearance.color}:${appearance.symbol}`} style={{ color: displayedPlantColor(appearance.color, item.canonical) }}>
                          <PlantSymbolGlyph symbol={appearance.symbol} size={22} />
                        </span>
                      ))}
                    </span>
                    <SpeciesIdentity
                      commonName={item.commonName}
                      canonicalName={item.canonical}
                      englishFallback={item.englishFallback}
                      highlight={finderHighlight(finder.byKey.get(item.canonical))}
                    />
                    <span className={row.code}>{item.code}</span>
                    <span className={styles.plantsColumn}>{formatCount(item.count, locale.value)}</span>
                  </button>
                  <span className={styles.priceField} data-invalid={invalid ? 'true' : undefined}>
                    <span className={styles.currency} aria-hidden="true">{workbench.currencySymbol}</span>
                    <input
                      id={inputId}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      className={styles.priceInput}
                      value={workbench.priceInputValue(item)}
                      placeholder="—"
                      aria-label={t('canvas.budget.priceFor', { name })}
                      aria-invalid={invalid}
                      aria-describedby={invalid ? errorId : undefined}
                      onFocusIn={(event) => {
                        workbench.startPriceEdit(item.canonical)
                        event.currentTarget.select()
                      }}
                      onInput={(event) => {
                        // Enter on the last row and Escape end the edit but keep focus here;
                        // typing again starts a fresh edit instead of being discarded.
                        if (!editing) workbench.startPriceEdit(item.canonical)
                        workbench.setEditPrice(event.currentTarget.value)
                      }}
                      onFocusOut={() => workbench.commitPriceEdit(item.canonical)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          workbench.commitPriceEdit(item.canonical, true)
                        }
                        if (event.key === 'Escape' && editing) {
                          event.preventDefault()
                          event.stopPropagation()
                          workbench.cancelPriceEdit()
                        }
                      }}
                    />
                  </span>
                  <strong className={styles.totalColumn} data-empty={item.hasPrice ? undefined : 'true'}>
                    {item.hasPrice ? workbench.formatCurrency(item.subtotal) : t('canvas.budget.noPrice')}
                  </strong>
                  {invalid && (
                    <span id={errorId} className={styles.validation} role="alert">
                      {t('canvas.budget.priceError')}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </>}
      </>}

      <footer className={styles.footer}>
        <div className={styles.totalLine}>
          <span className={styles.coverage}>{t('canvas.budget.coverage', {
            plants: t('plantFinder.plants', { count: projection.totalPlants }),
            priced: projection.pricedCount,
            total: projection.rows.length,
          })}</span>
          <strong className={styles.grandTotal}>{workbench.formatCurrency(projection.grandTotal)}</strong>
        </div>
        {list.restricted && projection.rows.length > 0 && (
          <div className={styles.shownLine}>
            <span>{t('canvas.budget.shownSubtotal')}</span>
            <strong>{workbench.formatCurrency(list.shownSubtotal)}</strong>
          </div>
        )}
        {projection.rows.length > 0 && (
          <button
            type="button"
            className={styles.meterButton}
            aria-pressed={workbench.missingPriceOnly}
            aria-label={t('canvas.budget.showMissing', { priced: projection.pricedCount, total: projection.rows.length })}
            onClick={() => workbench.setMissingPriceOnly(!workbench.missingPriceOnly)}
          >
            <span
              className={styles.meter}
              role="meter"
              aria-valuenow={projection.pricedCount}
              aria-valuemin={0}
              aria-valuemax={projection.rows.length}
            >
              <span className={styles.meterFill} style={{ width: `${(projection.pricedCount / projection.rows.length) * 100}%` }} />
            </span>
          </button>
        )}
        <div className={styles.footerActions}>
          <Dropdown
            trigger={CURRENCY_ITEMS.find((item) => item.value === workbench.currency)?.label ?? workbench.currency}
            items={CURRENCY_ITEMS}
            value={workbench.currency}
            onChange={workbench.setCurrency}
            menuDirection="up"
            ariaLabel={t('canvas.budget.currencyLabel')}
          />
          <button
            type="button"
            className={styles.exportButton}
            onClick={() => { void workbench.exportCsv() }}
            disabled={workbench.exportPending}
          >
            {workbench.exportPending ? t('canvas.budget.exporting') : t('canvas.budget.exportAllCSV')}
          </button>
        </div>
        <p className={styles.currencyHelp}>{t('canvas.budget.currencyHelp')}</p>
        {workbench.exportFailed && (
          <div className={styles.exportError} role="alert">
            <span>{t('canvas.budget.exportFailed')}</span>
            <button type="button" onClick={() => { void workbench.exportCsv() }}>
              {t('canvas.budget.retryExport')}
            </button>
          </div>
        )}
      </footer>
    </section>
  )
}

function priceInputId(canonical: string): string {
  return `budget-price-${encodeURIComponent(canonical)}`
}
