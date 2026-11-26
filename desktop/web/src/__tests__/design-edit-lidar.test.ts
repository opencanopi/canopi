import { describe, expect, it } from 'vitest'
import {
  upsertLidarEntry,
  patchLidarEntryById,
  reconcileLidarEntryNames,
  removeLidarEntries,
  setLidarEntryOrders,
  setSiteDataVisible,
} from '../app/design-edit/lidar'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import {
  replaceCurrentDesignState,
  resetDirtyBaselines,
} from './support/design-session-state'
import type { CanopiFile } from '../types/design'

function design(name: string): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '',
    updated_at: '',
    extra: {},
  }
}

function readLidarEntries(file: CanopiFile) {
  return file.site_data?.entries ?? []
}

/** Entries in the order the panel displays them, lowest order first. */
function displayOrder(file: CanopiFile) {
  return [...readLidarEntries(file)].sort((left, right) => left.order - right.order)
}

describe('LiDAR presentation entries through the Design Edit seam', () => {
  it('adds ordered entries with display defaults and updates them', () => {
    const base = design('Garden')
    replaceCurrentDesignState(base, null, 'Garden')

    upsertLidarEntry('Source', 'lyr-1', 'Terrain')
    const afterAdd = currentDesign.value
    expect(afterAdd).not.toBe(base)
    expect(afterAdd?.site_data).not.toBeNull()
    expect(readLidarEntries(afterAdd as CanopiFile)).toEqual([
      { id: 'lyr-1', name: 'Terrain', visible: true, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
    ])

    patchLidarEntryById('lyr-1', { visible: false, opacity: 0.5 })
    const afterPatch = currentDesign.value
    expect(readLidarEntries(afterPatch as CanopiFile)).toEqual([
      { id: 'lyr-1', name: 'Terrain', visible: false, opacity: 0.5, order: 0, ramp: null, reversed: false, range: null },
    ])
    // Second entry receives the next order value.
    upsertLidarEntry('Derived', 'adef-1', 'Slope')
    const entries = readLidarEntries(currentDesign.value as CanopiFile)
    expect(entries).toHaveLength(2)
    expect(entries[1]?.order).toBe(1)
  })

  it('keeps the design reference identical when nothing changes', () => {
    replaceCurrentDesignState(design('No-op'), null, 'No-op')
    upsertLidarEntry('Source', 'lyr-2', 'LYR-2')
    const before = currentDesign.value
    const dirtyBefore = designSessionStore.designDirty.value

    upsertLidarEntry('Source', 'lyr-2', 'LYR-2')
    patchLidarEntryById('lyr-2', { visible: true })

    expect(currentDesign.value).toBe(before)
    expect(designSessionStore.designDirty.value).toBe(dirtyBefore)
  })

  it('removes entries and drops the whole section when it empties', () => {
    replaceCurrentDesignState(design('Removal'), null, 'Removal')
    upsertLidarEntry('Source', 'lyr-3', 'LYR-3')
    upsertLidarEntry('Derived', 'adef-3', 'Slope')

    removeLidarEntries(['adef-3'])
    expect(readLidarEntries(currentDesign.value as CanopiFile)).toHaveLength(1)

    removeLidarEntries(['lyr-3'])
    expect(currentDesign.value?.site_data ?? null).toBeNull()
  })

  it('preserves unavailable entries so library deletions never rewrite documents', () => {
    replaceCurrentDesignState(design('Stale'), null, 'Stale')
    upsertLidarEntry('Source', 'lyr-gone', 'Terrain')
    const before = currentDesign.value

    // A library snapshot without the referenced entity does not mutate the
    // document; the presentation join flags it as unavailable instead.
    expect(readLidarEntries(currentDesign.value as CanopiFile)).toHaveLength(1)
    expect(currentDesign.value).toBe(before)
  })

  it('saves new orders in one edit and keeps display settings', () => {
    replaceCurrentDesignState(design('Order'), null, 'Order')
    upsertLidarEntry('Source', 'lyr-a', 'Terrain')
    upsertLidarEntry('Derived', 'adef-b', 'Slope')
    upsertLidarEntry('Source', 'lyr-c', 'Terrain')
    patchLidarEntryById('lyr-a', { opacity: 0.4 })
    expect(displayOrder(currentDesign.value as CanopiFile).map((e) => e.id))
      .toEqual(['lyr-a', 'adef-b', 'lyr-c'])

    // Orders already saved are a no-op: no history entry for nothing.
    const before = currentDesign.value
    setLidarEntryOrders(new Map([['lyr-a', 0], ['adef-b', 1]]))
    expect(currentDesign.value).toBe(before)

    setLidarEntryOrders(new Map([['lyr-c', 0], ['lyr-a', 1], ['adef-b', 2]]))
    const reordered = displayOrder(currentDesign.value as CanopiFile)
    expect(reordered.map((entry) => entry.id)).toEqual(['lyr-c', 'lyr-a', 'adef-b'])
    expect(reordered.find((entry) => entry.id === 'lyr-a')?.opacity).toBe(0.4)
  })

  it('ignores orders for entries that are not presented', () => {
    replaceCurrentDesignState(design('Unknown'), null, 'Unknown')
    upsertLidarEntry('Source', 'lyr-known', 'Terrain')
    const before = currentDesign.value
    setLidarEntryOrders(new Map([['lyr-absent', 3]]))
    expect(currentDesign.value).toBe(before)
  })

  it('stores display settings, comparing a range by value', () => {
    replaceCurrentDesignState(design('Display'), null, 'Display')
    upsertLidarEntry('Derived', 'slope', 'Slope')

    patchLidarEntryById('slope', { ramp: 'Magma', reversed: true, range: { mode: 'Custom', min: 0, max: 30 } })
    const styled = currentDesign.value
    expect(readLidarEntries(styled as CanopiFile)[0]).toMatchObject({
      ramp: 'Magma', reversed: true, range: { mode: 'Custom', min: 0, max: 30 },
    })

    // The same choice again, as a fresh object, is no edit.
    patchLidarEntryById('slope', { ramp: 'Magma', range: { mode: 'Custom', min: 0, max: 30 } })
    expect(currentDesign.value).toBe(styled)

    // Back to the kind's defaults: null ramp and range.
    patchLidarEntryById('slope', { ramp: null, reversed: false, range: null })
    expect(readLidarEntries(currentDesign.value as CanopiFile)[0]).toMatchObject({
      ramp: null, reversed: false, range: null,
    })
  })

  it('folds the Site data eye into the section and keeps each entry eye', () => {
    replaceCurrentDesignState(design('Eye'), null, 'Eye')
    setSiteDataVisible(false)
    expect(currentDesign.value?.site_data ?? null).toBeNull()

    upsertLidarEntry('Source', 'lyr-eye', 'Terrain')
    expect(currentDesign.value?.site_data?.visible).toBe(true)
    resetDirtyBaselines()
    expect(designSessionStore.designDirty.value).toBe(false)

    setSiteDataVisible(false)
    expect(currentDesign.value?.site_data?.visible).toBe(false)
    expect(readLidarEntries(currentDesign.value as CanopiFile)[0]?.visible).toBe(true)
    expect(designSessionStore.designDirty.value).toBe(true)

    const hidden = currentDesign.value
    setSiteDataVisible(false)
    expect(currentDesign.value).toBe(hidden)
  })

  it('refreshes stored names from the library without dirtying the Design, once', () => {
    replaceCurrentDesignState(design('Names'), null, 'Names')
    upsertLidarEntry('Source', 'lyr-n', 'Old name')
    upsertLidarEntry('Derived', 'slope-n', 'Slope')
    resetDirtyBaselines()
    expect(designSessionStore.designDirty.value).toBe(false)

    // Names the library lists; an id the Design does not present is ignored.
    const names = new Map([['lyr-n', 'Renamed'], ['slope-n', 'Slope'], ['absent', 'Absent']])
    reconcileLidarEntryNames(names)
    const renamed = currentDesign.value
    expect(readLidarEntries(renamed as CanopiFile).map((entry) => entry.name)).toEqual(['Renamed', 'Slope'])
    expect(designSessionStore.designDirty.value).toBe(false)

    // The effect that calls it runs again on the new Design: nothing left to do.
    reconcileLidarEntryNames(names)
    expect(currentDesign.value).toBe(renamed)
    // An empty library name never replaces a stored one.
    reconcileLidarEntryNames(new Map([['lyr-n', '  ']]))
    expect(currentDesign.value).toBe(renamed)
  })
})
