/**
 * platform/library.ts: L1 Data library port (2.1-M4, 2.1-M12, 2.1-M84).
 * Display URLs come only from the real host `convertFileSrc` resolver installed at Desktop boot,
 * with no hand-built `asset://` replica.
 */
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
  PickOpenOutcome,
  ProcessingHistoryPage,
  RasterQuantity,
} from '../generated/contracts'

export type {
  LidarDisplayDescriptor,
  LidarImportReceipt,
  LidarLayerCollection,
} from '../generated/contracts'

export interface DataLibraryPort {
  listLibrary(): Promise<LibrarySnapshot>
  importItem(
    name: string,
    quantity: RasterQuantity,
    unit: { label: string | null; unknown: boolean },
    paths: string[],
  ): Promise<LidarImportReceipt>
  retryImport(layerId: string): Promise<LidarImportReceipt>
  dismissImport(layerId: string): Promise<void>
  renameItem(itemId: string, name: string): Promise<void>
  importCoverage(paths: readonly string[]): Promise<LidarImportCoverage>
  diskUsage(): Promise<number>
  deleteImpact(itemId: string): Promise<LibraryDeleteImpact>
  deleteItem(itemId: string): Promise<void>
  cancelImport(jobId: string): Promise<void>
  createAnalysis(request: AnalysisRequest): Promise<AnalysisReceipt>
  rerunAnalysis(definitionId: string): Promise<AnalysisReceipt>
  cancelAnalysisJob(jobId: string): Promise<void>
  processingHistory(definitionId: string, cursor?: string | null): Promise<ProcessingHistoryPage>
  layerCollection(layerId: string, cursor?: string | null): Promise<LidarLayerCollection>
  samplePoints(request: LidarSamplePointsRequest): Promise<LidarSampleSeries[]>
  displayDescriptor(request: LidarDisplayRequest): Promise<LidarDisplayDescriptor>
  pickGeotiffFiles(): Promise<PickOpenOutcome>
  showDataLibraryFolder(): Promise<void>
  resolveAssetUrl(path: string): string
}

const unsupported = (method: string): never => {
  throw new Error(`DataLibraryPort.${method} is not available in this edition`)
}

export function createUnsupportedDataLibraryPort(): DataLibraryPort {
  return {
    listLibrary: () => unsupported('listLibrary'),
    importItem: () => unsupported('importItem'),
    retryImport: () => unsupported('retryImport'),
    dismissImport: () => unsupported('dismissImport'),
    renameItem: () => unsupported('renameItem'),
    importCoverage: () => unsupported('importCoverage'),
    diskUsage: () => unsupported('diskUsage'),
    deleteImpact: () => unsupported('deleteImpact'),
    deleteItem: () => unsupported('deleteItem'),
    cancelImport: () => unsupported('cancelImport'),
    createAnalysis: () => unsupported('createAnalysis'),
    rerunAnalysis: () => unsupported('rerunAnalysis'),
    cancelAnalysisJob: () => unsupported('cancelAnalysisJob'),
    processingHistory: () => unsupported('processingHistory'),
    layerCollection: () => unsupported('layerCollection'),
    samplePoints: () => unsupported('samplePoints'),
    displayDescriptor: () => unsupported('displayDescriptor'),
    pickGeotiffFiles: () => unsupported('pickGeotiffFiles'),
    showDataLibraryFolder: () => unsupported('showDataLibraryFolder'),
    resolveAssetUrl: () => unsupported('resolveAssetUrl'),
  }
}
