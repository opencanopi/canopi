import type { CanvasStampGuidance, CanvasToolGuidance } from '../../canvas/session-state'
import type { ToolId } from '../../canvas/runtime/tool-id'
import type { LocaleKey } from '../../generated/locale-keys'

type Translate = (key: LocaleKey, options?: Readonly<Record<string, unknown>>) => string

/** A saved stamp armed from Favorites, as the card names it. */
export interface SavedStampSummary {
  readonly name: string | null
  readonly plants: number
  readonly species: number
}

export interface ToolCardInput {
  readonly tool: ToolId
  readonly guidance: CanvasToolGuidance
  /** Place plants: the chosen species' shown name, or null while the card offers its chooser. */
  readonly speciesName: string | null
  readonly savedStamp: SavedStampSummary | null
  /** Settings › Canvas › Pointing device (stored scroll_wheel: 'zoom' is Mouse, 'pan' is Trackpad): Select's line says
   *  how this device pans and zooms. */
  readonly scrollWheel: 'zoom' | 'pan'
  /** A coarse primary pointer (a touch screen): Select's line names two fingers and a pinch, as for a trackpad. */
  readonly coarsePointer: boolean
  /** The platform's mod key name (Ctrl, or Cmd on a Mac), for Plant a row's no-snap hint. */
  readonly modKey: string
  readonly translate: Translate
}

/**
 * What the tool card says: the tool's name, the live instruction (its subject,
 * such as the species or stamp, shown first and bold) and quiet key hints that
 * end with what Esc does now.
 */
export interface ToolCardContent {
  readonly tool: ToolId
  readonly title: string
  readonly subject: string | null
  /** Empty for Select, whose card is its name and one line of hints. */
  readonly instruction: string
  readonly hints: string
  /**
   * The chooser link the card offers: Place plants' species, or Place a stamp's
   * saved stamps (`stamp` names Change stamp once one is held).
   */
  readonly chooser: null | { readonly kind: 'species' } | { readonly kind: 'stamp'; readonly held: boolean }
  /** Plant a row: how many plants the drawn row adds, and how dense it is. */
  readonly rowCount: { readonly text: string; readonly density: 'normal' | 'dense' | 'blocked' } | null
}

const TITLE_KEYS: Readonly<Record<ToolId, LocaleKey>> = {
  select: 'canvas.tools.select',
  // Pan is off the main rail, so its card says what it does.
  hand: 'canvas.tools.hand',
  'plant-stamp': 'canvas.tools.plantStamp',
  'plant-spacing': 'canvas.tools.plantSpacing',
  'object-stamp': 'canvas.tools.objectStamp',
  'saved-object-stamp': 'canvas.tools.objectStamp',
  polygon: 'canvas.tools.polygon',
  rectangle: 'canvas.tools.rectangle',
  ellipse: 'canvas.tools.ellipse',
  line: 'canvas.tools.line',
  text: 'canvas.tools.text',
  'measurement-guide': 'canvas.tools.measurementGuide',
  profile: 'canvas.tools.profile',
}

const PLACING_TOOLS = new Set(['plant-stamp', 'object-stamp', 'saved-object-stamp'])
/** The drawing tools whose Esc and Backspace remove the draft's last point (U58); Plant a row's once it has a point. */
const STEP_BACK_TOOLS = new Set(['polygon', 'profile'])
const STAMP_TOOLS = new Set(['object-stamp', 'saved-object-stamp'])

