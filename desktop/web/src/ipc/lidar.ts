import { invokeCommand } from './transport'
import type {
  AnalysisReceipt,
  AnalysisRequest,
  LibraryDeleteImpact,
  LibrarySnapshot,
  LidarDisplayDescriptor,
  LidarDisplayRequest,
  LidarImportCoverage,
  LidarImportReceipt,
  LidarLayerCollection,
  LidarSamplePointsRequest,
  LidarSampleSeries,
  ProcessingHistoryPage,
  RasterQuantity,
} from '../generated/contracts'

export type {
  AnalysisReceipt,
  LibraryDeleteImpact,
  LidarDisplayDescriptor,
  LidarImportReceipt,
  LidarLayerCollection,
  ProcessingHistoryPage,
} from '../generated/contracts'

export async function lidarListLibrary(): Promise<LibrarySnapshot> {
  return invokeCommand('lidar_list_library')
}

/**
 * Import the chosen files as one new fixed library item.
 *
 * The item and its job are created together only on submission; the files'
 * order is the item's source priority. Import never attaches to a Design.
 * Only importable quantities are accepted; derived ones are refused by name.
 */
export async function lidarImportItem(
  name: string,
  quantity: RasterQuantity,
  unit: { label: string | null; unknown: boolean },
  paths: string[],
): Promise<LidarImportReceipt> {
  return invokeCommand('lidar_import_item', {
    name,
    quantity,
    unitLabel: unit.label,
    unitUnknown: unit.unknown,
    paths,
  })
}

/** Retry a failed import with its saved selection and identity. */
export async function lidarRetryImport(layerId: string): Promise<LidarImportReceipt> {
  return invokeCommand('lidar_retry_import', { layerId })
}

/** Remove an unpublished item whose import failed. */
export async function lidarDismissImport(layerId: string): Promise<void> {
  return invokeCommand('lidar_dismiss_import', { layerId })
}

/** Rename one library item, source or derived. */
export async function lidarRenameItem(itemId: string, name: string): Promise<void> {
  return invokeCommand('lidar_rename_item', { itemId, name })
}

/** Import › "Covers your site": the box around the chosen files, read before import. */
export async function lidarImportCoverage(paths: readonly string[]): Promise<LidarImportCoverage> {
  return invokeCommand('lidar_import_coverage', { paths })
}

/** Bytes the Data library occupies on this device. */
export async function lidarLibraryDiskUsage(): Promise<number> {
  return invokeCommand('lidar_library_disk_usage')
}

export async function lidarDeleteImpact(itemId: string): Promise<LibraryDeleteImpact> {
  return invokeCommand('lidar_delete_impact', { itemId })
}

/** Refused natively while other derived items use this item as an input. */
export async function lidarDeleteItem(itemId: string): Promise<void> {
  return invokeCommand('lidar_delete_item', { itemId })
}

export async function lidarCancelImport(jobId: string): Promise<void> {
  return invokeCommand('lidar_cancel_import', { jobId })
}

/** Create one analysis definition from a registry entry and start its first run. */
export async function lidarCreateAnalysis(request: AnalysisRequest): Promise<AnalysisReceipt> {
  return invokeCommand('lidar_create_analysis', { request })
}

/**
 * Run one definition again with its saved inputs and parameters.
 *
 * Retry when it has no result yet; Refresh when it has one, which republishes
 * in place under the same item ids while the earlier run stays in history.
 */
export async function lidarRerunAnalysis(definitionId: string): Promise<AnalysisReceipt> {
  return invokeCommand('lidar_rerun_analysis', { definitionId })
}

export async function lidarCancelAnalysisJob(jobId: string): Promise<void> {
  return invokeCommand('lidar_cancel_analysis_job', { jobId })
}

/** One bounded page of a definition's runs, newest first. */
export async function lidarProcessingHistory(
  definitionId: string,
  cursor: string | null = null,
): Promise<ProcessingHistoryPage> {
  return invokeCommand('lidar_processing_history', { definitionId, cursor })
}

/**
 * One bounded page of an item's ordered sources, read-only: details show the
 * source files; published items are never edited.
 */
export async function lidarLayerCollection(
  layerId: string,
  cursor: string | null = null,
): Promise<LidarLayerCollection> {
  return invokeCommand('lidar_layer_collection', { layerId, cursor })
}

/**
 * Sample up to LIDAR_SAMPLE_MAX_TARGETS items at up to LIDAR_SAMPLE_MAX_POINTS
 * WGS84 points in one request (canopi-f47t.42, spec §1.10): one series per
 * target, in target order, each value the native cell under its point. Each
 * target names the generation it expects, so a moved head answers Unavailable
 * rather than newer data. Only `app/lidar/sampler.ts` calls it.
 */
export async function lidarSamplePoints(request: LidarSamplePointsRequest): Promise<LidarSampleSeries[]> {
  return invokeCommand('lidar_sample_points', { request })
}

/**
 * Describe one entity's display derivatives, starting their preparation when
 * missing. The expected generation fences the answer: a head that moved since
 * the caller aimed returns `Stale`, never newer data under the old identity.
 */
export async function lidarDisplayDescriptor(
  request: LidarDisplayRequest,
): Promise<LidarDisplayDescriptor> {
  return invokeCommand('lidar_display_descriptor', { request })
}
