import { describe, expect, it } from 'vitest'
import {
  filterKeepingAncestors,
  referenceDrawOrder,
  referenceRows,
  siblingMoveOrders,
  siblingNeighbour,
  treeRows,
} from '../app/data-library/reference-tree'

const node = (id: string, order: number, parentId: string | null = null) => ({ id, order, parentId })

describe('site data tree', () => {
  const nodes = [
    node('ground', 0),
    node('slope', 2, 'ground'),
    node('canopy', 1),
    node('percent', 3, 'ground'),
  ]

  it('lists groups front first with results under their source', () => {
    expect(referenceRows(nodes).map((row) => [row.id, row.depth])).toEqual([
      ['canopy', 0],
      ['ground', 0],
      ['percent', 1],
      ['slope', 1],
    ])
  })

  it('draws results over their source and groups by their root', () => {
    expect(referenceDrawOrder(nodes).map((row) => row.id)).toEqual(['ground', 'slope', 'percent', 'canopy'])
  })

  it('keeps a result whose source is not in the Design at the top level', () => {
    const rows = referenceRows([node('slope', 0, 'elsewhere'), node('canopy', 1)])
    expect(rows.map((row) => [row.id, row.depth])).toEqual([['canopy', 0], ['slope', 0]])
  })

  it('survives a cycle by listing its members at the top level', () => {
    const rows = referenceRows([node('a', 0, 'b'), node('b', 1, 'a')])
    expect(rows.map((row) => row.id).sort()).toEqual(['a', 'b'])
  })
})

describe('one tree for the library and Site data (finding 9)', () => {
  const item = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId })
  const byName = (left: { name: string; id: string }, right: { name: string; id: string }) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id)

  it('nests children under their parent, siblings in the comparator\'s order', () => {
    const rows = treeRows([item('b', 'Beta'), item('a2', 'Zed', 'a'), item('a', 'Alpha'), item('a1', 'Aa', 'a')], byName)

    expect(rows.map((row) => [row.id, row.depth])).toEqual([['a', 0], ['a1', 1], ['a2', 1], ['b', 0]])
  })

  it('lists a row whose parent is missing, or is itself, at the top level', () => {
    const rows = treeRows([item('orphan', 'Orphan', 'gone'), item('self', 'Self', 'self')], byName)

    expect(rows.map((row) => [row.id, row.depth])).toEqual([['orphan', 0], ['self', 0]])
  })

  it('survives a cycle by listing its members once, at the top level', () => {
    const rows = treeRows([item('x', 'X', 'y'), item('y', 'Y', 'x')], byName)

    expect(rows.map((row) => [row.id, row.depth, row.parentId])).toEqual([['x', 0, null], ['y', 0, null]])
  })

  it('a match three deep keeps both its ancestors and drops everything else', () => {
    const rows = treeRows([
      item('ground', 'Ground'), item('slope', 'Slope', 'ground'), item('steep', 'Steep', 'slope'),
      item('canopy', 'Canopy'), item('other', 'Other slope', 'ground'),
    ], byName)

    const kept = filterKeepingAncestors(rows, (row) => row.name === 'Steep')

    expect(kept.map((row) => [row.id, row.depth])).toEqual([['ground', 0], ['slope', 1], ['steep', 2]])
  })

  it('keeps a match whose parent is not listed, alone', () => {
    const rows = treeRows([item('orphan', 'Steep', 'gone'), item('canopy', 'Canopy')], byName)

    expect(filterKeepingAncestors(rows, (row) => row.name === 'Steep').map((row) => row.id)).toEqual(['orphan'])
  })
})

describe('moving a row to a sibling\'s place (drag and Alt arrows)', () => {
  const nodes = [node('a', 2), node('b', 1), node('c', 0), node('r', 0, 'a')]

  it('takes the target row\'s place among its siblings and renumbers densely in drawing order', () => {
    // Front first: a, b, c. Dropping c on a lists c, a, b.
    const orders = siblingMoveOrders(nodes, 'c', 'a')!

    expect(referenceRows(nodes.map((n) => ({ ...n, order: orders.get(n.id)! }))).map((row) => row.id)).toEqual(['c', 'a', 'r', 'b'])
    expect([...orders.values()].sort()).toEqual([0, 1, 2, 3])
  })

  it('refuses a target that is not a sibling, the row itself or unknown', () => {
    expect(siblingMoveOrders(nodes, 'r', 'b')).toBeNull()
    expect(siblingMoveOrders(nodes, 'b', 'b')).toBeNull()
    expect(siblingMoveOrders(nodes, 'b', 'gone')).toBeNull()
  })
})

describe('an analysis run\'s outputs move as one block among their siblings (finding 1)', () => {
  const output = (id: string, order: number, definitionId: string) => ({ id, order, parentId: 'mnt', definitionId })
  // Under the MNT: two outputs of one water-flow run (streams 3, wetness 1) and a slope (2).
  const nodes = [
    { id: 'mnt', order: 0, parentId: null, definitionId: null },
    output('streams', 3, 'flow'),
    output('wetness', 1, 'flow'),
    { id: 'slope', order: 2, parentId: 'mnt', definitionId: 'slope-run' },
  ]
  const listed = (orders: Map<string, number>) =>
    referenceRows(nodes.map((n) => ({ ...n, order: orders.get(n.id)! }))).map((row) => row.id)

  it('lists a run\'s outputs together, ranked by its front member, members in their own order', () => {
    expect(referenceRows(nodes).map((row) => row.id)).toEqual(['mnt', 'streams', 'wetness', 'slope'])
    expect(referenceDrawOrder(nodes).map((row) => row.id)).toEqual(['mnt', 'slope', 'wetness', 'streams'])
  })

  it('moves a row that is not in the run past the whole run, whichever member it is dropped on', () => {
    expect(listed(siblingMoveOrders(nodes, 'slope', 'wetness')!)).toEqual(['mnt', 'slope', 'streams', 'wetness'])
    expect(listed(siblingMoveOrders(nodes, 'slope', 'streams')!)).toEqual(['mnt', 'slope', 'streams', 'wetness'])
  })

  it('moves a member only inside its run', () => {
    expect(listed(siblingMoveOrders(nodes, 'wetness', 'streams')!)).toEqual(['mnt', 'wetness', 'streams', 'slope'])
    expect(siblingMoveOrders(nodes, 'streams', 'slope')).toBeNull()
  })

  it('names the neighbour Alt ↑ and Alt ↓ move to: a whole run for a row outside it, a member inside it', () => {
    expect(siblingNeighbour(nodes, 'slope', 'front')).toBe('wetness')
    expect(siblingNeighbour(nodes, 'slope', 'back')).toBeNull()
    expect(siblingNeighbour(nodes, 'streams', 'front')).toBeNull()
    expect(siblingNeighbour(nodes, 'streams', 'back')).toBe('wetness')
    expect(siblingNeighbour(nodes, 'wetness', 'back')).toBeNull()
    expect(siblingNeighbour(nodes, 'mnt', 'front')).toBeNull()
    expect(siblingNeighbour(nodes, 'gone', 'front')).toBeNull()
  })
})
