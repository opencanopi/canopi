/**
 * editions/desktop/library.ts: Desktop L1 Data library adapter over IPC (2.1-M4, 2.1-M12, 2.1-M84).
 */
import { pickOpen } from '../../ipc/dialogs'
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
} from '../../ipc/lidar'
import { showAppFolder } from '../../ipc/settings'
import { nativeAssetUrl } from '../../ipc/transport'
import type { DataLibraryPort } from '../../platform/library'

export const desktopDataLibraryPort: DataLibraryPort = {
  listLibrary: (...args) => lidarListLibrary(...args),
  importItem: (...args) => lidarImportItem(...args),
  retryImport: (...args) => lidarRetryImport(...args),
  dismissImport: (...args) => lidarDismissImport(...args),
  renameItem: (...args) => lidarRenameItem(...args),
  importCoverage: (...args) => lidarImportCoverage(...args),
  diskUsage: (...args) => lidarLibraryDiskUsage(...args),
  deleteImpact: (...args) => lidarDeleteImpact(...args),
  deleteItem: (...args) => lidarDeleteItem(...args),
  cancelImport: (...args) => lidarCancelImport(...args),
  createAnalysis: (...args) => lidarCreateAnalysis(...args),
  rerunAnalysis: (...args) => lidarRerunAnalysis(...args),
  cancelAnalysisJob: (...args) => lidarCancelAnalysisJob(...args),
  processingHistory: (...args) => lidarProcessingHistory(...args),
  layerCollection: (...args) => lidarLayerCollection(...args),
  samplePoints: (...args) => lidarSamplePoints(...args),
  displayDescriptor: (...args) => lidarDisplayDescriptor(...args),
  pickGeotiffFiles: () => pickOpen('lidar-geotiff-import'),
  showDataLibraryFolder: () => showAppFolder('data_library'),
  resolveAssetUrl: (path) => nativeAssetUrl(path),
}
