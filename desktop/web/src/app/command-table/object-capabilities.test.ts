// app/command-table/object-capabilities.test.ts
// Five matrix test families (contracts §21; 2.1-Q147, 2.1-M86, 2.1-M163, 2.1-M164, 2.1-Q365).
import { readdirSync, readFileSync } from 'node:fs'
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
import {
  CANVAS_COMMAND_ROWS,
  commandApplicability,
  commandRowFor,
  type CommandContext,
} from './applicability'
import { SHELL_COMMAND_REQUIRES } from './commands'
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  cellOn,
  OBJECT_KIND_ROWS,
  ownerOf,
  type Capability,
  type ObjectOwner,
  type PdfPageKind,
  type SceneTargetKind,
} from './object-capabilities'
import { PANEL_DESCRIPTORS } from './panels'
import { TOOL_ROWS } from './tools'
import { SHELL_COMMAND_DESCRIPTORS } from '../shell-commands'

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
    bounds: editableKinds.length > 0 ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : null,
    editableTargets: editableKinds.map((kind, i) => ({ kind, id: `e-${i}` })),
    lockedTargets: lockedKinds.map((kind, i) => ({ kind, id: `l-${i}` })),
    blockedTargets: [],
    sameSpeciesReferenceCanonicalName: editableKinds.includes('plant') ? 'Malus domestica' : null,
    plantNamePinning: { plantIds: editableKinds.includes('plant') ? ['e-0'] : [], allPinned: false },
  }
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

    // Single source of truth (B4, 2.1-M164): file.saveAs requires save-as-path on both descriptors and commandRowFor.
    const saveAsDescriptor = SHELL_COMMAND_DESCRIPTORS.find((d) => d.id === 'file.saveAs')
    expect(saveAsDescriptor?.requires).toEqual(['save-as-path'])
    expect(commandRowFor('file.saveAs').requires).toEqual(['save-as-path'])

    // Every capability named in requires across kinds, canvas commands, tools, panels and shell commands is a 'gate' row.
    const kindByCap = new Map<EditionCapabilityId, string>(EDITION_CAPABILITIES.map((c) => [c.id, c.kind]))
    for (const row of Object.values(OBJECT_KIND_ROWS)) {
      for (const req of row.requires ?? []) {
        expect(kindByCap.get(req), `kind '${row.id}' requires non-gate '${req}'`).toBe('gate')
      }
    }
    const allCommandReqs: readonly (readonly [string, readonly EditionCapabilityId[] | undefined])[] = [
      ...Object.entries(SHELL_COMMAND_REQUIRES),
      ...PANEL_DESCRIPTORS.map((p) => [p.commandId, p.requires] as const),
      ...Object.values(CANVAS_COMMAND_ROWS).map((r) => [r.id, r.requires] as const),
      ...Object.values(TOOL_ROWS).map((r) => [r.id, r.requires] as const),
    ]
    for (const [cmd, reqs] of allCommandReqs) {
      for (const req of reqs ?? []) {
        expect(kindByCap.get(req), `command '${cmd}' requires non-gate '${req}'`).toBe('gate')
      }
    }
  })

  it('Reasons: every gap cell cites an open capability-fill bead and every decision cell cites a non-Q147 active ledger row or real ADR', () => {
    const openBeads = new Set<string>()
    const capabilityFillBeads = new Set<string>()
    for (const line of readFileSync(resolve(REPO_ROOT, '.beads/issues.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const parsed = JSON.parse(line) as { id: string; status: string; labels?: readonly string[] }
      if (parsed.status !== 'closed' && parsed.status !== 'tombstone') {
        openBeads.add(parsed.id)
        if (parsed.labels?.includes('capability-fill')) capabilityFillBeads.add(parsed.id)
      }
    }

    const activeLedgerRows = new Set<string>()
    for (const line of readFileSync(resolve(REPO_ROOT, 'docs/decisions/2-1.md'), 'utf8').split('\n')) {
      if (!line.startsWith('| 2.1-')) continue
      const cols = line.split('|').map((c) => c.trim())
      const id = cols[1]
      const supersedesCol = cols[5] ?? ''
      if (id && !/\bsuperseded by\b/i.test(supersedesCol)) activeLedgerRows.add(id)
    }

    const adrIds = new Set<string>()
    for (const file of readdirSync(resolve(REPO_ROOT, 'docs/adr'))) {
      const m = /^(\d{4})-/.exec(file)
      if (m) adrIds.add(`ADR ${m[1]}`)
    }

    for (const kind of Object.keys(CAPABILITY_MATRIX) as ObjectKind[]) {
      for (const { id: cap } of CAPABILITIES) {
        const cell = CAPABILITY_MATRIX[kind][cap]
        if ('gap' in cell) {
          expect(openBeads.has(cell.gap), `${kind}.${cap} gap '${cell.gap}' is not an open bead`).toBe(true)
          expect(capabilityFillBeads.has(cell.gap), `${kind}.${cap} gap '${cell.gap}' lacks 'capability-fill' label`).toBe(true)
        } else if ('decision' in cell) {
          expect(cell.decision, `${kind}.${cap} must not cite process row 2.1-Q147`).not.toBe('2.1-Q147')
          const valid = adrIds.has(cell.decision) || activeLedgerRows.has(cell.decision)
          expect(valid, `${kind}.${cap} decision '${cell.decision}' is missing or superseded`).toBe(true)
        }
      }
    }
  })

  it('Ratchet: every gap cell in CAPABILITY_MATRIX matches policy/ratchets/object-capability-gaps.json 1:1', () => {
    const ratchet = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'policy/ratchets/object-capability-gaps.json'), 'utf8'),
    ) as { entries: Record<string, { count: number; bead: string }> }

    const matrixGaps = new Map<string, string>()
    for (const kind of Object.keys(CAPABILITY_MATRIX) as ObjectKind[]) {
      for (const { id: cap } of CAPABILITIES) {
        const cell = CAPABILITY_MATRIX[kind][cap]
        if ('gap' in cell) matrixGaps.set(`${kind}:${cap}`, cell.gap)
      }
    }
    expect(Object.keys(ratchet.entries).sort()).toEqual([...matrixGaps.keys()].sort())
    for (const [key, bead] of matrixGaps) {
      expect(ratchet.entries[key]?.bead, `ratchet bead mismatch for ${key}`).toBe(bead)
    }
  })

  it('Backing & Behaviour: real command rows evaluate yes, no, and lacking cells per kind on both Desktop and Web roots', () => {
    const roots = [
      { name: 'desktop', caps: capabilitiesForEdition('desktop', 'linux') },
      { name: 'web', caps: capabilitiesForEdition('web', 'linux') },
    ] as const

    function fixtureContextFor(
      caps: readonly EditionCapabilityId[],
      kind: ObjectKind,
      cap: Capability,
    ): CommandContext {
      const row = OBJECT_KIND_ROWS[kind]
      let selection: CommandContext['selection'] = null
      if ('sceneTarget' in row.backing) {
        const target = row.backing.sceneTarget
        if (cap === 'group-ungroup') {
          selection = selectionCommandAvailability(makeSelectionModel([target, target]))
        } else if (cap === 'lock-unlock') {
          selection = selectionCommandAvailability(makeSelectionModel([target], [target]))
        } else {
          selection = selectionCommandAvailability(makeSelectionModel([target]))
        }
      }
      return {
        capabilities: caps,
        hasDesign: true,
        revertAvailable: false,
        canvasAvailable: true,
        spatialEditingAvailable: true,
        readOnly: false,
        selection,
        held: false,
        lockedObjectsPresent: true,
        canPaste: true,
        canUndo: true,
        canRedo: true,
      }
    }

    let yesChecks = 0
    let lackingChecks = 0
    for (const root of roots) {
      const capsArray = [...root.caps]
      for (const kind of Object.keys(CAPABILITY_MATRIX) as ObjectKind[]) {
        const kindRow = OBJECT_KIND_ROWS[kind]
        const isSceneKind = 'sceneTarget' in kindRow.backing
        for (const { id: cap } of CAPABILITIES) {
          const rawCell = CAPABILITY_MATRIX[kind][cap]
          if (rawCell.state !== 'yes') continue
          expect(rawCell.via.length, `${kind}.${cap} 'yes' cell has empty via`).toBeGreaterThan(0)
          const evaluated = cellOn(root.caps, kind, cap)
          const ctx = fixtureContextFor(capsArray, kind, cap)
          if (evaluated.state === 'lacking') {
            lackingChecks += 1
            const kindMissing = (kindRow.requires ?? []).filter((r) => !root.caps.has(r))
            const cmdLacking = rawCell.via.some((cmdId) => {
              const res = commandApplicability(commandRowFor(cmdId), ctx)
              return typeof res === 'object' && res.lacking.length > 0
            })
            expect(kindMissing.length > 0 || cmdLacking, `${root.name} ${kind}.${cap} lacking not backed by requires`).toBe(true)
          } else {
            yesChecks += 1
            const results = rawCell.via
              .map((cmdId) => commandRowFor(cmdId))
              .filter((r) => isSceneKind || !r.selectionPredicate)
              .map((r) => commandApplicability(r, ctx))
            if (results.length > 0) {
              expect(results, `${root.name} ${kind}.${cap} has no enabled via row`).toContain('enabled')
            }
          }
        }
      }
    }
    expect(yesChecks).toBeGreaterThan(400)
    expect(lackingChecks).toBeGreaterThan(0)

    // Verify 'no' cells backed by selection-gated canvas commands are disabled on Desktop (and lacking/disabled on Web),
    // and that lone-plant rotate-by-value ('partial', ADR 0015) is disabled for 1 plant and enabled for 2 plants.
    const selectionGatedNoChecks: readonly (readonly [ObjectKind, Capability, 'canvas.selectSameSpecies' | 'canvas.groupSelected' | 'canvas.saveSelectionAsStamp'])[] = [
      ['group', 'select-same-species', 'canvas.selectSameSpecies'],
      ['measurement-guide', 'group-ungroup', 'canvas.groupSelected'],
      ['measurement-guide', 'save-as-stamp', 'canvas.saveSelectionAsStamp'],
    ]
    for (const [kind, cap, cmdId] of selectionGatedNoChecks) {
      expect(CAPABILITY_MATRIX[kind][cap].state, `${kind}.${cap} expected 'no'`).toBe('no')
      const row = commandRowFor(cmdId)
      const desktopCtx = fixtureContextFor([...roots[0].caps], kind, cap)
      expect(commandApplicability(row, desktopCtx), `desktop ${kind}.${cap} (${cmdId}) should be disabled`).toBe('disabled')
      const webCtx = fixtureContextFor([...roots[1].caps], kind, cap)
      const webRes = commandApplicability(row, webCtx)
      if (row.requires?.some((r) => !roots[1].caps.has(r))) {
        expect(typeof webRes, `web ${kind}.${cap} (${cmdId}) should be lacking`).toBe('object')
      } else {
        expect(webRes, `web ${kind}.${cap} (${cmdId}) should be disabled`).toBe('disabled')
      }
    }
    expect(CAPABILITY_MATRIX.plant['rotate-by-value'].state).toBe('partial')
    expect(commandApplicability(commandRowFor('canvas.rotateSelected'), fixtureContextFor([...roots[0].caps], 'plant', 'rotate-by-value'))).toBe('disabled')
    const twoPlantsCtx = {
      ...fixtureContextFor([...roots[0].caps], 'plant', 'rotate-by-value'),
      selection: selectionCommandAvailability(makeSelectionModel(['plant', 'plant'])),
    }
    expect(commandApplicability(commandRowFor('canvas.rotateSelected'), twoPlantsCtx)).toBe('enabled')
  })
})