export function toolCardContent(input: ToolCardInput): ToolCardContent | null {
  const { tool, guidance, translate } = input
  const titleKey = TITLE_KEYS[tool]

  // What the next Esc does: steps a drawing draft back one point (U58), as Backspace does, so one hint names both keys;
  // drops a held row source or stamp pick, cancels a gesture, then leaves the tool.
  const rowPath = tool === 'plant-spacing' && guidance.plantRow?.phase === 'row' && (guidance.plantRow.points ?? 0) >= 2
  const stepBack = rowPath || (STEP_BACK_TOOLS.has(tool) && guidance.gesture)
  const esc = translate(
    stepBack ? (tool === 'polygon' ? 'canvas.toolCard.escRemoveCorner' : 'canvas.toolCard.escRemovePoint')
      : tool === 'plant-spacing' && guidance.plantRow?.phase === 'row' ? 'canvas.toolCard.escClearRow'
        : tool === 'object-stamp' && guidance.stamp ? 'canvas.toolCard.escClearStamp'
          : guidance.gesture ? 'canvas.toolCard.escCancel'
            : PLACING_TOOLS.has(tool) ? 'canvas.toolCard.escStopPlacing'
              : 'canvas.toolCard.escSelect',
  )
  const hints = (...keys: LocaleKey[]): string => [...keys.map((key) => translate(key)), esc].join(' · ')
  const card = (subject: string | null, instruction: string, hintText = hints()): ToolCardContent => ({
    tool,
    title: translate(titleKey),
    subject,
    instruction,
    hints: hintText,
    chooser: tool === 'plant-stamp' ? { kind: 'species' }
      : STAMP_TOOLS.has(tool) ? { kind: 'stamp', held: guidance.stamp !== null || (tool === 'saved-object-stamp' && input.savedStamp !== null) }
        : null,
    rowCount: null,
  })
  const angle = guidance.stampRotationDeg ?? 0

  switch (tool) {
    case 'select':
      // No Esc meaning: under Select, Esc only clears the selection.
      return card(null, '', translate(input.scrollWheel === 'pan' || input.coarsePointer ? 'canvas.toolCard.selectHintPan' : 'canvas.toolCard.selectHint'))
    case 'hand':
      return card(null, translate('canvas.toolCard.panHint'))
    case 'plant-stamp':
      return input.speciesName
        ? card(input.speciesName, translate('canvas.toolCard.placeOne'))
        : card(null, translate(guidance.speciesPrompts > 0 ? 'canvas.toolCard.chooseFirst' : 'canvas.toolCard.chooseSpecies'))
    case 'object-stamp':
      return guidance.stamp
        ? card(stampName(guidance.stamp, translate), stampInstruction(guidance.stamp, angle, translate), hints('canvas.toolCard.stampRotateKeys'))
        : card(null, translate('canvas.toolCard.stampPick'))
    case 'saved-object-stamp': {
      const stamp = input.savedStamp
      return stamp
        ? card(stamp.name, stampInstruction(stamp, angle, translate), hints('canvas.toolCard.stampRotateKeys'))
        : card(null, translate('canvas.toolCard.stampPlace'))
    }
    case 'plant-spacing': {
      const row = guidance.plantRow
      if (row?.phase !== 'row') {
        return card(null, translate(row?.phase === 'missed' ? 'canvas.plantSpacing.sourceMissed' : 'canvas.plantSpacing.selectSource'))
      }
      const counted = translate('canvas.plantSpacing.generatedCount', { count: row.count ?? 0 })
      // With only the picked plant the card is the straight row's; from a point on it tells how to draw and plant the path.
      const touch = input.coarsePointer || row.touch === true
      const [instruction, hintText] = !rowPath
        ? [translate('canvas.plantSpacing.dragAlong'), [translate('canvas.toolCard.rowKeys', { mod: input.modKey }), esc].join(' · ')]
        : touch
          ? [translate('canvas.toolCard.pathTouchInstruction'), translate('canvas.toolCard.pathTouchHint')]
          : [translate('canvas.toolCard.pathInstruction'), [translate('canvas.toolCard.pathKeys', { mod: input.modKey }), esc].join(' · ')]
      return {
        ...card(row.plantName, instruction, hintText),
        rowCount: row.count === null ? null : {
          text: row.density === 'blocked' ? `${counted} · ${translate('canvas.plantSpacing.commitLimitWarning')}` : counted,
          density: row.density,
        },
      }
    }
    case 'polygon':
      return card(null, translate('canvas.toolCard.polygon'), hints('canvas.toolCard.lineKeys'))
    case 'rectangle':
      return card(null, translate('canvas.toolCard.rectangle'), hints('canvas.toolCard.rectangleKeys'))
    case 'ellipse':
      return card(null, translate('canvas.toolCard.ellipse'), hints('canvas.toolCard.ellipseKeys'))
    case 'line':
      return card(null, translate('canvas.toolCard.line'), hints('canvas.toolCard.lineKeys'))
    case 'text':
      return guidance.gesture
        ? card(null, translate('canvas.toolCard.textType'), hints('canvas.toolCard.textKeys'))
        : card(null, translate('canvas.toolCard.textPlace'))
    case 'measurement-guide':
      return card(null, translate('canvas.toolCard.measure'), hints('canvas.toolCard.lineKeys'))
    case 'profile':
      return card(null, translate('canvas.toolCard.profile'), hints('canvas.toolCard.lineKeys'))
  }
}

function stampName(stamp: CanvasStampGuidance, translate: Translate): string {
  if (stamp.name) return stamp.name
  if (stamp.kind === 'zone') return translate('canvas.toolCard.stampZone')
  if (stamp.kind === 'annotation') return translate('canvas.tools.text')
  return translate('canvas.toolCard.stampGroup')
}

/**
 * "10 plants · 4 species · turned 30° · click to place": counts only when the
 * stamp has plants, the angle only once `[` or `]` has turned it.
 */
function stampInstruction(stamp: Pick<CanvasStampGuidance, 'plants' | 'species'>, angle: number, translate: Translate): string {
  const parts: string[] = []
  if (stamp.plants > 1) {
    parts.push(translate('canvas.toolCard.plants', { count: stamp.plants }))
    parts.push(translate('canvas.toolCard.species', { count: stamp.species }))
  }
  if (angle !== 0) parts.push(translate('canvas.toolCard.stampTurned', { degrees: angle }))
  parts.push(translate('canvas.toolCard.stampPlace'))
  return parts.join(' · ')
}
