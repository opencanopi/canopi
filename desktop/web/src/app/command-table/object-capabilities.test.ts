// app/command-table/object-capabilities.test.ts
// Five matrix test families (contracts §21; 2.1-Q147, 2.1-M86, 2.1-M163, 2.1-M164, 2.1-Q365).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectionCommandAvailability } from '../../canvas/runtime/interaction/contextual-selection-actions'
import type { CanvasDesignObjectSelectionModel } from '../../canvas/runtime/runtime'
import {
  capabilitiesForEdition,
  EDITION_CAPABILITIES,
  type EditionCapabilityId,
} from '../../generated/edition-capabilities'
import { KNOWN_CANOPI_KEYS, type KnownCanopiKey } from '../../generated/known-canopi-keys'
import { OBJECT_KINDS, type ObjectKind } from '../../types/design-object-kinds'
import { commandApplicability, type CommandContext } from './applicability'
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  cellOn,
  COMMAND_REQUIRES,
  OBJECT_KIND_ROWS,
  ownerOf,
  type ObjectOwner,
  type PdfPageKind,
  type SceneTargetKind,
} from './object-capabilities'

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..')

/** Document metadata keys that are not user-facing object kinds in the matrix. */
const NON_KIND_CANOPI_KEYS = new Set<KnownCanopiKey>([
  'version',
  'name',
  'description',
  'created_at',
  'updated_at',
  'extra',
])

function makeSelectionModel(
  editableKinds: readonly SceneTargetKind[],
  lockedKinds: readonly SceneTargetKind[] = [],
): CanvasDesignObjectSelectionModel {
  return {
    editableTargets: editableKinds.map((kind, i) => ({ kind, id: `e-${i}` })) as CanvasDesignObjectSelectionModel['editableTargets'],
    lockedTargets: lockedKinds.map((kind, i) => ({ kind, id: `l-${i}` })) as CanvasDesignObjectSelectionModel['lockedTargets'],
    blockedTargets: [],
    sameSpeciesReferenceCanonicalName: editableKinds.includes('plant') ? 'Malus domestica' : null,
    plantNamePinning: { plantIds: editableKinds.includes('plant') ? ['e-0'] : [], allPinned: false },
  } as unknown as CanvasDesignObjectSelectionModel
}

