import { afterEach, describe, expect, it } from 'vitest'
import {
  createToolHarness,
  plantEntity,
  rectZone,
  textNote,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../../__tests__/support/tool-harness'
import type { SceneDesignObjectTarget } from '../../scene/design-object-targets'

const harnesses: ToolHarness[] = []

function harness(options: ToolHarnessOptions = {}): ToolHarness {
  const created = createToolHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
})

const APPLE: SceneDesignObjectTarget = { kind: 'plant', id: 'apple' }
const PEAR: SceneDesignObjectTarget = { kind: 'plant', id: 'pear' }

function orchard() {
  return {
    plants: [
      plantEntity('apple', 'Malus domestica', { x: 50, y: 50 }),
      plantEntity('pear', 'Pyrus communis', { x: 150, y: 50 }),
      plantEntity('locked', 'Malus domestica', { x: 250, y: 50 }, { locked: true }),
    ],
  }
}

describe('Select clicks', () => {
  it('a click selects the hit object; empty ground clears', () => {
    const h = harness({ scene: orchard() })

    h.click({ x: 50, y: 50 })
    expect(h.store.session.selectedTargets).toEqual([APPLE])

    h.click({ x: 150, y: 50 })
    expect(h.store.session.selectedTargets).toEqual([PEAR])

    h.click({ x: 300, y: 250 })
    expect(h.store.session.selectedTargets).toEqual([])
  })

  it('a click selection records no history', () => {
    const h = harness({ scene: orchard() })

    h.click({ x: 50, y: 50 })
    h.click({ x: 150, y: 50 }, { mods: { shift: true } })
    h.click({ x: 300, y: 250 })

    expect(h.record.selections).toEqual([[APPLE], [APPLE, PEAR], []])
    expect(h.history.canUndo.value).toBe(false)
    expect(h.store.persisted.plants.map((plant) => plant.position)).toEqual([
      { x: 50, y: 50 },
      { x: 150, y: 50 },
      { x: 250, y: 50 },
    ])
  })

  it('an additive click toggles the hit and a directly locked object is selected without moving', () => {
    const h = harness({ scene: orchard() })

    h.click({ x: 50, y: 50 })
    h.click({ x: 50, y: 50 }, { mods: { ctrl: true } })
    expect(h.store.session.selectedTargets).toEqual([])

    h.click({ x: 250, y: 50 })
    expect(h.record.lockedMoveRefusals).toBe(0)
    h.drag({ x: 250, y: 50 }, { x: 280, y: 80 })
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'plant', id: 'locked' }])
    expect(h.store.persisted.plants[2]!.position).toEqual({ x: 250, y: 50 })
    expect(h.history.canUndo.value).toBe(false)
    // The refused drag is reported once, for the lock toast (2.1-Q177).
    expect(h.record.lockedMoveRefusals).toBe(1)
  })

  it('canopi-eon8.14.3: a Shift drag on a locked object toggles it and asks no move, so it raises no lock toast', () => {
    const h = harness({ scene: orchard() })

    h.click({ x: 50, y: 50 })
    h.drag({ x: 250, y: 50 }, { x: 280, y: 80 }, { mods: { shift: true } })

    expect(h.store.session.selectedTargets).toEqual([APPLE, { kind: 'plant', id: 'locked' }])
    expect(h.store.persisted.plants[2]!.position).toEqual({ x: 250, y: 50 })
    expect(h.record.lockedMoveRefusals).toBe(0)
  })

  it('canopi-eon8.14.3: an Alt drag on a selected locked object keeps it selected and is refused; an Alt click removes it', () => {
    const h = harness({ scene: orchard() })
    const LOCKED: SceneDesignObjectTarget = { kind: 'plant', id: 'locked' }

    h.click({ x: 50, y: 50 })
    h.click({ x: 250, y: 50 }, { mods: { shift: true } })
    expect(h.store.session.selectedTargets).toEqual([APPLE, LOCKED])

    // As on an unlocked object, an Alt drag is a move: the locked object stays selected and the move is refused.
    h.drag({ x: 250, y: 50 }, { x: 280, y: 80 }, { mods: { alt: true } })
    expect(h.store.session.selectedTargets).toEqual([APPLE, LOCKED])
    expect(h.store.persisted.plants[2]!.position).toEqual({ x: 250, y: 50 })
    expect(h.record.lockedMoveRefusals).toBe(1)

    // An Alt click without a drag removes it, and refuses nothing.
    h.click({ x: 250, y: 50 }, { mods: { alt: true } })
    expect(h.store.session.selectedTargets).toEqual([APPLE])
    expect(h.record.lockedMoveRefusals).toBe(1)
  })

  it('a platform double-click on a plant selects its species; one on a note opens it for editing', () => {
    const h = harness({
      scene: {
        ...orchard(),
        annotations: [textNote('note', { x: 100, y: 150 }, 'Prune in March')],
      },
    })

    // A double-click's second press after a press on another object is a single click (U42).
    h.click({ x: 150, y: 50 })
    h.click({ x: 50, y: 50 }, { clickCount: 2 })
    expect(h.store.session.selectedTargets).toEqual([APPLE])
    h.click({ x: 50, y: 50 }, { clickCount: 2 })
    // The locked apple is not selectable.
    expect(h.store.session.selectedTargets).toEqual([APPLE])

    h.click({ x: 104, y: 154 })
    h.click({ x: 104, y: 154 }, { clickCount: 2 })
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'annotation', id: 'note' }])
    expect(h.chrome.textEntry?.request).toMatchObject({ initialText: 'Prune in March', fontSizePx: 16 })
  })

  it('a double tap whose first press hit another note is a single click (U42)', () => {
    const h = harness({
      scene: {
        annotations: [textNote('a', { x: 100, y: 150 }, 'Prune'), textNote('b', { x: 100, y: 175 }, 'Mulch')],
      },
    })

    h.click({ x: 104, y: 154 })
    h.click({ x: 104, y: 179 }, { clickCount: 2 })
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'annotation', id: 'b' }])
    expect(h.chrome.textEntry).toBeNull()
  })

  it('(canopi-qd2k) a click inside a zone picks what lies beneath or clears; a click on its outline selects it', () => {
    const bed = rectZone('bed', [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 200 }])
    const pond = rectZone('pond', [{ x: 400, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 200 }, { x: 400, y: 200 }])
    const h = harness({ scene: { zones: [bed, pond], plants: [plantEntity('apple', 'Malus domestica', { x: 200, y: 150 })] } })
    const BED: SceneDesignObjectTarget = { kind: 'zone', id: 'bed' }
    const POND: SceneDesignObjectTarget = { kind: 'zone', id: 'pond' }

    h.click({ x: 103, y: 130 })
    expect(h.store.session.selectedTargets).toEqual([BED])
    // Inside, away from the outline: empty ground.
    h.click({ x: 150, y: 130 })
    expect(h.store.session.selectedTargets).toEqual([])

    // Shift or mod toggles the zone by its outline; Alt removes it.
    h.click({ x: 103, y: 130 })
    h.click({ x: 497, y: 150 }, { mods: { shift: true } })
    expect(h.store.session.selectedTargets).toEqual([BED, POND])
    h.click({ x: 150, y: 197 }, { mods: { ctrl: true } })
    expect(h.store.session.selectedTargets).toEqual([POND])
    h.click({ x: 450, y: 103 }, { mods: { alt: true } })
    expect(h.store.session.selectedTargets).toEqual([])

    // The plant inside the zone is what lies beneath.
    h.click({ x: 200, y: 150 })
    expect(h.store.session.selectedTargets).toEqual([APPLE])
    expect(h.history.canUndo.value).toBe(false)
  })

  it('(canopi-qd2k) a press inside a selected zone clears it as empty ground does; a press on its outline keeps it', () => {
    const bed = rectZone('bed', [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 }, { x: 100, y: 200 }])
    const h = harness({ scene: { zones: [bed] } })
    const BED: SceneDesignObjectTarget = { kind: 'zone', id: 'bed' }

    h.select(BED)
    h.press({ x: 103, y: 150 })
    expect(h.store.session.selectedTargets).toEqual([BED])
    h.release({ x: 103, y: 150 })
    expect(h.store.session.selectedTargets).toEqual([BED])

    h.press({ x: 150, y: 130 })
    expect(h.store.session.selectedTargets).toEqual([])
    h.release({ x: 150, y: 130 })
    expect(h.store.session.selectedTargets).toEqual([])
  })

  it('Alt+click removes', () => {
    const h = harness({ scene: orchard() })
    h.select(APPLE, PEAR)

    h.click({ x: 150, y: 50 }, { mods: { alt: true } })
    expect(h.store.session.selectedTargets).toEqual([APPLE])

    // An object outside the selection: Alt+click leaves the selection as it was.
    h.click({ x: 150, y: 50 }, { mods: { alt: true } })
    expect(h.store.session.selectedTargets).toEqual([APPLE])

    // Alt+drag from a selected object moves the selection as without Alt.
    h.drag({ x: 50, y: 50 }, { x: 70, y: 60 }, { mods: { alt: true } })
    expect(h.store.persisted.plants[0]!.position.x).toBeCloseTo(70, 6)
    expect(h.store.persisted.plants[0]!.position.y).toBeCloseTo(60, 6)
    expect(h.store.session.selectedTargets).toEqual([APPLE])
    expect(h.history.canUndo.value).toBe(true)
  })
})
