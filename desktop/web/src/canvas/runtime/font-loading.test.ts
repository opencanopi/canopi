// @vitest-environment jsdom

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { Text, type Container } from 'pixi.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestRendererView, createTestSceneRendererSnapshot } from '../../__tests__/support/scene-renderer-snapshot'
import { measurementGuide, plantEntity } from '../../__tests__/support/tool-harness'
import { canvasFonts } from './font-loading'
import { createBillboardLayer } from './renderers/billboard-layer'
import { createDraftLayer } from './renderers/draft-layer'
import { createDraftScenePainters } from './renderers/pixi-scene'

type Face = { status: FontFaceLoadStatus }

/** A font face set whose one face loads, or fails, when the test says. */
function stubFonts(status: FontFaceLoadStatus = 'unloaded') {
  const face: Face = { status }
  const settle: Array<{ resolve: (faces: FontFace[]) => void; reject: (error: unknown) => void }> = []
  const load = vi.fn((_font: string, _text?: string) => new Promise<FontFace[]>((resolve, reject) => { settle.push({ resolve, reject }) }))
  const fonts = { load, forEach: (visit: (each: FontFace) => void) => visit(face as FontFace) }
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  return {
    load,
    finish: () => {
      face.status = 'loaded'
      settle.shift()?.resolve([face as FontFace])
    },
    fail: () => {
      face.status = 'error'
      settle.shift()?.reject(new DOMException('Network error', 'NetworkError'))
    },
  }
}

const settled = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  Reflect.deleteProperty(document, 'fonts')
  vi.restoreAllMocks()
})

