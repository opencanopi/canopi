// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopKeys } from '../../../__tests__/support/desktop-key-router'
import { pressKey } from '../../../__tests__/support/key-router'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from '../../../__tests__/support/canvas-runtime-surfaces'
import {
  createToolHarness,
  plantEntity,
  useStubTools,
  type ToolHarness,
} from '../../../__tests__/support/tool-harness'
import { setCurrentCanvasSession } from '../../session'
import type { ToolId } from '../interaction-types'
import { createPanTool } from './pan'
import type { ToolGesture } from './tool'

vi.mock('./registry', () => ({ TOOL_REGISTRY: {} }))

const harnesses: ToolHarness[] = []

function panHarness(): { readonly h: ToolHarness; readonly gestures: ToolGesture['kind'][] } {
  const tool = createPanTool()
  const gestures: ToolGesture['kind'][] = []
  const gesture = tool.gesture.bind(tool)
  tool.gesture = (g) => {
    gestures.push(g.kind)
    return gesture(g)
  }
  useStubTools(tool)
  const h = createToolHarness({ scene: { plants: [plantEntity('apple', 'Malus domestica', { x: 100, y: 100 })] } })
  harnesses.push(h)
  return { h, gestures }
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.dispose()
  setCurrentCanvasSession(null)
})

describe('Pan tool', () => {
  it('H arms Pan, whose cursor is grab (its drag\'s pan is fixture G8 in input/recognise.test.ts)', () => {
    const { h } = panHarness()
    // The key path: the Desktop key router's H row arms the tool through the canvas command surface.
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ tools: { setTool: (id: string) => h.arm(id as ToolId) } }),
    }))

    const keys = installDesktopKeys()
    expect(pressKey({ key: 'h' }).defaultPrevented).toBe(true)
    keys.dispose()

    expect(h.toolState.peek()).toBe('hand')
    expect(h.chrome.cursor).toBe('grab')
  })

  it('shows the grab cursor and no guidance, and leaves presses, taps and hovers to the host', () => {
    const { h, gestures } = panHarness()
    h.arm('hand')
    h.renderer.clear()

    h.hover({ x: 100, y: 100 })
    h.click({ x: 100, y: 100 })

    expect(h.chrome.cursor).toBe('grab')
    expect(h.record.guidance.at(-1)).toEqual({ gesture: false, stamp: null, stampRotationDeg: null, speciesPrompts: 0, plantRow: null })
    expect(gestures).toEqual(['hover', 'press', 'tap'])
    // A hover passes: the plant's hover restyle and tooltip run as under Select.
    expect(h.record.hovers).toContainEqual({ kind: 'plant', id: 'apple' })
    expect(h.store.session.selectedTargets).toEqual([])
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
  })
})
