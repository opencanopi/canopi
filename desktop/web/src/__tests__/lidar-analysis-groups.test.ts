import { describe, expect, it } from 'vitest'
import { siteDataLines } from '../app/data-library/analysis-groups'
import { referenceDrawOrder, referenceRows, siblingMoveOrders, siblingNeighbour } from '../app/data-library/reference-tree'

interface Node {
  readonly id: string
  readonly order: number
  readonly parentId: string | null
  readonly definitionId: string | null
}

const node = (id: string, order: number, parentId: string | null = null, definitionId: string | null = null): Node =>
  ({ id, order, parentId, definitionId })

function outline(nodes: readonly Node[]): string[] {
  return siteDataLines(referenceRows(nodes)).map((line) =>
    `${'  '.repeat(line.depth)}${line.kind === 'analysis' ? `[${line.definitionId}: ${line.members.map((member) => member.id).join(', ')}]` : line.row.id}`)
}

describe('Site data analysis groups', () => {
  it('leaves sources and single results as they are', () => {
    expect(outline([node('dem', 0), node('slope', 1, 'dem', 'slope-def'), node('canopy', 2)]))
      .toEqual(['canopy', 'dem', '  slope'])
  })

  it('gathers the outputs of one definition under one analysis line, in list order', () => {
    expect(outline([
      node('dem', 0),
      node('flow-direction', 3, 'dem', 'flow'),
      node('slope', 2, 'dem', 'slope-def'),
      node('flow-accumulation', 1, 'dem', 'flow'),
    ])).toEqual([
      'dem',
      '  [flow: flow-direction, flow-accumulation]',
      '    flow-direction',
      '    flow-accumulation',
      '  slope',
    ])
  })

  it('keeps results of an output nested under it, one level deeper', () => {
    expect(outline([
      node('dem', 0),
      node('a', 2, 'dem', 'flow'),
      node('b', 1, 'dem', 'flow'),
      node('a-derived', 0, 'a', 'next'),
    ])).toEqual([
      'dem',
      '  [flow: a, b]',
      '    a',
      '      a-derived',
      '    b',
    ])
  })

  it('groups top-level outputs whose source is not in the Design', () => {
    expect(outline([node('a', 1, 'gone', 'flow'), node('b', 0, 'gone', 'flow')]))
      .toEqual(['[flow: a, b]', '  a', '  b'])
  })
})

describe('the panel is the draw order (finding 1)', () => {
  /** The item lines of the panel, front first, and the draw order reversed, siblings of the MNT only. */
  function compare(nodes: readonly Node[]): { panel: string[], drawn: string[] } {
    const panel = siteDataLines(referenceRows(nodes)).flatMap((line) => line.kind === 'item' && line.row.id !== 'mnt' ? [line.row.id] : [])
    const drawn = referenceDrawOrder(nodes).map((row) => row.id).filter((id) => id !== 'mnt').reverse()
    return { panel, drawn }
  }

  it('two outputs of one run and a sibling: the panel lines equal the reversed draw order before and after Alt ↑', () => {
    const nodes = [node('mnt', 0), node('streams', 3, 'mnt', 'flow'), node('wetness', 2, 'mnt', 'flow'), node('slope', 1, 'mnt', 'slope-run')]
    const before = compare(nodes)
    expect(before.panel).toEqual(before.drawn)
    expect(outline(nodes)).toEqual(['mnt', '  [flow: streams, wetness]', '    streams', '    wetness', '  slope'])

    const target = siblingNeighbour(nodes, 'slope', 'front')!
    const orders = siblingMoveOrders(nodes, 'slope', target)!
    const moved = nodes.map((entry) => ({ ...entry, order: orders.get(entry.id)! }))
    const after = compare(moved)
    expect(after.panel).toEqual(['slope', 'streams', 'wetness'])
    expect(after.panel).toEqual(after.drawn)
  })

  it('a run whose members were saved apart is listed together, at its front member\'s place', () => {
    expect(outline([node('mnt', 0), node('streams', 3, 'mnt', 'flow'), node('slope', 2, 'mnt', 'slope-run'), node('wetness', 1, 'mnt', 'flow')]))
      .toEqual(['mnt', '  [flow: streams, wetness]', '    streams', '    wetness', '  slope'])
  })
})
