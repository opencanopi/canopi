/**
 * The one tree walker for site data (architecture review, finding 9): the
 * Data library and Site data both list items nested under the item they were
 * calculated from, and both search keeping a match's ancestors.
 */
export interface TreeNode {
  readonly id: string
  /** The listed item this one nests under; null (or an unlisted id) for a top-level row. */
  readonly parentId: string | null
}

export type TreeRow<T extends TreeNode> = T & {
  /** Nesting depth: 0 for a top-level row. */
  readonly depth: number
}

/**
 * Rows in list order: each top-level row followed by its children, siblings
 * in `compare` order. A row whose parent is itself or is not listed sits at
 * the top level; a cycle has no root, so its members are listed once at the
 * top level with no parent.
 */
export function treeRows<T extends TreeNode>(nodes: readonly T[], compare: (left: T, right: T) => number): TreeRow<T>[] {
  const ids = new Set(nodes.map((node) => node.id))
  const children = new Map<string | null, T[]>()
  for (const node of nodes) {
    const parent = node.parentId !== null && node.parentId !== node.id && ids.has(node.parentId) ? node.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), node])
  }
  const rows: TreeRow<T>[] = []
  const visited = new Set<string>()
  const visit = (parent: string | null, depth: number) => {
    for (const node of [...(children.get(parent) ?? [])].sort(compare)) {
      if (visited.has(node.id)) continue
      visited.add(node.id)
      rows.push({ ...node, depth })
      visit(node.id, depth + 1)
    }
  }
  visit(null, 0)
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      visited.add(node.id)
      rows.push({ ...node, parentId: null, depth: 0 })
    }
  }
  return rows
}

/** The rows `keep` accepts and every listed ancestor of theirs, in list order and at their own depth. */
export function filterKeepingAncestors<T extends TreeRow<TreeNode>>(rows: readonly T[], keep: (row: T) => boolean): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const kept = new Set<string>()
  for (const row of rows) {
    if (!keep(row)) continue
    for (let current: T | undefined = row; current && !kept.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
      kept.add(current.id)
    }
  }
  return rows.filter((row) => kept.has(row.id))
}

/**
 * The Design's site data as a tree: a derived result nests under the item it
 * was calculated from (its first input) when that item is in the same Design.
 *
 * Saved `order` ranks an entry among its siblings only. The tree decides the
 * map's drawing order: groups stack by their root's order, and inside a group
 * results draw over the item they come from, so a slope is never hidden under
 * its own terrain. Siblings that are outputs of one analysis run (one
 * `definitionId`) stay together as one block, ranked by their front member,
 * so the list is always the draw order (GeoLibre keeps a `groupId` contiguous
 * the same way). Order is display order only; it never changes an item's
 * source priority or values.
 */
export interface ReferenceNode extends TreeNode {
  readonly order: number
  /** The analysis run a derived item is an output of; its outputs among one level's siblings move as one block. */
  readonly definitionId?: string | null
}

export type ReferenceRow<T extends ReferenceNode> = TreeRow<T>

/** Where a node sorts among its siblings: a run's block shares its front member's order and the run's key. */
interface Rank {
  readonly order: number
  readonly key: string
}

/** Each node's place among its siblings, with every run's outputs ranked together. */
function ranks<T extends ReferenceNode>(nodes: readonly T[]): Map<string, Rank> {
  const ids = new Set(nodes.map((node) => node.id))
  const parentOf = (node: T) => node.parentId !== null && node.parentId !== node.id && ids.has(node.parentId) ? node.parentId : null
  const front = new Map<string, number>()
  const blockOf = (node: T) => node.definitionId ? `${parentOf(node) ?? ''}\u0000${node.definitionId}` : null
  for (const node of nodes) {
    const block = blockOf(node)
    if (block) front.set(block, Math.max(front.get(block) ?? -Infinity, node.order))
  }
  return new Map(nodes.map((node) => {
    const block = blockOf(node)
    return [node.id, block ? { order: front.get(block)!, key: `run:${node.definitionId}` } : { order: node.order, key: node.id }]
  }))
}

/** Rows as Site data lists them: front first, each followed by its results. */
export function referenceRows<T extends ReferenceNode>(nodes: readonly T[]): ReferenceRow<T>[] {
  const rank = ranks(nodes)
  return treeRows(nodes, (left, right) => {
    const [l, r] = [rank.get(left.id)!, rank.get(right.id)!]
    return r.order - l.order || l.key.localeCompare(r.key) || right.order - left.order || left.id.localeCompare(right.id)
  })
}