describe('object-action capability matrix (contracts §21, 2.1-Q147)', () => {
  it('Exhaustive: 28 kinds x 57 capabilities are populated and cover every KnownCanopiKey, SceneTargetKind, and PdfPageKind', () => {
    expect(OBJECT_KINDS).toHaveLength(28)
    expect(CAPABILITIES).toHaveLength(57)

    let totalCells = 0
    for (const { id: kind } of OBJECT_KINDS) {
      expect(OBJECT_KIND_ROWS[kind].id).toBe(kind)
      for (const { id: cap } of CAPABILITIES) {
        const cell = CAPABILITY_MATRIX[kind][cap]
        expect(cell).toBeDefined()
        totalCells += 1
      }
    }
    expect(totalCells).toBe(28 * 57)

    const coveredFields = new Set<KnownCanopiKey>()
    const coveredSceneTargets = new Set<SceneTargetKind>()
    const coveredPdfKinds = new Set<PdfPageKind | 'setup'>()
    for (const row of Object.values(OBJECT_KIND_ROWS)) {
      if ('field' in row.backing) coveredFields.add(row.backing.field)
      if ('sceneTarget' in row.backing) coveredSceneTargets.add(row.backing.sceneTarget)
      if ('printSetup' in row.backing) coveredPdfKinds.add(row.backing.printSetup)
      for (const ref of row.references ?? []) {
        if ('field' in ref) coveredFields.add(ref.field)
      }
    }

    for (const key of KNOWN_CANOPI_KEYS) {
      expect(coveredFields.has(key) || NON_KIND_CANOPI_KEYS.has(key), `KnownCanopiKey '${key}' unmapped`).toBe(true)
    }
    for (const kind of ['plant', 'zone', 'annotation', 'measurement-guide', 'group'] as const) {
      expect(coveredSceneTargets.has(kind), `SceneTargetKind '${kind}' unmapped`).toBe(true)
    }
    for (const pdf of ['setup', 'overview', 'detail', 'split', 'key', 'furniture'] as const) {
      expect(coveredPdfKinds.has(pdf), `PdfPageKind '${pdf}' unmapped`).toBe(true)
    }
  })

  it('Owner test: every ObjectOwner owns at least one row and tool-session rows are never persisted', () => {
    const counts = new Map<ObjectOwner, number>()
    for (const row of Object.values(OBJECT_KIND_ROWS)) {
      const owner = ownerOf(row)
      counts.set(owner, (counts.get(owner) ?? 0) + 1)
    }
    const allOwners: readonly ObjectOwner[] = [
      'scene', 'document', 'data-library', 'map-layer-store', 'stamp-store', 'tool-session',
    ]
    for (const owner of allOwners) {
      expect(counts.get(owner) ?? 0, `ObjectOwner '${owner}' owns no row`).toBeGreaterThan(0)
    }

    for (const row of Object.values(OBJECT_KIND_ROWS)) {
      if (ownerOf(row) !== 'tool-session') continue
      for (const persistenceCap of ['geojson-export-import', 'budget-csv-export', 'saved-views', 'stories'] as const) {
        const cell = CAPABILITY_MATRIX[row.id][persistenceCap]
        expect(cell.state, `tool-session '${row.id}' must not be 'yes' for '${persistenceCap}'`).not.toBe('yes')
      }
    }
  })

  it('Backing & cellOn: Web lacks saved-stamps and site-data-below-limit, Desktop has them, and requires cites only gate capabilities', () => {
    const desktopCaps = capabilitiesForEdition('desktop', 'linux')
    const webCaps = capabilitiesForEdition('web', 'linux')

    // 2.1-Q150: Web Save as stamp is lacking saved-stamps; Desktop is yes.
    expect(cellOn(webCaps, 'zone-rect', 'save-as-stamp')).toEqual({ state: 'lacking', requires: ['saved-stamps'] })
    expect(cellOn(desktopCaps, 'zone-rect', 'save-as-stamp').state).toBe('yes')

    // Site data rows lack site-data-below-limit on Web; Desktop has them.
    expect(cellOn(webCaps, 'site-data-entry', 'delete')).toEqual({ state: 'lacking', requires: ['site-data-below-limit'] })
    expect(cellOn(desktopCaps, 'site-data-entry', 'delete').state).toBe('yes')

    // Every capability named in requires is a 'gate' row, never an 'adapter' row.
    const kindByCap = new Map<EditionCapabilityId, string>(EDITION_CAPABILITIES.map((c) => [c.id, c.kind]))
    for (const row of Object.values(OBJECT_KIND_ROWS)) {
      for (const req of row.requires ?? []) {
        expect(kindByCap.get(req), `kind '${row.id}' requires non-gate '${req}'`).toBe('gate')
      }
    }
    for (const [cmd, reqs] of Object.entries(COMMAND_REQUIRES)) {
      for (const req of reqs ?? []) {
        expect(kindByCap.get(req), `command '${cmd}' requires non-gate '${req}'`).toBe('gate')
      }
    }
  })

  it('Reasons: every gap cell cites an open bead in .beads/issues.jsonl and every decision cell cites a real ledger row or ADR', () => {
    const openBeads = new Set<string>()
    for (const line of readFileSync(resolve(REPO_ROOT, '.beads/issues.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as { id: string; status: string }
      if (parsed.status === 'open') openBeads.add(parsed.id)
    }
    const ledger = readFileSync(resolve(REPO_ROOT, 'docs/decisions/2-1.md'), 'utf8')

    for (const kind of Object.keys(CAPABILITY_MATRIX) as ObjectKind[]) {
      for (const { id: cap } of CAPABILITIES) {
        const cell = CAPABILITY_MATRIX[kind][cap]
        if ('gap' in cell) {
          expect(openBeads.has(cell.gap), `${kind}.${cap} gap '${cell.gap}' is not an open bead`).toBe(true)
        } else if ('decision' in cell) {
          const valid = cell.decision.startsWith('ADR ') || ledger.includes(cell.decision)
          expect(valid, `${kind}.${cap} decision '${cell.decision}' not found in ledger or ADRs`).toBe(true)
        }
      }
    }
  })

  it('Behaviour: commandApplicability delegates to selectionCommandAvailability as the single runtime predicate', () => {
    const desktopCaps = [...capabilitiesForEdition('desktop', 'linux')]
    const webCaps = [...capabilitiesForEdition('web', 'linux')]
    const baseCtx: CommandContext = {
      capabilities: desktopCaps,
      hasDesign: true,
      revertAvailable: false,
      canvasAvailable: true,
      spatialEditingAvailable: true,
      readOnly: false,
      selection: null,
      held: false,
      lockedObjectsPresent: false,
      canPaste: true,
      canUndo: true,
      canRedo: false,
    }

    const saveAsStampRow = {
      id: 'canvas.saveSelectionAsStamp',
      requires: ['saved-stamps'] as const,
      needsSpatialEditing: true,
      selectionPredicate: 'saveAsStamp' as const,
    }
    // Web lacks saved-stamps -> lacking regardless of selection.
    expect(commandApplicability(saveAsStampRow, { ...baseCtx, capabilities: webCaps })).toEqual({ lacking: ['saved-stamps'] })
    // Desktop with a selected zone -> enabled.
    const zoneSel = selectionCommandAvailability(makeSelectionModel(['zone']))
    expect(commandApplicability(saveAsStampRow, { ...baseCtx, selection: zoneSel })).toBe('enabled')
    // Desktop with a selected measurement guide -> disabled by selectionCommandAvailability.
    const guideSel = selectionCommandAvailability(makeSelectionModel(['measurement-guide']))
    expect(commandApplicability(saveAsStampRow, { ...baseCtx, selection: guideSel })).toBe('disabled')
  })
})
