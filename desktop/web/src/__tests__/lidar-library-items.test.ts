import { beforeEach, describe, expect, it } from 'vitest'
import { filterLibraryItems, libraryItems, selectionAfter, suggestedItemName } from '../app/data-library/library-items'
import { locale } from '../app/settings/state'
import { librarySnapshot as snapshot, slopeItem, sourceItem } from './support/library-fixtures'

describe('Data Library items', () => {
  beforeEach(() => {
    locale.value = 'en'
  })

  it('nests derived items under their first input, each level in a stable name order', () => {
    const items = libraryItems(snapshot([
      sourceItem('b', 'terrain'),
      slopeItem('s2', 'c', { name: 'Zeta' }),
      sourceItem('a', 'Terrain'),
      sourceItem('c', 'Canopy'),
      slopeItem('s', 'c'),
    ]))

    expect(items.map((item) => [item.id, item.depth])).toEqual([['c', 0], ['s', 1], ['s2', 1], ['a', 0], ['b', 0]])
    expect(items[1]).toMatchObject({
      role: 'Derived',
      name: 'Canopy · Slope',
      units: '°',
      parentId: 'c',
      group: 'terrain',
      itemType: { kind: 'Raster', quantity: 'Slope' },
    })
  })

  it('lists a derived item whose input is gone at the top level', () => {
    const items = libraryItems(snapshot([slopeItem('s', 'gone', { name: 'Orphan' })]))
    expect(items).toMatchObject([{ id: 's', depth: 0, name: 'Orphan' }])
  })

  it('shows an unpublished import as preparing while it runs and failed after, never carrying its job’s text', () => {
    const job = { job_id: 'j', layer_id: 'x', message: 'bad file', progress: null }
    const [running] = libraryItems(snapshot([sourceItem('x', 'X', { generation_id: null, state: 'Preparing', import_job: { ...job, state: 'Staging' } })]))
    const [failed] = libraryItems(snapshot([sourceItem('x', 'X', { generation_id: null, state: 'Failed', import_job: { ...job, state: 'Failed' } })]))

    expect(running).toMatchObject({ status: 'preparing', importJob: { state: 'Staging' } })
    expect(failed).toMatchObject({ status: 'failed' })
    expect(JSON.stringify({ ...failed, importJob: null })).not.toContain('bad file')
  })

  it('reports a derived item’s failed run, without its text, and keeps it ready while a refresh runs', () => {
    const [, refreshing] = libraryItems(snapshot([
      sourceItem('a', 'A'),
      slopeItem('s', 'a', { run: { job_id: 'j2', state: 'Preparing', message: null }, freshness: { state: 'Stale', reasons: [{ reason: 'RecipeUpdated', from: 1, to: 2 }] } }),
    ]))
    const [, failed] = libraryItems(snapshot([
      sourceItem('a', 'A'),
      slopeItem('s', 'a', { generation_id: null, state: 'Failed', run: { job_id: 'j', state: 'Failed', message: 'engine stopped' } }),
    ]))

    expect(refreshing).toMatchObject({ status: 'ready', run: { state: 'Preparing' }, freshness: { state: 'Stale' } })
    expect(failed).toMatchObject({ status: 'failed', run: { state: 'Failed' } })
    expect(failed).not.toHaveProperty('message')
  })

  it('keeps unsettled operations visible whatever the search and filter', () => {
    const items = libraryItems(snapshot([
      sourceItem('a', 'Ground'),
      sourceItem('x', 'Pending', { generation_id: null, state: 'Preparing', import_job: { job_id: 'j', layer_id: 'x', state: 'Applying', message: null, progress: null } }),
      slopeItem('s', 'a'),
      slopeItem('r', 'a', { name: 'Running', generation_id: null, state: 'Preparing', run: { job_id: 'j', state: 'Preparing', message: null } }),
    ]))

    // A kept result keeps its source above it.
    expect(filterLibraryItems(items, 'ground', 'terrain').map((item) => item.id)).toEqual(['a', 's', 'r', 'x'])
    expect(filterLibraryItems(items, 'zzz', 'all').map((item) => item.id)).toEqual(['a', 'r', 'x'])
    expect(filterLibraryItems(items, '', 'sources').map((item) => item.id)).toEqual(['a', 'r', 'x'])
  })

  it('keeps the sources of a search match three levels deep above it', () => {
    const items = libraryItems(snapshot([
      sourceItem('a', 'Ground'),
      sourceItem('b', 'Other'),
      slopeItem('s', 'a', { name: 'Slope' }),
      slopeItem('t', 's', { name: 'Steepest band' }),
    ]))
    expect(filterLibraryItems(items, 'steepest', 'all').map((item) => [item.id, item.depth])).toEqual([['a', 0], ['s', 1], ['t', 2]])
  })

  it('sorts by name or most recently added, results staying under their source', () => {
    const library = snapshot([
      sourceItem('old', 'Alpha', { created_at: '1000' }),
      sourceItem('new', 'Beta', { created_at: '3000' }),
      slopeItem('s-old', 'new', { name: 'Older slope', created_at: '1500' }),
      slopeItem('s-new', 'new', { name: 'Newer slope', created_at: '2500' }),
    ])
    expect(libraryItems(library).map((item) => item.id)).toEqual(['old', 'new', 's-new', 's-old'])
    expect(libraryItems(library, 'recent').map((item) => item.id)).toEqual(['new', 's-new', 's-old', 'old'])
    expect(libraryItems(library, 'recent')[0]?.createdAt).toBe('3000')
  })

  it('keeps the selection while its row is listed, else selects the row that took its place', () => {
    const rows = (...ids: string[]) => ids.map((id) => ({ id }))
    expect(selectionAfter(rows('a', 'b', 'c'), rows('a', 'b', 'c'), 'b')).toBe('b')
    // The selected item went: the next row moves up into its place.
    expect(selectionAfter(rows('a', 'b', 'c'), rows('a', 'c'), 'b')).toBe('c')
    // The last row went: the row above it.
    expect(selectionAfter(rows('a', 'b', 'c'), rows('a', 'b'), 'c')).toBe('b')
    // Nothing selected yet, or the selection was never listed: the first row.
    expect(selectionAfter([], rows('a', 'b'), null)).toBe('a')
    expect(selectionAfter(rows('a'), rows('b'), 'gone')).toBe('b')
    expect(selectionAfter(rows('a'), [], 'a')).toBeNull()
  })

  it('suggests a name from the shared stem of the chosen files', () => {
    expect(suggestedItemName(['/d/LHD_FXX_0712_6250.tif', '/d/LHD_FXX_0712_6251.tif'])).toBe('LHD_FXX_0712_625')
    expect(suggestedItemName(['C:\\d\\mnt.asc'])).toBe('mnt')
    expect(suggestedItemName(['/a/north.tif', '/a/south.tif'])).toBe('north')
    expect(suggestedItemName([])).toBe('')
  })
})
