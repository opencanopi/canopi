import type { ReferenceNode, ReferenceRow } from './reference-tree'

/** What grouping needs of a Site data row: the analysis definition a result belongs to. */
export interface GroupableNode extends ReferenceNode {
  /** The definition a derived item belongs to; null for a source. */
  readonly definitionId: string | null
}

/**
 * One line of Site data. An analysis that published several outputs into
 * this Design gets a parent `analysis` line, its outputs nested under it; a
 * single output stays one `item` line under its source. `depth` is the
 * displayed nesting.
 */
export type SiteDataLine<T extends GroupableNode> =
  | { readonly kind: 'item'; readonly row: ReferenceRow<T>; readonly depth: number; readonly grouped: boolean }
  | {
      readonly kind: 'analysis'
      readonly definitionId: string
      /** The outputs in this Design, in list order. */
      readonly members: readonly ReferenceRow<T>[]
      readonly depth: number
    }

/**
 * Site data rows (front first, results after their source, as
 * `referenceRows` lists them) with an analysis line over each run that has
 * several outputs at one level. `referenceRows` already keeps a run's outputs
 * together in draw order, so this only labels them: the lines are the draw
 * order reversed, and moving a result still moves it among its siblings.
 */
export function siteDataLines<T extends GroupableNode>(rows: readonly ReferenceRow<T>[]): SiteDataLine<T>[] {
  const lines: SiteDataLine<T>[] = []
  emitLevel(rows, 0, lines)
  return lines
}

interface Block<T extends GroupableNode> {
  readonly head: ReferenceRow<T>
  readonly descendants: readonly ReferenceRow<T>[]
}

/** Split one level of a pre-order list into each row and the rows under it. */
function blocksOf<T extends GroupableNode>(rows: readonly ReferenceRow<T>[]): Block<T>[] {
  const blocks: Block<T>[] = []
  let index = 0
  while (index < rows.length) {
    const head = rows[index]!
    let end = index + 1
    while (end < rows.length && rows[end]!.depth > head.depth) end += 1
    blocks.push({ head, descendants: rows.slice(index + 1, end) })
    index = end
  }
  return blocks
}

function emitLevel<T extends GroupableNode>(rows: readonly ReferenceRow<T>[], extraDepth: number, lines: SiteDataLine<T>[]): void {
  const blocks = blocksOf(rows)
  for (let index = 0; index < blocks.length;) {
    const definitionId = blocks[index]!.head.definitionId
    let end = index + 1
    while (definitionId && end < blocks.length && blocks[end]!.head.definitionId === definitionId) end += 1
    const run = blocks.slice(index, end)
    index = end
    if (run.length < 2) {
      const { head, descendants } = run[0]!
      lines.push({ kind: 'item', row: head, depth: head.depth + extraDepth, grouped: false })
      emitLevel(descendants, extraDepth, lines)
      continue
    }
    lines.push({ kind: 'analysis', definitionId: definitionId!, members: run.map((member) => member.head), depth: run[0]!.head.depth + extraDepth })
    for (const member of run) {
      lines.push({ kind: 'item', row: member.head, depth: member.head.depth + extraDepth + 1, grouped: true })
      emitLevel(member.descendants, extraDepth + 1, lines)
    }
  }
}
