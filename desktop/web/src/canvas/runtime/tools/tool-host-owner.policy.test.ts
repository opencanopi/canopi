// ToolHost owner policy & map-input settlement test (2c-1, ADR 0024, contracts §18 F29, 2.1-M77, 2.1-Q364).
// Verifies:
// 1. ToolHost is the sole owner of the active tool and armed source (`L11`, "tool copies 3 to 1").
// 2. `tools.arm(id, source, request)` settles each map input request AT MOST ONCE with:
//    `picked | cancelled{reason: 'escape' | 'tool-change' | 'design-closed' | 'superseded'} | detached`.
// 3. `siteData.pin` tool row settles on tap with the ground point (click to pin, click again to move, 2.1-Q364).
import { describe, expect, it, vi } from 'vitest'
import { signal } from '@preact/signals'
import * as sessionState from '../../session-state'
import * as session from '../../session'
import { TOOL_ROWS } from '../../../app/command-table'
import { createScreenAlignedBounds } from '../zone-geometry'
import { createToolHost } from './tool-host'
import type { ToolHostDeps } from '../interaction-ports'
import type { MapInputOutcome } from '../interaction-types'
import type { ViewFrame } from '../../../geo/view/types'

function makeViewFrame(): ViewFrame {
  const screen = { width: 800, height: 600 }
  const view = {
    camera: { bearingDeg: 0, zoom: 18 },
    screen,
    pixelsPerMetre: 1,
    planeRevision: 1,
    metresPerPixelAt: () => 1,
    screenDistance: (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y),
    screenAxesInWorld: () => ({ right: { x: 1, y: 0 }, down: { x: 0, y: 1 } }),
    worldDeltaToScreen: (d: { x: number; y: number }) => d,
    screenDeltaToWorld: (d: { x: number; y: number }) => d,
    worldToScreen: (p: { x: number; y: number }) => p,
    screenToWorld: (p: { x: number; y: number }) => p,
  }
  return { revision: 1, mode: 'site', attached: true, view } as unknown as ViewFrame
}

function makeToolHost() {
  const frameSignal = signal(makeViewFrame())
  const frames = {
    viewFrame: frameSignal,
    settledViewFrame: frameSignal,
    onViewFrame: () => () => {},
  } as unknown as ToolHostDeps['frames']
  const deps: ToolHostDeps = {
    frames,
    toolRow: (id) => TOOL_ROWS[id],
    scene: {
      persisted: { plants: [], zones: [], annotations: [], measurement_guides: [], groups: [], layers: [] },
      hitAt: () => null,
      hitInQuad: () => [],
      nearestPlant: () => null,
      plantPresentation: () => ({ commonName: '', color: '#000', radiusPx: 8 }),
      isLayerOpenForCreation: () => true,
      selection: () => [],
      selectionModel: () => ({
        editableTargets: [],
        lockedTargets: [],
        blockedTargets: [],
        bounds: null,
        sameSpeciesReferenceCanonicalName: null,
        plantNamePinning: { plantIds: [], allPinned: false },
      }),
    } as unknown as ToolHostDeps['scene'],
    edits: {
      run: (_t, fn) => {
        const tx = { mutate: () => {}, setSelection: () => {}, commit: () => true, abort: () => {}, changed: false }
        fn(tx)
        return true
      },
      begin: () => ({ mutate: () => {}, setSelection: () => {}, commit: () => true, abort: () => {}, changed: false }),
    },
    admission: { runWhenSettled: <T>(fn: () => T) => fn() } as unknown as ToolHostDeps['admission'],
    settled: { readWhenSettled: <T>(fn: () => T) => fn() } as unknown as ToolHostDeps['settled'],
    setSelection: () => {},
    renderer: { setDraft: () => {} },
    invalidate: () => {},
    chrome: {
      setHandles: () => {},
      setCursor: () => {},
      requestTextEntry: () => {},
      closeTextEntry: () => {},
      cancelTextEntry: () => {},
      submitUnfocusedTextEntry: () => {},
      isTextEntryOpen: () => false,
      setTooltip: () => {},
      focusedHandle: () => null,
    },
    menu: { open: () => {}, close: () => {}, isOpen: () => false },
    focus: { focusMap: () => {} },
    guidance: () => {},
    settings: { plantSpacingIntervalM: () => 2, commitPlantSpacingIntervalM: () => {} },
    snapping: () => ({ grid: false }),
    translate: (key) => key,
    navigation: { turnToEdge: () => {} },
    nudge: { nudgeSelected: () => false, endNudge: () => {} },
    timers: { set: () => 1, clear: () => {}, clock: () => 0 },
    initialPointer: 'mouse',
    hover: () => {},
    lockedMoveRefused: () => {},
    capturePress: () => true,
    transientHistoryChanged: () => {},
    dropped: () => {},
    overviewDrop: () => {},
    designPin: { contains: () => false, hovered: () => {}, tapped: () => {} },
  }
  return createToolHost(deps)
}

