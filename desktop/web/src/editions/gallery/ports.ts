import type { CommandMap, CommandName } from '../../generated/command-map'
import { capabilitiesForEdition } from '../../generated/edition-capabilities'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { EditionPorts } from '../../platform/edition-ports'
import type { DataLibraryPort } from '../../platform/library'
import { activeCommandTransport } from '../../types/command-transport'
import { mintOperationId } from '../../utils/ids'
import { createFakeFileDelivery } from './fakes/file-delivery.fake'

const UNAVAILABLE = 'not_on_this_edition' as const

async function invokeGallery<K extends CommandName>(
  command: K,
  args?: Record<string, unknown>,
): Promise<CommandMap[K]['reply']> {
  const transport = activeCommandTransport()
  if (!transport) throw new Error(`Gallery command transport is not installed for ${command}`)
  return await transport(command, args, mintOperationId('u')) as CommandMap[K]['reply']
}

function createGalleryDataLibraryPort(): DataLibraryPort {
  return {
    listLibrary: () => invokeGallery('lidar_list_library'),
    importItem: (name, quantity, unit, paths) => invokeGallery('lidar_import_item', {
      name,
      quantity,
      unitLabel: unit.label,
      unitUnknown: unit.unknown,
      paths,
    }),
    retryImport: (layerId) => invokeGallery('lidar_retry_import', { layerId }),
    dismissImport: (layerId) => invokeGallery('lidar_dismiss_import', { layerId }),
    renameItem: (itemId, name) => invokeGallery('lidar_rename_item', { itemId, name }),
    importCoverage: (paths) => invokeGallery('lidar_import_coverage', { paths }),
    diskUsage: () => invokeGallery('lidar_library_disk_usage'),
    deleteImpact: (itemId) => invokeGallery('lidar_delete_impact', { itemId }),
    deleteItem: (itemId) => invokeGallery('lidar_delete_item', { itemId }),
    cancelImport: (jobId) => invokeGallery('lidar_cancel_import', { jobId }),
    createAnalysis: (request) => invokeGallery('lidar_create_analysis', { request }),
    rerunAnalysis: (definitionId) => invokeGallery('lidar_rerun_analysis', { definitionId }),
    cancelAnalysisJob: (jobId) => invokeGallery('lidar_cancel_analysis_job', { jobId }),
    processingHistory: (definitionId, cursor = null) => invokeGallery('lidar_processing_history', { definitionId, cursor }),
    layerCollection: (layerId, cursor = null) => invokeGallery('lidar_layer_collection', { layerId, cursor }),
    samplePoints: (request) => invokeGallery('lidar_sample_points', { request }),
    displayDescriptor: (request) => invokeGallery('lidar_display_descriptor', { request }),
    pickGeotiffFiles: () => invokeGallery('pick_open', { kind: 'lidar-geotiff-import' }),
    showDataLibraryFolder: () => invokeGallery('show_app_folder', { folder: 'data_library' }),
    resolveAssetUrl: (path) => path,
  }
}

export function createGalleryEditionPorts(edition: 'desktop' | 'web'): EditionPorts {
  return {
    capabilities: capabilitiesForEdition(edition, 'linux'),
    settings: {
      load: () => ({ ...DEFAULT_SETTINGS }),
      save: async () => {},
    },
    problemReport: {
      sections: {
        build: UNAVAILABLE,
        health: UNAVAILABLE,
        queues: UNAVAILABLE,
        native_settlements: UNAVAILABLE,
        jobs: UNAVAILABLE,
        library_disk: UNAVAILABLE,
        log_tail: UNAVAILABLE,
        settings_summary: UNAVAILABLE,
      },
      currentDesign: () => null,
      write: async () => ({ file_name: 'gallery-report.zip' }),
    },
    geocoding: async () => [],
    fileDelivery: createFakeFileDelivery('downloaded'),
    dataLibrary: createGalleryDataLibraryPort(),
    designHome: {
      read: async () => ({ kind: 'absent' }),
      write: async () => ({ kind: 'written', version: 'gallery-v1' }),
      listDrafts: async () => [],
      deleteDraft: async () => ({ ok: true }),
      onVersionChange: () => () => {},
    },
    fileAccess: {
      pickOpen: async () => ({ kind: 'cancelled' }),
      pickHomeTarget: async () => ({ kind: 'cancelled' }),
    },
    appLifecycle: {
      subscribe: () => () => {},
    },
    designCore: {
      version: async () => 'gallery',
      decode: async () => {
        throw new Error('Gallery edition does not decode Designs')
      },
      encode: async () => {
        throw new Error('Gallery edition does not encode Designs')
      },
      newDesign: async () => {
        throw new Error('Gallery edition does not construct Designs')
      },
      draftSummary: async () => {
        throw new Error('Gallery edition does not summarise Drafts')
      },
      decodeStamp: async () => {
        throw new Error('Gallery edition does not decode stamps')
      },
      encodeStamp: async () => {
        throw new Error('Gallery edition does not encode stamps')
      },
    },
  }
}
