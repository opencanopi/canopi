import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCachedImagePath,
  getCommonNames,
  getDynamicFilterOptions,
  getFilterOptions,
  getFlowerColorBatch,
  getLocaleCommonNames,
  getSpeciesBatch,
  getSpeciesDetail,
  getSpeciesHabits,
  getSpeciesImages,
  searchSpecies,
  supersedeSpeciesSearch,
} from './species'
import { getAppFolders, showAppFolder } from './settings'
import {
  addDesignReferenceToNotebook,
  createNotebookSection,
  deleteDesignDraft,
  deleteNotebookSection,
  getDesignNotebook,
  getRecentDesignPreviews,
  getRecentFiles,
  listDesignDrafts,
  moveDesignReferenceToSection,
  newDesign,
  readNewerDesign,
  relocateDesignReference,
  removeDesignReference,
  removeRecentDesign,
  renameNotebookSection,
  reorderDesignReferences,
  reorderNotebookSections,
  showRecentDesignInFolder,
} from './design'
import {
  lidarCancelAnalysisJob,
  lidarCancelImport,
  lidarCreateAnalysis,
  lidarDeleteImpact,
  lidarDeleteItem,
  lidarDismissImport,
  lidarDisplayDescriptor,
  lidarImportCoverage,
  lidarImportItem,
  lidarLayerCollection,
  lidarLibraryDiskUsage,
  lidarListLibrary,
  lidarProcessingHistory,
  lidarRenameItem,
  lidarRerunAnalysis,
  lidarRetryImport,
  lidarSamplePoints,
} from './lidar'
import type { SpeciesSearchRequest } from '../types/species'
import type { CanopiFile } from '../types/design'
import type { AnalysisRequest, LidarDisplayRequest, LidarSamplePointsRequest } from '../generated/contracts'

const invoke = vi.hoisted(() => vi.fn(async (
  _command: string,
  _args?: Record<string, unknown>,
): Promise<unknown> => undefined))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const op = expect.stringMatching(/^u-/)

