interface SpacingPoint { readonly x: number; readonly y: number }
interface PositionedPlant { readonly position: SpacingPoint }

interface Node { point: SpacingPoint; axis: 'x' | 'y'; left: Node | null; right: Node | null }
interface SpacingIndex {
  tree: Node | null
  distances: ReadonlyMap<string, number>
  neighbours: ReadonlyMap<string, SpacingPoint | null>
}
const indices = new WeakMap<readonly PositionedPlant[], SpacingIndex>()
// Each Scene update copies the plant array, so an edit that moves no plant (a note's text, a lock, a layer
// toggle) gives a new array with the same positions, as do callers' own arrays. Retain only a few recent
// geometries (including drag previews) so equal positions share the expensive tree and distances.
const recentIndices: { positions: readonly SpacingPoint[]; index: SpacingIndex }[] = []
const MAX_RECENT_GEOMETRIES = 4
const key = (point: SpacingPoint) => `${point.x}:${point.y}`

function getIndex(plants: readonly PositionedPlant[]): SpacingIndex {
  let index = indices.get(plants)
  if (!index) {
    const match = recentIndices.findIndex(({ positions }) => positions.length === plants.length
      && positions.every((position, i) => position.x === plants[i]!.position.x && position.y === plants[i]!.position.y))
    const cached = match < 0 ? undefined : recentIndices.splice(match, 1)[0]
    index = cached?.index
    if (!index) {
      // Own coordinates: mutating a caller's defensive snapshot must never
      // corrupt the index subsequently reused by another snapshot.
      const points = [...new Map(plants.map((plant) => [key(plant.position), { ...plant.position }])).values()]
      const tree = buildTree(points, 0)
      const distances = new Map<string, number>()
      const neighbours = new Map<string, SpacingPoint | null>()
      for (const entry of points) {
        const found = nearestHit(tree, entry, { distSq: Infinity, point: null })
        const entryKey = key(entry)
        distances.set(entryKey, Math.sqrt(found.distSq))
        neighbours.set(entryKey, found.point)
      }
      index = { tree, distances, neighbours }
    }
    recentIndices.unshift(cached ?? { positions: plants.map((plant) => ({ ...plant.position })), index })
    if (recentIndices.length > MAX_RECENT_GEOMETRIES) recentIndices.pop()
    indices.set(plants, index)
  }
  return index
}

/** Immutable plant arrays own the cache; coincident centres share a footprint. */
export function nearestPlantSpacing(plants: readonly PositionedPlant[], point: SpacingPoint): number {
  const index = getIndex(plants)
  // Placement previews may not yet belong to the source.
  return index.distances.get(key(point)) ?? Math.sqrt(nearestHit(index.tree, point, { distSq: Infinity, point: null }).distSq)
}

/** Nearest distinct plant centre to `point` via the cached k-d tree (O(log n) / O(1) cached). */
export function nearestPlantNeighbour(plants: readonly PositionedPlant[], point: SpacingPoint): SpacingPoint | null {
  const index = getIndex(plants)
  const k = key(point)
  if (index.neighbours.has(k)) return index.neighbours.get(k)!
  return nearestHit(index.tree, point, { distSq: Infinity, point: null }).point
}

function buildTree(points: SpacingPoint[], depth: number): Node | null {
  if (!points.length) return null
  const axis = depth % 2 === 0 ? 'x' : 'y'
  points.sort((a, b) => a[axis] - b[axis])
  const middle = Math.floor(points.length / 2)
  return { point: points[middle]!, axis, left: buildTree(points.slice(0, middle), depth + 1), right: buildTree(points.slice(middle + 1), depth + 1) }
}

interface NearestHit { distSq: number; point: SpacingPoint | null }

function nearestHit(node: Node | null, point: SpacingPoint, best: NearestHit): NearestHit {
  if (!node) return best
  const dx = node.point.x - point.x, dy = node.point.y - point.y
  const squared = dx * dx + dy * dy
  if (squared > 0 && squared < best.distSq) {
    best.distSq = squared
    best.point = node.point
  }
  const delta = point[node.axis] - node.point[node.axis]
  nearestHit(delta < 0 ? node.left : node.right, point, best)
  if (delta * delta < best.distSq) nearestHit(delta < 0 ? node.right : node.left, point, best)
  return best
}
