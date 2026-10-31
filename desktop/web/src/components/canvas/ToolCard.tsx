import type { FunctionComponent } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { armCanvasTool } from '../../app/keyboard/arming'
import { focusOwner } from '../../app/keyboard/focus-owner'
import { useEnglishFallbackNames } from '../../app/plant-finder/catalog-names'
import { toolCardContent, type SavedStampSummary } from '../../app/tool-card/content'
import { modKeyName } from '../../app/shell-commands/shortcut-text'
import { siteLocateOpen } from '../../app/site-onboarding/state'
import { phoneLayout, phoneToolOptions } from '../../app/shell/phone-layout'
import { readPlantStampSource, type PlantStampSource } from '../../canvas/plant-stamp-source'
import { speciesPlacementAppearance } from '../../canvas/runtime/species-key'
import type { PlantSymbolId } from '../../canvas/runtime/scene'
import {
  readSavedObjectStampName,
  readSavedObjectStampSource,
} from '../../canvas/saved-object-stamp-source'
import {
  currentCanvasQuerySurface,
  currentCanvasTool,
  currentCanvasToolCommandSurface,
  currentCanvasToolGuidance,
} from '../../canvas/session'
import type { CanvasPlantRowGuidance, CanvasToolGuidance } from '../../canvas/session-state'
import { scrollWheel } from '../../app/settings/state'
import { t } from '../../i18n'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon } from '../shared/ControlIcon'
import { SpeciesCommonName } from '../shared/SpeciesIdentity'
import { PlantSymbolGlyph } from './PlantSymbolGlyph'
import { SpeciesChooser } from './SpeciesChooser'
import { ToolIcon } from './toolbar-icons'
import { useCoarsePointer } from '../shared/useCoarsePointer'
import { useMapOccluder } from '../shared/useMapChrome'
import { displayedPlantColor } from '../../app/plant-display/state'
import styles from './ToolCard.module.css'

/** What the tool card hands its stamp chooser (`StampChooser`, Desktop). */
export interface StampChooserProps {
  onChosen(): void
  onEscape(): void
}

/** What the card says of the armed tool. */
type ToolCardContent = NonNullable<ReturnType<typeof toolCardContent>>

/** What the card or the phone's tool row shows of the armed tool; null content shows none. */
function useToolCard(phone: boolean) {
  const tool = currentCanvasTool.value
  const guidance = currentCanvasToolGuidance.value
  const source = readPlantStampSource()
  const savedStamp = readSavedStampSummary()
  const overview = currentCanvasQuerySurface.value?.view.mode.value === 'overview'
  const species = usePlantStampSpeciesName(source)
  const coarsePointer = useCoarsePointer()
  // On a phone Select and Pan leave the bar to the selection and the map (answer 23).
  const content = siteLocateOpen.value || overview || (phone && (tool === 'select' || tool === 'hand'))
    ? null
    : toolCardContent({
        tool,
        guidance,
        speciesName: species?.name ?? null,
        savedStamp,
        scrollWheel: scrollWheel.value,
        coarsePointer,
        modKey: modKeyName(t),
        translate: t,
      })
  const row = content?.tool === 'plant-spacing' && guidance.plantRow?.phase === 'row' ? guidance.plantRow : null
  // From its first point the row is a path the card can plant, switch and edit (U58).
  const rowPath = row && (row.points ?? 0) >= 2 ? row : null
  return { tool, guidance, source, species, coarsePointer, content, row, rowPath }
}

/**
 * The tool card, top left beside the tool rail: the tool's name, the live
 * instruction (naming the chosen species or stamp) and quiet key hints that
 * end with what Esc does now. Select shows its name and one quiet line of
 * modifiers, Pan what a drag does. It hides in overview and while "Where is your site?" shows. The text is one polite live region that
 * stays mounted, so choosing a tool is announced. Place plants carries the
 * species chooser while no species is chosen, or after Change species; Place a
 * stamp opens its saved stamps with Change stamp; Plant a row carries its
 * spacing field below the text and the row's count at the card's foot (both
 * outside the live region) once a plant is picked, and from its first point
 * (U58) an [Interval | Plants] switch with the count field in Plants mode
 * and a loop's rounded gap beside the field, and in the foot the row's length
 * and the check button that plants the row (a 44 px target after a finger).
 * Points are edited where they are, never from the card: their menu (a long
 * press or a right-click), Alt+click and Delete. The text and the fields
 * scroll above the foot, which stays in view. Holding a row the card registers
 * with the visible-map-area seam; where it still covers the picked plant or
 * a point, the user pans. On a phone the tool is a row of the context bar
 * instead (PhoneToolRow).
 */
