// maplibre/scene-host-layer.test.ts
// Unit tests for createSceneHostLayer with a recording ScenePainter and fake map (contracts §6, 2.1-M525).
import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import type { CustomRenderMethodInput } from 'maplibre-gl'
import {
  createSceneHostLayer,
  MAPLIBRE_SHARED_SCENE_LAYER_ID,
  type ScenePainter,
} from './scene-host-layer'
import { createFakeMap } from '../__tests__/support/fake-map'
import type { ViewFrame, ViewTransform } from '../geo/view/types'

type ScenePainterFrame<S> = Parameters<ScenePainter<S>['paint']>[0]
type ScenePainterSize = Parameters<ScenePainter<string>['resize']>[0]

function fakeView(label: string): ViewTransform {
  return { label } as unknown as ViewTransform
}

function fakeMap(width = 400, height = 300, dpr = 2) {
  return createFakeMap({ width, height, dpr })
}

function recordingPainter() {
  const events: string[] = []
  const frames: ScenePainterFrame<string>[] = []
  const resizes: ScenePainterSize[] = []
  const drafts: Array<string | null> = []
  const painter: ScenePainter<string, string | null> = {
    async init(surface) {
      events.push(`init:${surface.size.width}x${surface.size.height}@${surface.size.resolution}`)
    },
    resize(size) {
      resizes.push(size)
      events.push(`resize:${size.width}x${size.height}@${size.resolution}`)
    },
    paint(frame) {
      frames.push(frame)
      events.push(`paint:${frame.snapshot ?? 'no-snap'}:${frame.settled ? 'settled' : 'moving'}`)
    },
    setDraft(draft) {
      drafts.push(draft)
    },
    dispose() {
      events.push('dispose')
    },
  }
  return { painter, events, frames, resizes, drafts }
}

const GL = {} as WebGL2RenderingContext
const RENDER_INPUT = {} as CustomRenderMethodInput

describe('createSceneHostLayer', () => {
  it('runs initialize -> onAdd -> paint -> presentFor -> dispose in order', async () => {
    const view1 = fakeView('v1')
    const viewFrame = signal<ViewFrame>({ view: view1, revision: 1 } as unknown as ViewFrame)
    const map = fakeMap()
    const rec = recordingPainter()
    const detachSpy = vi.fn()
    const host = createSceneHostLayer({
      id: MAPLIBRE_SHARED_SCENE_LAYER_ID,
      frames: { viewFrame },
      painter: rec.painter,
      onAttached: () => detachSpy,
    })

    expect(host.phase).toBe('new')
    await host.initialize(map, GL)
    expect(host.phase).toBe('initialized')

    host.layer.onAdd!(map as never, GL)
    expect(host.phase).toBe('attached')

    const presentPromise = host.presentFor(view1)
    host.setSnapshot('snap-1')
    expect(host.hasPresented(view1)).toBe(false)
    host.layer.render(GL, RENDER_INPUT)
    expect(host.hasPresented(view1)).toBe(true)
    expect(rec.frames).toHaveLength(1)
    expect(rec.frames[0]).toEqual({ view: view1, snapshot: 'snap-1', settled: true })

    // presentFor resolves on MapLibre's render event after paint.
    map.emitRender()
    await expect(presentPromise).resolves.toBeUndefined()

    await host.dispose()
    expect(host.phase).toBe('disposed')
    expect(detachSpy).toHaveBeenCalledTimes(1)
    expect(rec.events.at(-1)).toBe('dispose')
  })

  it('rejects pending presentFor waiters on dispose or painter failure', async () => {
    const view1 = fakeView('v1')
    const viewFrame = signal<ViewFrame>({ view: view1, revision: 1 } as unknown as ViewFrame)
    const map = fakeMap()
    const onFailure = vi.fn()
    const host = createSceneHostLayer<string>({
      id: MAPLIBRE_SHARED_SCENE_LAYER_ID,
      frames: { viewFrame },
      painter: {
        async init() {},
        resize() {},
        paint() { throw new Error('boom') },
        dispose() {},
      },
      onFailure,
    })

    await host.initialize(map, GL)
    host.layer.onAdd!(map as never, GL)
    const pending = host.presentFor(view1)
    host.setSnapshot('snap-1')
    host.layer.render(GL, RENDER_INPUT)

    await expect(pending).rejects.toThrow('boom')
    expect(host.phase).toBe('failed')
    expect(onFailure).toHaveBeenCalledTimes(1)
    await expect(host.presentFor(view1)).rejects.toThrow('boom')
  })

  it('resizes the painter when MapLibre canvas dimensions change and rejects invalid sizes', async () => {
    const view1 = fakeView('v1')
    const viewFrame = signal<ViewFrame>({ view: view1, revision: 1 } as unknown as ViewFrame)
    const map = fakeMap(400, 300, 1)
    const canvas = map.getCanvas()
    const rec = recordingPainter()
    const onFailure = vi.fn()
    const host = createSceneHostLayer({
      id: MAPLIBRE_SHARED_SCENE_LAYER_ID,
      frames: { viewFrame },
      painter: rec.painter,
      onFailure,
    })

    await host.initialize(map, GL)
    host.layer.onAdd!(map as never, GL)
    host.setSnapshot('snap-1')
    host.layer.render(GL, RENDER_INPUT)
    expect(rec.resizes).toHaveLength(0)

    Object.assign(canvas, { clientWidth: 600, clientHeight: 450, width: 1200, height: 900 })
    host.layer.render(GL, RENDER_INPUT)
    expect(rec.resizes).toEqual([{ width: 600, height: 450, resolution: 2 }])

    Object.assign(canvas, { clientWidth: 0, clientHeight: 0, width: 0, height: 0 })
    host.layer.render(GL, RENDER_INPUT)
    expect(host.phase).toBe('failed')
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  it('stays failed if initialize is called after an early onAdd failure', async () => {
    const view1 = fakeView('v1')
    const viewFrame = signal<ViewFrame>({ view: view1, revision: 1 } as unknown as ViewFrame)
    const map = fakeMap()
    const rec = recordingPainter()
    const onFailure = vi.fn()
    const host = createSceneHostLayer({
      id: MAPLIBRE_SHARED_SCENE_LAYER_ID,
      frames: { viewFrame },
      painter: rec.painter,
      onFailure,
    })

    host.layer.onAdd!(map as never, GL)
    expect(host.phase).toBe('failed')
    expect(onFailure).toHaveBeenCalledTimes(1)

    await expect(host.initialize(map, GL)).rejects.toThrow()
    expect(host.phase).toBe('failed')
    expect(rec.events).toEqual([])
  })

  it('does not invoke onFailure when painter init rejects during dispose', async () => {
    const view1 = fakeView('v1')
    const viewFrame = signal<ViewFrame>({ view: view1, revision: 1 } as unknown as ViewFrame)
    const map = fakeMap()
    const onFailure = vi.fn()
    let rejectInit!: (error: Error) => void
    const host = createSceneHostLayer<string>({
      id: MAPLIBRE_SHARED_SCENE_LAYER_ID,
      frames: { viewFrame },
      painter: {
        init() {
          return new Promise<void>((_, reject) => { rejectInit = reject })
        },
        resize() {},
        paint() {},
        dispose() {},
      },
      onFailure,
    })

    const initPromise = host.initialize(map, GL)
    const disposePromise = host.dispose()
    rejectInit(new Error('late init failure'))
    await expect(initPromise).rejects.toThrow('late init failure')
    await disposePromise

    expect(host.phase).toBe('disposed')
    expect(onFailure).not.toHaveBeenCalled()
  })
})
