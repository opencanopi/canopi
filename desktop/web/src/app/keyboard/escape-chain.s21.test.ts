// S21 Esc table test (2c-1, 2-1-foundations.md:295,297):
// Verifies the full Escape priority stack (popover > gesture > nudge-series > tool-transient > tool > selection > profile > site-pin)
// and that every tool row's declared escSteps match the Escape chain's admitted layers.
import { describe, expect, it, vi } from 'vitest'
import { TOOL_IDS, TOOL_ROWS } from '../command-table'
import { ESCAPE_PRIORITY, registerCanvasEscapeLayers, registerEscapeLayer, runEscape } from './escape-chain'
import type { KeyboardEventLike } from './key-chord'
import type { CanvasEscapeLayer, CanvasKeyboardPort } from '../../canvas/runtime/runtime'

const UNMODIFIED_ESC: KeyboardEventLike = {
  type: 'keydown',
  key: 'Escape',
  code: 'Escape',
  keyCode: 27,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  defaultPrevented: false,
  cancelable: true,
  timeStamp: 0,
  target: null,
  preventDefault() {},
  stopPropagation() {},
}

describe('S21 Esc table (2c-1)', () => {
  it('fires active layers strictly in priority order from popover down to site-pin', () => {
    const fired: string[] = []
    const active = new Set<string>(['popover', 'gesture', 'nudge-series', 'tool-transient', 'tool', 'selection', 'profile', 'site-pin'])
    const disposers: (() => void)[] = []

    const port: CanvasKeyboardPort = {
      escapeLayers: () => (['gesture', 'nudge-series', 'tool-transient', 'tool', 'selection'] as CanvasEscapeLayer[]).filter((l) => active.has(l)),
      escape(layer: CanvasEscapeLayer) {
        fired.push(layer)
        active.delete(layer)
      },
      keyDown: vi.fn(() => false),
      keyUp: vi.fn(),
      cancelTransient: vi.fn(),
    } as unknown as CanvasKeyboardPort

    disposers.push(registerCanvasEscapeLayers(() => port))
    for (const id of ['popover', 'profile', 'site-pin'] as const) {
      disposers.push(registerEscapeLayer({
        priority: ESCAPE_PRIORITY[id],
        isActive: () => active.has(id),
        escape() {
          fired.push(id)
          active.delete(id)
          return true
        },
      }))
    }

    try {
      while (runEscape({ event: UNMODIFIED_ESC, focus: 'map' })) {
        // drain all active layers one Esc at a time
      }
      expect(fired).toEqual([
        'popover',
        'gesture',
        'nudge-series',
        'tool-transient',
        'tool',
        'selection',
        'profile',
        'site-pin',
      ])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('every tool row declares escSteps in strictly descending ESCAPE_PRIORITY order', () => {
    for (const id of TOOL_IDS) {
      const steps: readonly (keyof typeof ESCAPE_PRIORITY)[] = TOOL_ROWS[id].escSteps
      expect(steps.length, `Tool '${id}' must declare at least one escStep`).toBeGreaterThan(0)
      for (let i = 1; i < steps.length; i += 1) {
        expect(
          ESCAPE_PRIORITY[steps[i - 1]!],
          `Tool '${id}' escSteps out of priority order: ${steps[i - 1]} before ${steps[i]}`,
        ).toBeGreaterThan(ESCAPE_PRIORITY[steps[i]!])
      }
      if (id === 'select') {
        expect(steps).toContain('selection')
        expect(steps).not.toContain('tool')
      } else {
        expect(steps).toContain('tool')
      }
    }
  })
})