export function ToolCard({ stampChooser: StampChooser }: {
  /** Place a stamp's saved-stamp chooser; editions without saved stamps offer none. */
  readonly stampChooser?: FunctionComponent<StampChooserProps>
}) {
  const { tool, guidance, source, species, coarsePointer, content, row, rowPath } = useToolCard(false)
  const [changingSpecies, setChangingSpecies] = useState(false)
  const [choosingStamp, setChoosingStamp] = useState(false)
  const section = useRef<HTMLElement>(null)
  const choosing = content?.tool === 'plant-stamp' && (source === null || changingSpecies)
  const lead = content ? cardLead(content.tool, source, guidance) : null

  const stampChooser = StampChooser && content?.chooser?.kind === 'stamp' ? content.chooser : null
  // Holding a row the card grows over the map, so Fit, framing and the chips avoid it (answer 15): beside the rail it
  // covers the left edge.
  useMapOccluder(section, 'left', row !== null)

  useEffect(() => {
    if (tool !== 'plant-stamp') setChangingSpecies(false)
    if (tool !== 'object-stamp' && tool !== 'saved-object-stamp') setChoosingStamp(false)
  }, [tool])

  function closeChooser(): void {
    setChangingSpecies(false)
    setChoosingStamp(false)
    // The map takes focus back once a species or stamp is chosen, or the chooser closes.
    focusOwner.focusMap()
  }

  /** Esc in the species chooser: with no species chosen the chooser is all Place plants holds, so Esc leaves the tool;
   *  after Change species it only closes the chooser. */
  function escapeSpeciesChooser(): void {
    if (!source) armCanvasTool('select', { from: 'card' })
    closeChooser()
  }

  return (
    <section
      ref={section}
      className={content ? styles.card : styles.idle}
      data-tool-card={content?.tool}
      data-placement="map"
      data-row={row ? '' : undefined}
      data-touch={row && (coarsePointer || row.touch) ? '' : undefined}
      aria-label={content?.title}
    >
      {/* First in the DOM so the title and instruction wrap around it. */}
      {content?.chooser?.kind === 'species' && source && !changingSpecies && (
        <button type="button" className={styles.link} onClick={() => setChangingSpecies(true)}>
          {t('canvas.toolCard.changeSpecies')}
        </button>
      )}
      {stampChooser && !choosingStamp && (
        <button type="button" className={styles.link} onClick={() => setChoosingStamp(true)}>
          {t(stampChooser.held ? 'canvas.toolCard.changeStamp' : 'canvas.toolCard.chooseSavedStamp')}
        </button>
      )}
      {/* The text, then Plant a row's fields: on a row the part that scrolls above the foot. */}
      <div className={styles.body}>
        <div className={styles.live} role="status" aria-live="polite">
          {content && (
            <>
              <span className={styles.title}>
                {lead && <CardLead lead={lead} />}
                {content.title}
              </span>
              <CardText content={content} species={species} />
            </>
          )}
        </div>
        {row && <RowFields row={row} />}
      </div>
      {row && (content?.rowCount || rowPath) && (
        // The row's count and length, and the check button that plants that row: the card's foot, in view
        // whatever the card holds. They move with every pointer move, so they are not announced.
        <div className={styles.rowFoot} data-path={rowPath ? '' : undefined}>
          <span className={styles.facts}>
            {content?.rowCount && (
              <span className={styles.count} aria-live="off" data-plant-spacing-generated-count data-density={content.rowCount.density}>
                {content.rowCount.text}
              </span>
            )}
            {rowPath && <RowLength row={rowPath} />}
          </span>
          {rowPath && <FinishButton row={rowPath} />}
        </div>
      )}
      {choosing && (
        <SpeciesChooser
          autoFocus={changingSpecies}
          // The first click with no species points here; later ones leave the focus be, so a tablet's keyboard stays
          // closed and a mouse keeps the map's keys (the phone's options take it at each tap).
          focusRequest={guidance.speciesPrompts > 0 ? 1 : 0}
          onChosen={closeChooser}
          onEscape={escapeSpeciesChooser}
        />
      )}
      {StampChooser && stampChooser && choosingStamp && <StampChooser onChosen={closeChooser} onEscape={closeChooser} />}
    </section>
  )
}

/**
 * On a phone the armed tool is one touch row of the context bar (answer 30, PhoneContextBar): its glyph and name and a
 * short status (the chosen species, the row's count and spacing, or that its spacing needs fixing), then Plant a row's
 * check button and Options, which raises the panel sheet to half with the tool's options (ToolOptions); a tap on the
 * name or the status does too. The name and the status (the row's count aside, which moves with every pointer move)
 * are the one polite live region, which stays mounted, so choosing a tool is announced. Select and Pan show no row.
 */
