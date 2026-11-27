import { desktopDataLibraryPort } from '../../editions/desktop/library'
import { createFakeFileDelivery } from '../../editions/gallery/fakes/file-delivery.fake'
import { createGalleryEditionPorts } from '../../editions/gallery/ports'
import type { EditionPorts } from '../../platform/edition-ports'
import { createTestDesignCore } from './design-wire'

export function createTestEditionPorts(overrides: Partial<EditionPorts> = {}): EditionPorts {
  const base = createGalleryEditionPorts('desktop')
  return {
    ...base,
    designCore: createTestDesignCore(),
    problemReport: {
      ...base.problemReport,
      write: async () => ({ file_name: 'test-report.zip' }),
    },
    fileDelivery: createFakeFileDelivery('saved'),
    dataLibrary: desktopDataLibraryPort,
    ...overrides,
  }
}
