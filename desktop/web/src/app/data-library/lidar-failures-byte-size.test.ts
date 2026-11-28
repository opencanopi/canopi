// 2.1-Q359 decimal SI byte sizes in Data library refusals: the import limits are unchanged
// (512 MiB per source, 2 GiB per import), so their labels read 537 MB and 2.1 GB.

import { afterEach, describe, expect, it } from 'vitest'
import { locale } from '../settings/state'
import { lidarFailureMessage } from './lidar-failures'

afterEach(() => {
  locale.value = 'en'
})

describe('2.1-Q359 byte sizes in the Data library refusals', () => {
  it('Q359 (2a-3): a source over the 512 MiB limit is refused with the limit read as 537 MB', () => {
    locale.value = 'en'
    const message = lidarFailureMessage({ reason: { kind: 'SourceTooLarge', file: 'dense.laz', limit_mib: 512 }, detail: 'x' }, false)
    expect(message).toContain('537 MB')
  })

  it('Q359 (2a-3): an import over the 2 GiB limit is refused with the limit read as 2.1 GB, in the user locale', () => {
    locale.value = 'en'
    expect(lidarFailureMessage({ reason: { kind: 'ImportTooLarge', limit_mib: 2048 }, detail: 'x' }, false)).toContain('2.1 GB')
    locale.value = 'fr'
    expect(lidarFailureMessage({ reason: { kind: 'ImportTooLarge', limit_mib: 2048 }, detail: 'x' }, false)).toMatch(/2,1\s?Go/u)
  })
})