export function PhoneToolRow() {
  const { source, guidance, species, content, row, rowPath } = useToolCard(true)
  const lead = content ? cardLead(content.tool, source, guidance) : null
  const status = content && row ? rowStatus(row, content) : null
  const subject = content?.subject ? <CardSubject content={content} species={species} /> : content?.instruction
  return (
    <section
      className={content ? styles.card : styles.idle}
      data-tool-card={content?.tool}
      data-placement="bar"
      aria-label={content?.title}
    >
      <div className={styles.barLabel} onClick={content ? toggleToolOptions : undefined}>
        <span className={styles.barLive} role="status" aria-live="polite">
          {content && (
            <>
              {lead && <CardLead lead={lead} />}
              <b className={styles.barName}>{content.title}</b>
              {!status && subject && <span className={styles.barStatus}>{subject}</span>}
            </>
          )}
        </span>
        {status && (
          <span
            className={`${styles.barStatus} ${styles.barRowStatus}`}
            aria-live="off"
            data-density={status.density}
            {...(status.invalid ? { 'data-plant-row-invalid': '' } : { 'data-plant-spacing-generated-count': '' })}
          >
            {status.text}
          </span>
        )}
      </div>
      {rowPath && <FinishButton row={rowPath} />}
      {content && (
        <button
          type="button"
          className={styles.barOptions}
          aria-expanded={phoneToolOptions.value !== null}
          data-tool-options-button
          onClick={toggleToolOptions}
        >
          {t('canvas.toolCard.options')}
        </button>
      )}
    </section>
  )
}

/** Opens the armed tool's options in the phone sheet at half, or closes them, giving the sheet back its panel. */
function toggleToolOptions(): void {
  phoneToolOptions.value = phoneToolOptions.peek() === null ? 'half' : null
}

/** Whether the row's spacing field (or count field, in Plants mode) holds what the row cannot plant with. */
function spacingInvalid(row: CanvasPlantRowGuidance): boolean {
  return row.mode === 'count' ? row.countValid === false : !row.intervalValid
}

/** The phone row's status for a picked plant: its spacing to fix, else the row's count and spacing once drawn. */
function rowStatus(row: CanvasPlantRowGuidance, content: ToolCardContent): {
  readonly text: string
  readonly density: 'normal' | 'dense' | 'blocked'
  readonly invalid: boolean
} | null {
  if (spacingInvalid(row)) return { text: t('canvas.plantSpacing.checkSpacing'), density: 'blocked', invalid: true }
  if (!content.rowCount) return null
  const text = row.mode === 'count' ? content.rowCount.text : `${content.rowCount.text} · ${row.interval}`
  return { text, density: content.rowCount.density, invalid: false }
}

/** The card's subject (the species, the stamp), its instruction and its key hints, below its title. */
function CardText({ content, species }: {
  readonly content: ToolCardContent
  readonly species: { readonly englishFallback: boolean } | null
}) {
  return (
    <>
      {/* The subject takes its own line, so a long name never breaks the instruction. */}
      {content.subject && <b className={styles.subject}><CardSubject content={content} species={species} /></b>}
      {content.instruction && (
        <span className={content.subject ? `${styles.instruction} ${styles.afterSubject}` : styles.instruction}>
          {content.instruction}
        </span>
      )}
      <span className={styles.hints}>{content.hints}</span>
    </>
  )
}

function CardSubject({ content, species }: {
  readonly content: ToolCardContent
  readonly species: { readonly englishFallback: boolean } | null
}) {
  return content.tool === 'plant-stamp' && species?.englishFallback
    ? <SpeciesCommonName name={content.subject!} englishFallback />
    : <>{content.subject}</>
}

/** The row's length; it moves with every pointer move, so it is not announced. */
function RowLength({ row }: { readonly row: CanvasPlantRowGuidance }) {
  return row.length ? (
    <span className={styles.fact} aria-live="off" data-plant-row-length>
      {t('canvas.plantSpacing.length')} <b>{row.length}</b>
    </span>
  ) : null
}

/**
 * The chosen species as the card names it: its name in the interface language, else
 * its English catalog name marked "(en)" (from the runtime for Design species, from
 * the catalog for the others), else the name saved with the source, else the
 * scientific name.
 */
