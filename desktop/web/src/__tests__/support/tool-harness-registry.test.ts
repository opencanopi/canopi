import { describe, expect, it, vi } from 'vitest'

import { TOOL_REGISTRY } from '../../canvas/runtime/tools/registry'
import './tool-harness'

vi.mock('../../canvas/runtime/tools/registry', () => ({ TOOL_REGISTRY: {} }))

/** The replaced registry's tools before any hook runs: what a shuffled run's first test builds its session from. */
const toolsAtLoad = Object.entries(TOOL_REGISTRY).filter(([, factory]) => typeof factory === 'function').map(([id]) => id)

describe('tool harness registry', () => {
  it('the replaced tool registry lists every tool before the first test, so any test can run first (canopi-f47t.52.228.55)', () => {
    expect(toolsAtLoad.sort()).toEqual([
      'ellipse', 'hand', 'line', 'measurement-guide', 'object-stamp', 'plant-spacing', 'plant-stamp', 'polygon', 'profile',
      'rectangle', 'saved-object-stamp', 'select', 'text',
    ])
  })
})