describe('ToolHost owner policy & map-input settlement (ADR 0024, §18 F29, 2.1-M77)', () => {
  it('enforces single tool owner: no duplicate writable tool signals or setters on session-state or session', () => {
    expect('currentCanvasTool' in sessionState).toBe(false)
    expect('setCanvasTool' in sessionState).toBe(false)
    expect('setCurrentCanvasTool' in session).toBe(false)
    expect(session.currentCanvasTool.value).toBe('select')
  })

  it('settles map input requests once for picked, superseded, tool-change, escape, design-closed, and detached', async () => {
    const host = makeToolHost()
    const mods = { shift: false, ctrl: false, alt: false, meta: false }

    const pickedOutcomes: MapInputOutcome[] = []
    const h1 = host.arm('siteData.pin', null, { onSettled: (o) => pickedOutcomes.push(o) })
    expect(host.activeTool.value).toBe('siteData.pin')
    host.gesture({ kind: 'press', id: 1, at: { x: 42, y: 18 }, mods, pointer: 'mouse', clickCount: 1, target: { kind: 'surface' } })
    host.gesture({ kind: 'tap', id: 1, at: { x: 42, y: 18 }, mods, pointer: 'mouse', clickCount: 1 })
    expect(await h1.settled).toEqual({ kind: 'picked', value: { x: 42, y: 18 } })
    h1.cancel('escape')
    expect(pickedOutcomes).toHaveLength(1)

    const h2 = host.arm('siteData.pin', null, {})
    const h3 = host.arm('profile', null, {})
    expect(await h2.settled).toEqual({ kind: 'cancelled', reason: 'superseded' })

    host.arm('select', null)
    expect(await h3.settled).toEqual({ kind: 'cancelled', reason: 'tool-change' })

    const h4 = host.arm('siteData.pin', null, {})
    h4.cancel('escape')
    expect(await h4.settled).toEqual({ kind: 'cancelled', reason: 'escape' })

    const h5 = host.arm('profile', null, {})
    host.prepareForDocumentReplacement()
    expect(await h5.settled).toEqual({ kind: 'cancelled', reason: 'design-closed' })
    expect(host.activeTool.value).toBe('select')

    const h6 = host.arm('siteData.pin', null, {})
    host.dispose()
    expect(await h6.settled).toEqual({ kind: 'detached' })

    // 7. arming after dispose settles immediately as detached
    const detachedOutcomes: MapInputOutcome[] = []
    const h7 = host.arm('siteData.pin', null, { onSettled: (o) => detachedOutcomes.push(o) })
    expect(await h7.settled).toEqual({ kind: 'detached' })
    expect(detachedOutcomes).toEqual([{ kind: 'detached' }])
  })

  it('escapeTool settles a pending map-input request with reason escape and returns to Select (#880 S5)', async () => {
    const host = makeToolHost()
    const onSettled = vi.fn()
    const handle = host.arm('siteData.pin', null, { onSettled })
    host.escapeTool()
    expect(host.activeTool.peek()).toBe('select')
    expect(onSettled).toHaveBeenCalledWith({ kind: 'cancelled', reason: 'escape' })
    expect(await handle.settled).toEqual({ kind: 'cancelled', reason: 'escape' })
    host.dispose()
  })

  it('subscribeEmptyGroundTap notifies on Select empty-ground taps and Pan taps in site mode (2.1-Q364, #880 B1)', () => {
    const host = makeToolHost()
    const tapped = vi.fn()
    const unsub = host.subscribeEmptyGroundTap(tapped)
    const mods = { shift: false, ctrl: false, alt: false, meta: false }
    host.gesture({ kind: 'press', id: 1, at: { x: 100, y: 100 }, mods, pointer: 'mouse', target: { kind: 'surface' }, clickCount: 1 })
    host.gesture({ kind: 'tap', id: 1, at: { x: 100, y: 100 }, mods, pointer: 'mouse', clickCount: 1 })
    expect(tapped).toHaveBeenCalledTimes(1)

    host.arm('hand', null)
    host.gesture({ kind: 'press', id: 2, at: { x: 120, y: 120 }, mods, pointer: 'mouse', target: { kind: 'surface' }, clickCount: 1 })
    host.gesture({ kind: 'tap', id: 2, at: { x: 120, y: 120 }, mods, pointer: 'mouse', clickCount: 1 })
    expect(tapped).toHaveBeenCalledTimes(2)

    unsub()
    host.arm('select', null)
    host.gesture({ kind: 'press', id: 3, at: { x: 140, y: 140 }, mods, pointer: 'mouse', target: { kind: 'surface' }, clickCount: 1 })
    host.gesture({ kind: 'tap', id: 3, at: { x: 140, y: 140 }, mods, pointer: 'mouse', clickCount: 1 })
    expect(tapped).toHaveBeenCalledTimes(2)
    host.dispose()
  })

  it('covers siteData.pin pass branches (hover, non-tap commands, and overview mode)', () => {
    const host = makeToolHost()
    host.arm('siteData.pin', null)
    const mods = { shift: false, ctrl: false, alt: false, meta: false }
    expect(host.gesture({ kind: 'hover', at: { x: 10, y: 10 }, mods, pointer: 'mouse', target: { kind: 'surface' } })).toEqual({})
    expect(host.command({ kind: 'confirm' })).toBe('pass')
    // Re-arming the same tool with a new source updates ToolHost state in place
    host.arm('siteData.pin', null, { stampId: 's-1' })
    expect(host.state.value.stampId).toBe('s-1')
    host.dispose()
  })

  it('covers createScreenAlignedBounds for empty, rect, and ellipse zones', () => {
    const base = { kind: 'zone' as const, name: null, fillColor: '#000', notes: null, locked: false }
    const empty = createScreenAlignedBounds(30)
    expect(empty.center()).toBeNull()
    empty.addZone({ ...base, id: 'e', zoneType: 'polygon', points: [], rotationDeg: 0 })
    expect(empty.center()).toBeNull()

    const shapes = createScreenAlignedBounds(45)
    shapes.addZone({
      ...base, id: 'r', zoneType: 'rect',
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }], rotationDeg: 0,
    })
    shapes.addZone({
      ...base, id: 'el', zoneType: 'ellipse',
      points: [{ x: 2, y: 1 }, { x: 3, y: 1 }], rotationDeg: 15,
    })
    expect(shapes.center()).not.toBeNull()
  })
})