function usePlantStampSpeciesName(source: PlantStampSource | null): { name: string; englishFallback: boolean } | null {
  const queries = currentCanvasQuerySurface.value
  void queries?.revision.plantNames.value
  const catalogEnglish = useEnglishFallbackNames(source && !source.common_name
    ? [{ canonicalName: source.canonical_name, commonName: null }]
    : NO_SPECIES)
  if (!source) return null
  const canonicalName = source.canonical_name
  const localized = queries?.getLocalizedCommonNames().get(canonicalName)
  if (localized) return { name: localized, englishFallback: false }
  const runtimeEnglish = queries?.getEnglishFallbackNames().get(canonicalName)
  if (runtimeEnglish) return { name: runtimeEnglish, englishFallback: true }
  if (source.common_name) return { name: source.common_name, englishFallback: false }
  const english = catalogEnglish.get(canonicalName)
  return english ? { name: english, englishFallback: true } : { name: canonicalName, englishFallback: false }
}

const NO_SPECIES: readonly { canonicalName: string }[] = []

type Lead = { readonly kind: 'species'; readonly symbol: PlantSymbolId; readonly color: string } | { readonly kind: 'stamp' }

/** The glyph at the start of the card: the species a click places or a row repeats, or the stamp. */
function cardLead(tool: string, source: PlantStampSource | null, guidance: CanvasToolGuidance): Lead | null {
  if (tool === 'plant-stamp' && source) {
    const scene = currentCanvasQuerySurface.value?.getSceneSnapshot()
    const appearance = speciesPlacementAppearance(
      scene ?? { plantSpeciesSymbols: {}, plantSpeciesColors: {} },
      { canonicalName: source.canonical_name, stratum: source.stratum },
    )
    return { kind: 'species', ...appearance, color: displayedPlantColor(appearance.color, source.canonical_name) }
  }
  if (tool === 'plant-spacing' && guidance.plantRow?.glyph) return { kind: 'species', ...guidance.plantRow.glyph }
  if ((tool === 'object-stamp' && guidance.stamp) || tool === 'saved-object-stamp') return { kind: 'stamp' }
  return null
}

function CardLead({ lead }: { readonly lead: Lead }) {
  if (lead.kind === 'stamp') {
    return <span className={styles.lead} aria-hidden="true" data-tool-card-lead="stamp"><ToolIcon name="object-stamp" /></span>
  }
  return (
    <span className={styles.lead} aria-hidden="true" data-tool-card-lead="species" style={{ color: lead.color }}>
      <PlantSymbolGlyph symbol={lead.symbol} size={22} />
    </span>
  )
}

/**
 * On a phone, the armed tool's options in the panel sheet (answer 30), in place of its open panel: the tool's guidance
 * that the bar's one row has no room for (the subject, the instruction and the key hints, not announced: the bar's row
 * is the live region), Plant a row's mode switch, spacing field and length, and Place plants' species chooser, which
 * closes the options once a species is chosen. Keys in the fields reach the row as the card's do (Enter keeps the
 * spacing, Esc steps the row back): the field handles its own.
 */
export function ToolOptions() {
  const { source, guidance, species, content, row, rowPath } = useToolCard(true)
  if (!content) return null

  function close(): void {
    phoneToolOptions.value = null
    focusOwner.focusMap()
  }

  return (
    <div className={styles.toolOptions} data-tool-options={content.tool}>
      <p className={styles.optionsText}>
        <CardText content={content} species={species} />
      </p>
      {row && <RowFields row={row} />}
      {rowPath && <RowLength row={rowPath} />}
      {content.tool === 'plant-stamp' && (
        <SpeciesChooser
          autoFocus={false}
          focusRequest={guidance.speciesPrompts}
          onChosen={close}
          onEscape={() => {
            // With no species chosen the chooser is all Place plants holds, so Esc leaves the tool.
            if (!source) armCanvasTool('select', { from: 'card' })
            close()
          }}
        />
      )}
    </div>
  )
}

/**
 * Plant a row's fields, outside the live region: from its first point a mode switch, then the spacing (or count) field
 * and a loop's rounded gap. One container from the pick on, so the field stays mounted (and focused) as points come and
 * go.
 */
function RowFields({ row }: { readonly row: CanvasPlantRowGuidance }) {
  const rowPath = (row.points ?? 0) >= 2 ? row : null
  const mode = row.mode ?? 'interval'
  return (
    <div className={styles.fieldRow}>
      {(rowPath || mode === 'count') && <RowModeSwitch mode={mode} />}
      {/* One field whose kind follows the mode, so a switch keeps it mounted: only a new focus request moves focus. */}
      <SpacingField row={row} kind={mode} switched={rowPath !== null || mode === 'count'} />
      {/* A loop's rounded gap beside the spacing it rounds; it moves with the points, so it is not announced. */}
      {rowPath?.loopSpacing && (
        <span className={styles.fact} aria-live="off">
          {t('canvas.plantSpacing.loopSpacing')} <b data-plant-row-loop-spacing>{rowPath.loopSpacing}</b>
        </span>
      )}
    </div>
  )
}

