import { invokeTyped, mintOperationId } from './transport'
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

export async function lidarListLibrary(): Promise<LibrarySnapshot> {
  return invokeTyped('lidar_list_library', undefined, mintOperationId('u'))
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
  return invokeTyped('lidar_import_item', {
    name,
    quantity,
    unitLabel: unit.label,
    unitUnknown: unit.unknown,
    paths,
  }, mintOperationId('u'))
}

/** Retry a failed import with its saved selection and identity. */
export async function lidarRetryImport(layerId: string): Promise<LidarImportReceipt> {
  return invokeTyped('lidar_retry_import', { layerId }, mintOperationId('u'))
}

/** Remove an unpublished item whose import failed. */
export async function lidarDismissImport(layerId: string): Promise<void> {
  return invokeTyped('lidar_dismiss_import', { layerId }, mintOperationId('u'))
}

/** Rename one library item, source or derived. */
export async function lidarRenameItem(itemId: string, name: string): Promise<void> {
  return invokeTyped('lidar_rename_item', { itemId, name }, mintOperationId('u'))
}

/** Import › "Covers your site": the box around the chosen files, read before import. */
export async function lidarImportCoverage(paths: readonly string[]): Promise<LidarImportCoverage> {
  return invokeTyped('lidar_import_coverage', { paths }, mintOperationId('u'))
}

/** Bytes the Data library occupies on this device. */
export async function lidarLibraryDiskUsage(): Promise<number> {
  return invokeTyped('lidar_library_disk_usage', undefined, mintOperationId('u'))
}

export async function lidarDeleteImpact(itemId: string): Promise<LibraryDeleteImpact> {
  return invokeTyped('lidar_delete_impact', { itemId }, mintOperationId('u'))
}

/** Refused natively while other derived items use this item as an input. */
export async function lidarDeleteItem(itemId: string): Promise<void> {
  return invokeTyped('lidar_delete_item', { itemId }, mintOperationId('u'))
}

export async function lidarCancelImport(jobId: string): Promise<void> {
  return invokeTyped('lidar_cancel_import', { jobId }, mintOperationId('u'))
}

/** Create one analysis definition from a registry entry and start its first run. */
export async function lidarCreateAnalysis(request: AnalysisRequest): Promise<AnalysisReceipt> {
  return invokeTyped('lidar_create_analysis', { request }, mintOperationId('u'))
}

/**
 * Run one definition again with its saved inputs and parameters.
 *
 * Retry when it has no result yet; Refresh when it has one, which republishes
 * in place under the same item ids while the earlier run stays in history.
 */
export async function lidarRerunAnalysis(definitionId: string): Promise<AnalysisReceipt> {
  return invokeTyped('lidar_rerun_analysis', { definitionId }, mintOperationId('u'))
}

export async function lidarCancelAnalysisJob(jobId: string): Promise<void> {
  return invokeTyped('lidar_cancel_analysis_job', { jobId }, mintOperationId('u'))
}

/** One bounded page of a definition's runs, newest first. */
export async function lidarProcessingHistory(
  definitionId: string,
  cursor: string | null = null,
): Promise<ProcessingHistoryPage> {
  return invokeTyped('lidar_processing_history', { definitionId, cursor }, mintOperationId('u'))
}

/**
 * One bounded page of an item's ordered sources, read-only: details show the
 * source files; published items are never edited.
 */
export async function lidarLayerCollection(
  layerId: string,
  cursor: string | null = null,
): Promise<LidarLayerCollection> {
  return invokeTyped('lidar_layer_collection', { layerId, cursor }, mintOperationId('u'))
}

/**
 * Sample up to LIDAR_SAMPLE_MAX_TARGETS items at up to LIDAR_SAMPLE_MAX_POINTS
 * WGS84 points in one request (canopi-f47t.42, spec §1.10): one series per
 * target, in target order, each value the native cell under its point. Each
 * target names the generation it expects, so a moved head answers Unavailable
 * rather than newer data. Only `app/lidar/sampler.ts` calls it.
 */
export async function lidarSamplePoints(request: LidarSamplePointsRequest): Promise<LidarSampleSeries[]> {
  return invokeTyped('lidar_sample_points', { request }, mintOperationId('u'))
}

/**
 * Describe one entity's display derivatives, starting their preparation when
 * missing. The expected generation fences the answer: a head that moved since
 * the caller aimed returns `Stale`, never newer data under the old identity.
 */
export async function lidarDisplayDescriptor(
  request: LidarDisplayRequest,
): Promise<LidarDisplayDescriptor> {
  return invokeTyped('lidar_display_descriptor', { request }, mintOperationId('u'))
}
