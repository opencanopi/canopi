import { invokeTyped, mintOperationId } from './transport'
import type { HomeRead, HomeVersion, HomeWrite } from '../generated/contracts'

/**
 * Desktop Design home IPC wrappers (`home_read` / `home_write`, 2b-4; contracts §4, ADR 0027).
 *
 * Accepts an opaque home key (`FileGrantId` or `DraftId`) without branching on kind; the
 * Desktop host resolves grants to their canonical paths and Draft ids to `drafts/<id>.canopi`.
 */
export async function homeRead(key: string): Promise<HomeRead> {
  return invokeTyped('home_read', { key }, mintOperationId('s'))
}

export async function homeWrite(
  key: string,
  bytes: Uint8Array,
  expected: HomeVersion | null,
  keepPrevious = false,
): Promise<HomeWrite> {
  return invokeTyped(
    'home_write',
    {
      key,
      bytes: Array.from(bytes),
      expected,
      keepPrevious,
    },
    mintOperationId('u'),
  )
}
