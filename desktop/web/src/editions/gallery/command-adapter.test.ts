// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { CommandName } from '../../generated/command-map'
import { LIDAR_SAMPLE_MAX_POINTS, type AnalysisRequest, type LidarSamplePointsRequest, type SpeciesSearchRequest } from '../../generated/contracts'
import { installAssetUrlResolver } from '../../types/command-transport'
import { createPlantMediaController } from '../../app/plant-detail/media-controller'
import type { SpeciesImage } from '../../types/species'
import { activity, galleryCommandTransport } from './command-adapter'

const call = <T,>(command: CommandName, args?: Record<string, unknown>) =>
  galleryCommandTransport(command, args, undefined) as Promise<T>

describe('galleryCommandTransport (canopi-f47t.52.233)', () => {
  it('serves recent designs, previews, drafts, folders, and species catalog commands', async () => {
    const recents = await call<Array<{ path: string }>>('get_recent_files')
    expect(recents.length).toBeGreaterThanOrEqual(5)

    const previews = await call<Array<{ path: string; preview: { kind: string } }>>('get_recent_design_previews', {
      paths: [
        '/designs/sanctuaire.canopi',
        '/designs/haie-nord.canopi',
        '/designs/mare.canopi',
        '/designs/2025/haie-nord.canopi',
        '/designs/ancien-verger.canopi',
      ],
    })
    expect(previews.map((p) => p.preview.kind)).toEqual(['read', 'read', 'read', 'unreadable', 'unreadable'])

    await call('show_recent_design_in_folder', { path: '/designs/sanctuaire.canopi' })
    await call('remove_recent_design', { path: '/designs/ancien-verger.canopi' })
    expect(activity.value).toContain('Recent Designs')

    const folders = await call<{ drafts: string; data_library: string }>('get_app_folders')
    expect(folders.drafts).toContain('drafts')
    await call('show_app_folder', { folder: 'data_library' })
    expect(activity.value).toContain('data_library')

    const drafts = await call<Array<{ id: string }>>('list_design_drafts')
    expect(drafts.length).toBe(2)
    await call('delete_design_draft', { id: 'draft-untitled' })
    expect((await call<Array<{ id: string }>>('list_design_drafts')).length).toBe(1)

    const favs = await call<Array<{ canonical_name: string }>>('get_favorites', { locale: 'fr' })
    expect(favs.length).toBeGreaterThan(0)
    expect(await call('get_recently_viewed')).toEqual([])
    const toggledOff = await call<boolean>('toggle_favorite', { canonicalName: 'Malus domestica' })
    expect(toggledOff).toBe(false)
    const toggledOn = await call<boolean>('toggle_favorite', { canonicalName: 'Malus domestica' })
    expect(toggledOn).toBe(true)

    const apple = await call<{ canonical_name: string }>('get_species_detail', { canonicalName: 'Malus domestica', locale: 'fr' })
    expect(apple.canonical_name).toBe('Malus domestica')
    const other = await call<{ canonical_name: string }>('get_species_detail', { canonicalName: 'Corylus avellana', locale: 'en' })
    expect(other.canonical_name).toBe('Corylus avellana')

    expect((await call<unknown[]>('get_species_batch')).length).toBeGreaterThan(0)
    expect(Object.keys(await call<Record<string, string>>('get_species_habits')).length).toBeGreaterThan(0)
    expect(Object.keys(await call<Record<string, string>>('get_common_names', { locale: 'fr' })).length).toBeGreaterThan(0)
    expect(Object.keys(await call<Record<string, string>>('get_common_names', { locale: 'en' })).length).toBeGreaterThan(0)

    const images = await call<Array<{ url: string }>>('get_species_images', { canonicalName: 'Malus domestica' })
    expect(images.length).toBeGreaterThan(0)
    expect(await call<unknown[]>('get_species_images', { canonicalName: 'Corylus avellana' })).toEqual([])
    expect(await call<string>('get_cached_image_path', { url: images[0]!.url })).toContain('data:')

    expect(await call('get_locale_common_names')).toEqual([])
    expect(await call('get_dynamic_filter_options')).toEqual([])
    expect(await call<{ habits: string[] }>('get_filter_options')).toHaveProperty('habits')
    await call('supersede_species_search')

    const baseReq: SpeciesSearchRequest = {
      text: 'apple',
      filters: { habit: ['Tree'], edibility_min: 4, climate_zones: ['Temperate'] } as SpeciesSearchRequest['filters'],
      cursor: null,
      limit: 25,
      sort: 'Name',
      locale: 'en',
      include_total: true,
    }
    expect((await call<{ items: unknown[] }>('search_species', { request: baseReq })).items.length).toBe(1)
    expect((await call<{ items: unknown[] }>('search_species', {
      request: { ...baseReq, text: '', filters: {} as SpeciesSearchRequest['filters'], sort: 'Height', locale: 'fr', include_total: false },
    })).items.length).toBeGreaterThan(1)
    expect((await call<{ items: unknown[] }>('search_species', {
      request: { ...baseReq, text: '', filters: {} as SpeciesSearchRequest['filters'], sort: 'Recommended' },
    })).items.length).toBeGreaterThan(1)
  })

  it('supports saved stamps, file pickers, and LiDAR library lifecycle commands', async () => {
    const initialStamps = await call<Array<{ id: string }>>('get_saved_object_stamps')
    expect(initialStamps.length).toBe(2)

    const created = await call<{ id: string; name: string }>('create_saved_object_stamp', {
      name: 'Guild test',
      payloadJson: '{}',
    })
    expect(created.name).toBe('Guild test')

    const renamed = await call<{ name: string }>('rename_saved_object_stamp', { id: created.id, name: 'Guild renamed' })
    expect(renamed.name).toBe('Guild renamed')

    const allIds = (await call<Array<{ id: string }>>('get_saved_object_stamps')).map((s) => s.id).reverse()
    await call('reorder_saved_object_stamps', { ids: allIds })
    expect(await call<boolean>('delete_saved_object_stamp', { id: created.id })).toBe(true)

    expect(await call('pick_open')).toEqual({ kind: 'picked', paths: ['gallery-example.canopi'] })
    expect(await call('pick_save')).toEqual({ kind: 'picked', path: 'gallery-export.canopi' })
    expect(await call('export_saved_object_stamp_canopi_file')).toBe('gallery-export.canopi')
    expect(await call<{ plants: unknown[] }>('load_saved_object_stamp_canopi_file')).toHaveProperty('plants')

    const lib = await call<{ items: Array<{ id: string; provenance?: { definition_id: string } | null }> }>('lidar_list_library')
    expect(lib.items.length).toBeGreaterThanOrEqual(3)

    const analysisReq: AnalysisRequest = {
      analysis_id: 'terrain.slope',
      name: 'Test slope',
      inputs: [{ key: 'dem', item_id: 'lidar-ground' }],
      parameters: [{ key: 'unit', value: { Choice: 'percent' } }],
      outputs: ['slope'],
    }
    const createdAnalysis = await call<{ definition_id: string; job_id: string; item_ids: string[] }>('lidar_create_analysis', { request: analysisReq })
    expect(createdAnalysis.item_ids.length).toBe(1)

    const rerun = await call<{ item_ids: string[] }>('lidar_rerun_analysis', { definitionId: createdAnalysis.definition_id })
    expect(rerun.item_ids).toEqual(createdAnalysis.item_ids)
    const history = await call<{ runs: unknown[] }>('lidar_processing_history', { definitionId: createdAnalysis.definition_id })
    expect(history.runs.length).toBeGreaterThanOrEqual(2)
    await call('lidar_cancel_analysis_job', { jobId: createdAnalysis.job_id })

    const imported = await call<{ layer_id: string; job_id: string }>('lidar_import_item', {
      name: 'Temp import',
      quantity: 'SurfaceElevation',
    })
    const retried = await call<{ layer_id: string; job_id: string }>('lidar_retry_import', { layerId: imported.layer_id })
    await call('lidar_cancel_import', { jobId: retried.job_id })
    await call('lidar_dismiss_import', { layerId: imported.layer_id })

    const imported2 = await call<{ layer_id: string; job_id: string }>('lidar_import_item', {
      name: 'Temp import 2',
      quantity: 'AboveGroundHeight',
    })
    await call('lidar_cancel_import', { jobId: imported2.job_id })

    await expect(call('lidar_delete_item', { itemId: 'lidar-ground' })).rejects.toThrow(/Other results/)
    await call('lidar_rename_item', { itemId: createdAnalysis.item_ids[0], name: 'Renamed slope' })
    await call('lidar_delete_item', { itemId: createdAnalysis.item_ids[0] })

    expect(await call<{ unreadable_files: number }>('lidar_import_coverage')).toHaveProperty('bounds')
    expect(await call<number>('lidar_library_disk_usage')).toBeGreaterThan(0)
    expect(await call<{ dependent_item_ids: string[] }>('lidar_delete_impact', { itemId: 'lidar-ground' })).toHaveProperty('dependent_item_ids')
    expect(await call<{ member_count: number }>('lidar_layer_collection', { layerId: 'lidar-ground' })).toHaveProperty('member_count', 4)

    const desc = await call<{ state: string }>('lidar_display_descriptor', {
      request: { kind: 'Source', entity_id: 'lidar-ground', expected_generation_id: 'lidar-ground-g1', relief: false },
    })
    expect(desc.state).toBe('Unavailable')

    const sampleReq: LidarSamplePointsRequest = {
      targets: [
        { kind: 'Source', entity_id: 'lidar-ground', expected_generation_id: 'lidar-ground-g1' },
        { kind: 'Derived', entity_id: 'lidar-slope', expected_generation_id: 'lidar-slope-g1' },
        { kind: 'Derived', entity_id: 'lidar-slope-percent', expected_generation_id: 'wrong-gen' },
        { kind: 'Source', entity_id: 'missing-item', expected_generation_id: 'x' },
      ],
      points: [[12.9999, 23.0], [0, 0]],
    }
    const sampled = await call<unknown[]>('lidar_sample_points', { request: sampleReq })
    expect(sampled.length).toBe(4)

    await expect(call('lidar_sample_points', {
      request: {
        targets: [],
        points: Array.from({ length: LIDAR_SAMPLE_MAX_POINTS + 1 }, () => [0, 0] as [number, number]),
      },
    })).rejects.toThrow(/caps/)

    await expect(call('unknown_gallery_command' as CommandName)).rejects.toThrow(/no fixture/)
  })

  it('loads gallery plant photos through PlantMediaController without Tauri convertFileSrc', async () => {
    const uninstall = installAssetUrlResolver((path) => path)
    const controller = createPlantMediaController({
      loadImages: (canonicalName) => call<SpeciesImage[]>('get_species_images', { canonicalName }),
      loadCachedImagePath: (url) => call<string>('get_cached_image_path', { url }),
    })
    try {
      controller.setCanonicalName('Malus domestica')
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(controller.images.value.length).toBeGreaterThan(0)
      expect(controller.loadedSrc.value).toMatch(/^data:image\/svg\+xml/)
    } finally {
      controller.dispose()
      uninstall()
    }
  })
})
