// @vitest-environment jsdom

import { effect } from '@preact/signals'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolId } from '../canvas/runtime/interaction-types'
import {
  currentCanvasSession,
  currentCanvasTool,
  getCurrentCanvasCommandSurface,
  getCurrentCanvasSession,
  getCurrentCanvasViewportCommandSurface,
  setCurrentCanvasSession,
} from '../canvas/session'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'

describe('canvas session seam', () => {
  beforeEach(() => {
    setCurrentCanvasSession(null)
  })

  it('stores explicit runtime surfaces for the live runtime', () => {
    const surfaces = createTestCanvasRuntimeSurfaces()

    setCurrentCanvasSession(surfaces)

    expect(getCurrentCanvasSession()).toBe(surfaces)
    expect(currentCanvasSession.value).toBe(surfaces)

    setCurrentCanvasSession(null)

    expect(currentCanvasSession.value).toBe(null)
  })

  it('publishes the session identity consistently across reentrant release', () => {
    const surfaces = createTestCanvasRuntimeSurfaces()
    const disposeEffect = effect(() => {
      if (currentCanvasSession.value === surfaces) {
        setCurrentCanvasSession(null)
      }
    })

    setCurrentCanvasSession(surfaces)

    expect(currentCanvasSession.value).toBeNull()
    disposeEffect()
  })

  it('derives currentCanvasTool from the mounted query surface and updates via commands.tools.arm', () => {
    expect(currentCanvasTool.value).toBe('select')

    const queries = createTestCanvasQuerySurface({ activeTool: 'rectangle' })
    const arm = vi.fn((_id: ToolId) => ({ settled: new Promise<never>(() => {}), cancel: () => {} }))
    const surfaces = createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        tools: {
          arm,
        },
      }),
      queries,
    })
    setCurrentCanvasSession(surfaces)
    expect(currentCanvasTool.value).toBe('rectangle')

    surfaces.commands.tools.arm('hand')

    expect(getCurrentCanvasCommandSurface()).toBe(currentCanvasSession.value?.commands)
    expect(getCurrentCanvasViewportCommandSurface()).toBe(currentCanvasSession.value?.commands.viewport)
    expect(arm).toHaveBeenCalledWith('hand', undefined, undefined)
    expect(currentCanvasTool.value).toBe('hand')
  })

  it('does not pre-publish a mounted tool change that the command surface rejects', () => {
    const queries = createTestCanvasQuerySurface({ activeTool: 'rectangle' })
    const arm = vi.fn(() => {
      throw new Error('tool transition failed')
    })
    const surfaces = createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ tools: { arm } }),
      queries,
    })
    setCurrentCanvasSession(surfaces)

    expect(() => surfaces.commands.tools.arm('hand')).toThrow('tool transition failed')

    expect(arm).toHaveBeenCalledWith('hand', undefined, undefined)
    expect(currentCanvasTool.value).toBe('rectangle')
  })
})
