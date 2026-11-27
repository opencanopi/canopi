/**
 * editions/gallery/fakes/file-delivery.fake.ts: Recorder fake for FileDeliveryPort (contracts §13, §16).
 */
import type {
  FileDeliveryContent,
  FileDeliveryKind,
  FileDeliveryOutcome,
  FileDeliveryPort,
} from '../../../platform/file-delivery'

interface RecordedFileDelivery {
  readonly kind: FileDeliveryKind
  readonly stem: string
  readonly content: FileDeliveryContent
}

export interface FakeFileDelivery extends FileDeliveryPort {
  readonly calls: readonly RecordedFileDelivery[]
}

export function createFakeFileDelivery(
  outcome: FileDeliveryOutcome = 'downloaded',
): FakeFileDelivery {
  const calls: RecordedFileDelivery[] = []
  return {
    calls,
    async deliverFile(kind, stem, content, signal) {
      if (signal?.aborted) return 'cancelled'
      calls.push({ kind, stem, content })
      return outcome
    },
    dispose() {},
  }
}