/** Items back to front, the order the map draws them. */
export function referenceDrawOrder<T extends ReferenceNode>(nodes: readonly T[]): ReferenceRow<T>[] {
  const rank = ranks(nodes)
  return treeRows(nodes, (left, right) => {
    const [l, r] = [rank.get(left.id)!, rank.get(right.id)!]
    return l.order - r.order || l.key.localeCompare(r.key) || left.order - right.order || left.id.localeCompare(right.id)
  })
}

/**
 * The units a row moves among, front first, and every sibling at its level:
 * its run's members when it is an output of a run with others at its level,
 * else its siblings with each run as one unit. Null when the row is not listed.
 */
function moveUnits<T extends ReferenceNode>(nodes: readonly T[], id: string): { units: string[][], siblings: string[] } | null {
  const rows = referenceRows(nodes)
  const row = rows.find((candidate) => candidate.id === id)
  if (!row) return null
  const siblings = rows.filter((candidate) => candidate.parentId === row.parentId && candidate.depth === row.depth)
  const ids = siblings.map((sibling) => sibling.id)
  const run = row.definitionId ? siblings.filter((candidate) => candidate.definitionId === row.definitionId) : []
  if (run.length > 1) return { units: run.map((member) => [member.id]), siblings: ids }
  const units: string[][] = []
  siblings.forEach((sibling, index) => {
    const sameRun = sibling.definitionId && index > 0 && siblings[index - 1]!.definitionId === sibling.definitionId
    if (sameRun) units.at(-1)!.push(sibling.id)
    else units.push([sibling.id])
  })
  return { units, siblings: ids }
}

/**
 * The units a drag moves a row among, front first (each a run's outputs or
 * one row), for the panel to measure; null for an unlisted row.
 */
export function siblingUnits<T extends ReferenceNode>(nodes: readonly T[], id: string): string[][] | null {
  return moveUnits(nodes, id)?.units ?? null
}

/** The saved orders for siblings listed front first, renumbered densely in drawing order. */
function renumbered<T extends ReferenceNode>(nodes: readonly T[], listed: readonly string[]): Map<string, number> {
  const ranked = new Map(listed.map((sibling, position) => [sibling, listed.length - 1 - position]))
  const moved = nodes.map((node) => ranked.has(node.id) ? { ...node, order: ranked.get(node.id)! } : node)
  return new Map(referenceDrawOrder(moved).map((node, position) => [node.id, position]))
}

/**
 * The saved orders after moving one row to a sibling's place (a drop on that
 * row, or Alt ↑/↓ to its neighbour): a row outside an analysis run moves past
 * the whole run whichever member it lands on, and a run's output moves only
 * among that run's outputs. The units between shift by one, and everything is
 * renumbered densely in drawing order. Null when the target is the row itself,
 * unknown, or not a place the row can move to.
 */
export function siblingMoveOrders<T extends ReferenceNode>(
  nodes: readonly T[],
  id: string,
  targetId: string,
): Map<string, number> | null {
  if (id === targetId) return null
  const level = moveUnits(nodes, id)
  const from = level?.units.findIndex((unit) => unit.includes(id)) ?? -1
  const to = level?.units.findIndex((unit) => unit.includes(targetId)) ?? -1
  if (!level || from < 0 || to < 0 || from === to) return null
  const reordered = level.units.filter((_, index) => index !== from)
  reordered.splice(to, 0, level.units[from]!)
  // A move inside a run puts its members back in the run's places among the other siblings.
  const moved = reordered.flat()
  const places = new Set(moved)
  let next = 0
  return renumbered(nodes, level.siblings.map((sibling) => places.has(sibling) ? moved[next++]! : sibling))
}

/**
 * The row Alt ↑ ('front') or Alt ↓ ('back') moves this one to with
 * `siblingMoveOrders`: the next row of the neighbouring unit (a whole run for
 * a row outside it, a member inside one); null at either end or for an
 * unlisted row.
 */
export function siblingNeighbour<T extends ReferenceNode>(
  nodes: readonly T[],
  id: string,
  towards: 'front' | 'back',
): string | null {
  const units = moveUnits(nodes, id)?.units
  const from = units?.findIndex((unit) => unit.includes(id)) ?? -1
  if (!units || from < 0) return null
  return towards === 'front' ? units[from - 1]?.at(-1) ?? null : units[from + 1]?.[0] ?? null
}