describe('the canvas font loader (D11)', () => {
  it('a face that loads bumps the epoch once and tells every subscriber', async () => {
    const fonts = stubFonts()
    const listener = vi.fn()
    const unsubscribe = canvasFonts.subscribe(listener)
    const before = canvasFonts.epoch()

    canvasFonts.request('600 12px Inter', 'Malus')
    canvasFonts.request('600 12px Inter', 'Malus')
    expect(fonts.load, 'one request at a time for a font and text').toHaveBeenCalledOnce()
    fonts.finish()
    await settled()

    expect(canvasFonts.epoch()).toBe(before + 1)
    expect(listener).toHaveBeenCalledOnce()
    canvasFonts.request('600 12px Inter', 'Malus')
    expect(fonts.load, 'a loaded font is not asked for').toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('canopi-f47t.52.36: a font that fails to load bumps no epoch and is never asked for again', async () => {
    const fonts = stubFonts()
    const listener = vi.fn()
    const unsubscribe = canvasFonts.subscribe(listener)
    const before = canvasFonts.epoch()

    canvasFonts.request('12px Inter', 'Pyrus')
    fonts.fail()
    await settled()
    for (let draw = 0; draw < 5; draw += 1) canvasFonts.request('12px Inter', 'Pyrus')
    await settled()

    expect(canvasFonts.epoch()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    expect(fonts.load, 'no retry loop').toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('canopi-f47t.52.36: a subscriber gone before the font loads is not called', async () => {
    const fonts = stubFonts()
    const listener = vi.fn()
    const unsubscribe = canvasFonts.subscribe(listener)
    canvasFonts.request('12px Inter', 'Prunus')
    unsubscribe()
    fonts.finish()
    await settled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('a page without the font loading API asks for nothing', () => {
    expect(document.fonts).toBeUndefined()
    expect(() => canvasFonts.request('12px Inter', 'Malus')).not.toThrow()
  })
})

class MeasuredText extends Text {
  override get width(): number { return 40 }
  override set width(_value: number) {}
  override get height(): number { return 16 }
  override set height(_value: number) {}
}

/** Every Text under `root`. */
function texts(root: Container): Text[] {
  return root.children.flatMap((child) => [...(child instanceof Text ? [child] : []), ...texts(child)])
}

describe('the drawers that subscribe (D11)', () => {
  it('canopi-f47t.52.36: a font load draws plant names, stack badges and guide labels anew', async () => {
    const fonts = stubFonts()
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const plant = plantEntity('apple', 'Malus domestica', { x: 4, y: 3 }, { commonName: 'Apple', pinnedName: true })
    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        plants: [plant, plantEntity('pear-a', 'Pyrus communis', { x: 8, y: 2 }), plantEntity('pear-b', 'Pyrus communis', { x: 8, y: 2 })],
        measurementGuides: [measurementGuide('guide', { x: 0, y: 6 }, { x: 10, y: 6 })],
      },
    })
    const view = createTestRendererView({ x: 200, y: 150, scale: 20 })
    layer.present(view, snapshot)
    const before = texts(layer.root)
    const shown = (all: Text[]) => all.map((text) => text.text).sort()
    const drawn = shown(before)
    expect(before.some((text) => text.text === 'Apple'), 'the pinned name').toBe(true)
    expect(before.some((text) => text.text === '2'), 'the stack badge').toBe(true)
    expect(before.length, 'and the guide label').toBeGreaterThanOrEqual(3)
    expect(fonts.load.mock.calls.map(([font]) => font)).toEqual(expect.arrayContaining([
      expect.stringContaining('600 12px'), expect.stringMatching(/^\d+px /),
    ]))

    fonts.finish()
    await settled()
    layer.present(view, snapshot)

    const after = texts(layer.root)
    expect(shown(after)).toEqual(drawn)
    for (const text of before) {
      expect(after.includes(text), 'drawn anew').toBe(false)
      expect(text.destroyed).toBe(true)
    }
    layer.dispose()
  })

  it('canopi-f47t.52.36: a draft layer disposed before its chip font loads is unsubscribed and not redrawn', async () => {
    const fonts = stubFonts()
    const subscribe = canvasFonts.subscribe.bind(canvasFonts)
    const unsubscribed = vi.fn()
    vi.spyOn(canvasFonts, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = subscribe(listener)
      return () => { unsubscribed(); unsubscribe() }
    })
    const requestRepaint = vi.fn()
    const layer = createDraftLayer({
      createText: () => new MeasuredText(),
      viewSize: { width: 400, height: 300 },
      painters: createDraftScenePainters(() => createTestSceneRendererSnapshot()),
      requestRepaint,
    })
    layer.setView(createTestRendererView({ x: 0, y: 0, scale: 1 }))
    layer.setDraft({ shapes: [{ kind: 'label', anchor: { x: 0, y: 0 }, offsetPx: { x: 0, y: 0 }, text: '4 m', tone: 'measure' }] })
    expect(fonts.load).toHaveBeenCalledOnce()

    layer.dispose()
    expect(unsubscribed).toHaveBeenCalledOnce()
    fonts.finish()
    await settled()
    expect(requestRepaint).not.toHaveBeenCalled()
  })

  it('canopi-f47t.37: a draft chip asks for the faces its own text needs, so a Cyrillic chip gets the Cyrillic face', () => {
    const fonts = stubFonts()
    const layer = createDraftLayer({
      createText: () => new MeasuredText(),
      viewSize: { width: 400, height: 300 },
      painters: createDraftScenePainters(() => createTestSceneRendererSnapshot()),
      requestRepaint: vi.fn(),
    })
    layer.setView(createTestRendererView({ x: 0, y: 0, scale: 1 }))
    const chip = 'Площадь 4 м²'
    layer.setDraft({ shapes: [{ kind: 'label', anchor: { x: 0, y: 0 }, offsetPx: { x: 0, y: 0 }, text: chip, tone: 'measure' }] })

    expect(fonts.load).toHaveBeenCalledOnce()
    const [font, text] = fonts.load.mock.calls[0] ?? []
    expect(font).toMatch(/px /)
    for (const character of chip) expect(text, `the request names ${character}`).toContain(character)
    layer.dispose()
  })
})