/** Plant a row's [Interval | Plants] switch: every N m, or N plants with the picked one counted. */
function RowModeSwitch({ mode }: { readonly mode: 'interval' | 'count' }) {
  const path = currentCanvasToolCommandSurface.value?.plantRowPath
  return (
    <span className={styles.modes} role="group" aria-label={t('canvas.plantSpacing.mode')}>
      {(['interval', 'count'] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={styles.mode}
          aria-pressed={mode === option}
          data-plant-row-mode={option}
          onClick={() => path?.setMode(option)}
        >
          {t(option === 'interval' ? 'canvas.plantSpacing.modeInterval' : 'canvas.plantSpacing.modeCount')}
        </button>
      ))}
    </span>
  )
}

/**
 * The check button that plants the row; it gives the map its focus back, so Enter and Esc reach the row again. On phones
 * its glyph alone, so the bar keeps one row: an icon-only button, named by its label and its tooltip; there the field is
 * the tool's options', so a spacing the row cannot plant with opens them, and the field takes the focus it asks for.
 */
function FinishButton({ row }: { readonly row: CanvasPlantRowGuidance }) {
  const path = currentCanvasToolCommandSurface.value?.plantRowPath
  const name = t('canvas.toolCard.pathFinish')
  const phone = phoneLayout.value !== null
  return (
    <button
      type="button"
      className={styles.finish}
      data-plant-row-finish
      aria-label={phone ? name : undefined}
      onClick={() => {
        path?.finish()
        focusOwner.focusMap()
        if (phone && spacingInvalid(row)) phoneToolOptions.value = 'half'
      }}
    >
      <ControlIcon name="check" />
      {phone ? <ButtonTooltip label={name} side="top" /> : <span>{name}</span>}
    </button>
  )
}

/**
 * Plant a row's spacing: the runtime keeps the text and parses it; Enter keeps
 * a valid spacing and gives the map focus back, Esc steps the row back as on
 * the map (the last point, else the picked plant),
 * and leaving the field keeps a valid spacing without moving focus. In Plants
 * mode the same field takes the count (the picked plant counted). Beside the
 * mode switch (`switched`) its label is read, not shown: the switch names it.
 */
function SpacingField({ row, kind, switched = false }: {
  readonly row: CanvasPlantRowGuidance
  readonly kind: 'interval' | 'count'
  readonly switched?: boolean
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const focused = useRef(0)
  const field = currentCanvasToolCommandSurface.value?.plantRowSpacing
  const count = kind === 'count'

  useLayoutEffect(() => {
    if (row.focusRequest === focused.current) return
    focused.current = row.focusRequest
    // The card's text and fields scroll to the field: once the row grows, it may sit below their fold. Explicitly, since
    // WebKit's focus leaves it partly clipped.
    input.current?.focus({ preventScroll: true })
    input.current?.scrollIntoView?.({ block: 'nearest' })
  }, [row.focusRequest])

  return (
    <span className={styles.field}>
      <label className={switched ? styles.hiddenLabel : styles.fieldLabel} for={id}>{t(count ? 'canvas.plantSpacing.count' : 'canvas.plantSpacing.interval')}</label>
      <input
        ref={input}
        id={id}
        className={styles.fieldInput}
        type="text"
        inputMode={count ? 'numeric' : 'decimal'}
        autoComplete="off"
        spellcheck={false}
        value={count ? row.countText ?? '' : row.interval}
        aria-invalid={count ? row.countValid === false : !row.intervalValid}
        {...(count ? { 'data-plant-row-count-input': '' } : { 'data-plant-spacing-interval-input': '' })}
        onInput={(event) => field?.input(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== 'Escape') return
          // Enter and Esc inside an IME composition are the IME's (WebKit sends the key that ends one with keyCode 229).
          if (event.isComposing || event.keyCode === 229) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Enter') field?.commit(event.currentTarget.value)
          else field?.cancel()
        }}
        onFocusOut={(event) => field?.blur(event.currentTarget.value)}
      />
    </span>
  )
}

function readSavedStampSummary(): SavedStampSummary | null {
  const payload = readSavedObjectStampSource()
  if (!payload) return null
  return {
    name: readSavedObjectStampName(),
    plants: payload.plants.length,
    species: new Set(payload.plants.map((plant) => plant.canonicalName)).size,
  }
}
