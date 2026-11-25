// maplibre/scene-host-layer.model.test.ts
// Model-based test of SceneHostLayer's phase machine (contracts §6).
import { signal } from '@preact/signals'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CustomRenderMethodInput } from 'maplibre-gl'
import { createSceneHostLayer, type SceneHostMap, type ScenePainter } from './scene-host-layer'
import type { ViewFrame, ViewTransform } from '../geo/view/types'

type Op = 'init' | 'onAdd' | 'setSnapshot' | 'render' | 'dispose'

const GL = {} as WebGL2RenderingContext
const RENDER_INPUT = {} as CustomRenderMethodInput

function makeMap(): SceneHostMap {
  const canvas = { clientWidth: 200, clientHeight: 200, width: 200, height: 200 } as unknown as HTMLCanvasElement
  return { getCanvas: () => canvas, triggerRepaint() {} }
}

describe('SceneHostLayer phase machine model', () => {
  it('never paints before attached or after disposed/failed, and disposes painter at most once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Op>('init', 'onAdd', 'setSnapshot', 'render', 'dispose'), { minLength: 1, maxLength: 16 }),
        async (ops) => {
          const view = { id: 'v' } as unknown as ViewTransform
          const viewFrame = signal<ViewFrame>({ view, revision: 1 } as unknown as ViewFrame)
          const map = makeMap()
          let paintCount = 0
          let disposeCount = 0
          const painter: ScenePainter<string> = {
            async init() {},
            resize() {},
            paint() { paintCount += 1 },
            dispose() { disposeCount += 1 },
          }
          const host = createSceneHostLayer({ id: 'model-scene', frames: { viewFrame }, painter })
          let expectedAttached = false
          let expectedDisposed = false
          let expectedFailed = false
          let hasSnap = false

          for (const op of ops) {
            const paintsBefore = paintCount
            if (op === 'init') {
              if (expectedDisposed) {
                await expect(host.initialize(map, GL)).rejects.toThrow()
              } else {
                await host.initialize(map, GL).catch(() => {})
              }
            } else if (op === 'onAdd') {
              const wasInitialized = host.phase === 'initialized'
              host.layer.onAdd!(map as never, GL)
              if (!expectedDisposed) {
                if (wasInitialized) expectedAttached = true
                else {
                  expectedFailed = true
                  expectedAttached = false
                }
              }
            } else if (op === 'setSnapshot') {
              host.setSnapshot('s')
              if (!expectedDisposed && !expectedFailed) hasSnap = true
            } else if (op === 'render') {
              host.layer.render(GL, RENDER_INPUT)
              if (!expectedAttached || expectedDisposed || expectedFailed || !hasSnap) {
                expect(paintCount).toBe(paintsBefore)
              } else {
                expect(paintCount).toBe(paintsBefore + 1)
              }
            } else if (op === 'dispose') {
              await host.dispose()
              expectedDisposed = true
              expectedAttached = false
            }
          }

          await host.dispose()
          expect(host.phase).toBe('disposed')
          expect(disposeCount).toBe(1)
        },
      ),
      { numRuns: 50 },
    )
  })
})
