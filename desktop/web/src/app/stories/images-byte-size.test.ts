// 2.1-Q359's decimal SI byte sizes for story images: 1,500,000 bytes read 1.5 MB, not the binary 1.4.

import { describe, expect, it } from 'vitest'
import { formatByteSize } from '../../utils/format'

describe('2.1-Q359 byte sizes of story images', () => {
  it('Q359 (2a-3): an image of 1,500,000 bytes reads 1.5 MB', () => {
    expect(formatByteSize(1_500_000, 'en')).toBe('1.5 MB')
  })
})