describe('native IPC wire format', () => {
  beforeEach(() => {
    invoke.mockClear()
  })

  it('sends species search as one request contract', async () => {
    const request: SpeciesSearchRequest = {
      text: 'malus',
      filters: {} as SpeciesSearchRequest['filters'],
      cursor: null,
      limit: 25,
      sort: 'Name',
      locale: 'en',
      include_total: false,
    }

    await searchSpecies(request)
    expect(invoke).toHaveBeenLastCalledWith('search_species', { request, operation: op })
    await supersedeSpeciesSearch()
    expect(invoke).toHaveBeenLastCalledWith('supersede_species_search', { operation: op })
    await getSpeciesDetail('Malus domestica', 'fr')
    expect(invoke).toHaveBeenLastCalledWith('get_species_detail', { canonicalName: 'Malus domestica', locale: 'fr', operation: op })
    await getFilterOptions()
    expect(invoke).toHaveBeenLastCalledWith('get_filter_options', { operation: op })
    await getDynamicFilterOptions(['habit'], 'en')
    expect(invoke).toHaveBeenLastCalledWith('get_dynamic_filter_options', { fields: ['habit'], locale: 'en', operation: op })
    await getCommonNames(['Malus domestica'], 'en')
    expect(invoke).toHaveBeenLastCalledWith('get_common_names', { canonicalNames: ['Malus domestica'], locale: 'en', operation: op })
    await getSpeciesHabits(['Malus domestica'])
    expect(invoke).toHaveBeenLastCalledWith('get_species_habits', { canonicalNames: ['Malus domestica'], operation: op })
    await getSpeciesBatch(['Malus domestica'], 'en')
    expect(invoke).toHaveBeenLastCalledWith('get_species_batch', { canonicalNames: ['Malus domestica'], locale: 'en', operation: op })
    await getFlowerColorBatch(['Malus domestica'])
    expect(invoke).toHaveBeenLastCalledWith('get_flower_color_batch', { canonicalNames: ['Malus domestica'], operation: op })
    await getLocaleCommonNames('Malus domestica', 'en')
    expect(invoke).toHaveBeenLastCalledWith('get_locale_common_names', { canonicalName: 'Malus domestica', locale: 'en', operation: op })
    await getSpeciesImages('Malus domestica')
    expect(invoke).toHaveBeenLastCalledWith('get_species_images', { canonicalName: 'Malus domestica', operation: op })
    await getCachedImagePath('https://example.invalid/a.jpg')
    expect(invoke).toHaveBeenLastCalledWith('get_cached_image_path', { url: 'https://example.invalid/a.jpg', operation: op })
  })

  it('names the app folder and Recent Design commands and their arguments', async () => {
    await getAppFolders()
    expect(invoke).toHaveBeenLastCalledWith('get_app_folders', { operation: op })
    await showAppFolder('data_library')
    expect(invoke).toHaveBeenLastCalledWith('show_app_folder', { folder: 'data_library', operation: op })
    await removeRecentDesign('/designs/a.canopi')
    expect(invoke).toHaveBeenLastCalledWith('remove_recent_design', { path: '/designs/a.canopi', operation: op })
    await showRecentDesignInFolder('/designs/a.canopi')
    expect(invoke).toHaveBeenLastCalledWith('show_recent_design_in_folder', { path: '/designs/a.canopi', operation: op })
    await readNewerDesign('{}')
    expect(invoke).toHaveBeenLastCalledWith('read_newer_design', { text: '{}', operation: op })
    await listDesignDrafts()
    expect(invoke).toHaveBeenLastCalledWith('list_design_drafts', { operation: op })
    await deleteDesignDraft('draft-1')
    expect(invoke).toHaveBeenLastCalledWith('delete_design_draft', { id: 'draft-1', operation: op })
    await newDesign()
    expect(invoke).toHaveBeenLastCalledWith('new_design', { operation: op })
    await getRecentFiles()
    expect(invoke).toHaveBeenLastCalledWith('get_recent_files', { operation: op })
    await getRecentDesignPreviews(['/designs/a.canopi'])
    expect(invoke).toHaveBeenLastCalledWith('get_recent_design_previews', { paths: ['/designs/a.canopi'], operation: op })
    await getDesignNotebook()
    expect(invoke).toHaveBeenLastCalledWith('get_design_notebook', { operation: op })
    await createNotebookSection('Orchards')
    expect(invoke).toHaveBeenLastCalledWith('create_notebook_section', { name: 'Orchards', operation: op })
    const content = {} as CanopiFile
    await addDesignReferenceToNotebook('/designs/a.canopi', content)
    expect(invoke).toHaveBeenLastCalledWith('add_design_reference_to_notebook', { path: '/designs/a.canopi', content, operation: op })
    await renameNotebookSection('sec-1', 'Food Forest')
    expect(invoke).toHaveBeenLastCalledWith('rename_notebook_section', { sectionId: 'sec-1', name: 'Food Forest', operation: op })
    await deleteNotebookSection('sec-1')
    expect(invoke).toHaveBeenLastCalledWith('delete_notebook_section', { sectionId: 'sec-1', operation: op })
    await moveDesignReferenceToSection('/designs/a.canopi', null)
    expect(invoke).toHaveBeenLastCalledWith('move_design_reference_to_section', { path: '/designs/a.canopi', sectionId: null, operation: op })
    await relocateDesignReference('/designs/a.canopi', 'sec-1', ['/designs/a.canopi'])
    expect(invoke).toHaveBeenLastCalledWith('relocate_design_reference', { path: '/designs/a.canopi', sectionId: 'sec-1', paths: ['/designs/a.canopi'], operation: op })
    await removeDesignReference('/designs/a.canopi')
    expect(invoke).toHaveBeenLastCalledWith('remove_design_reference', { path: '/designs/a.canopi', operation: op })
    await reorderNotebookSections(['sec-1'])
    expect(invoke).toHaveBeenLastCalledWith('reorder_notebook_sections', { sectionIds: ['sec-1'], operation: op })
    await reorderDesignReferences(['/designs/a.canopi'])
    expect(invoke).toHaveBeenLastCalledWith('reorder_design_references', { paths: ['/designs/a.canopi'], operation: op })
  })

  it('names the LiDAR library, analysis, sampling, and display commands and their arguments', async () => {
    await lidarListLibrary()
    expect(invoke).toHaveBeenLastCalledWith('lidar_list_library', { operation: op })
    await lidarImportItem('Site DEM', 'GroundElevation', { label: 'm', unknown: false }, ['/data/a.tif'])
    expect(invoke).toHaveBeenLastCalledWith('lidar_import_item', {
      name: 'Site DEM',
      quantity: 'GroundElevation',
      unitLabel: 'm',
      unitUnknown: false,
      paths: ['/data/a.tif'],
      operation: op,
    })
    await lidarRetryImport('layer-1')
    expect(invoke).toHaveBeenLastCalledWith('lidar_retry_import', { layerId: 'layer-1', operation: op })
    await lidarDismissImport('layer-1')
    expect(invoke).toHaveBeenLastCalledWith('lidar_dismiss_import', { layerId: 'layer-1', operation: op })
    await lidarRenameItem('item-1', 'Updated DEM')
    expect(invoke).toHaveBeenLastCalledWith('lidar_rename_item', { itemId: 'item-1', name: 'Updated DEM', operation: op })
    await lidarImportCoverage(['/data/a.tif'])
    expect(invoke).toHaveBeenLastCalledWith('lidar_import_coverage', { paths: ['/data/a.tif'], operation: op })
    await lidarLibraryDiskUsage()
    expect(invoke).toHaveBeenLastCalledWith('lidar_library_disk_usage', { operation: op })
    await lidarDeleteImpact('item-1')
    expect(invoke).toHaveBeenLastCalledWith('lidar_delete_impact', { itemId: 'item-1', operation: op })
    await lidarDeleteItem('item-1')
    expect(invoke).toHaveBeenLastCalledWith('lidar_delete_item', { itemId: 'item-1', operation: op })
    await lidarCancelImport('job-1')
    expect(invoke).toHaveBeenLastCalledWith('lidar_cancel_import', { jobId: 'job-1', operation: op })
    const analysisReq = {} as AnalysisRequest
    await lidarCreateAnalysis(analysisReq)
    expect(invoke).toHaveBeenLastCalledWith('lidar_create_analysis', { request: analysisReq, operation: op })
    await lidarRerunAnalysis('def-1')
    expect(invoke).toHaveBeenLastCalledWith('lidar_rerun_analysis', { definitionId: 'def-1', operation: op })
    await lidarCancelAnalysisJob('job-2')
    expect(invoke).toHaveBeenLastCalledWith('lidar_cancel_analysis_job', { jobId: 'job-2', operation: op })
    await lidarProcessingHistory('def-1', 'cur-1')
    expect(invoke).toHaveBeenLastCalledWith('lidar_processing_history', { definitionId: 'def-1', cursor: 'cur-1', operation: op })
    await lidarLayerCollection('layer-1', null)
    expect(invoke).toHaveBeenLastCalledWith('lidar_layer_collection', { layerId: 'layer-1', cursor: null, operation: op })
    const sampleReq = {} as LidarSamplePointsRequest
    await lidarSamplePoints(sampleReq)
    expect(invoke).toHaveBeenLastCalledWith('lidar_sample_points', { request: sampleReq, operation: op })
    const displayReq = {} as LidarDisplayRequest
    await lidarDisplayDescriptor(displayReq)
    expect(invoke).toHaveBeenLastCalledWith('lidar_display_descriptor', { request: displayReq, operation: op })
  })
})
