import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { createTestView, type TestView } from '../../__tests__/support/test-view'
import { createSceneCanvasDocumentSurface } from './document-surface'
import {
  CanvasAuthorityBusyError,
  CanvasDocumentReplacementNotAdmittedError,
  createCanvasDocumentReplacementToken,
  type CanvasDocumentSurface,
} from './runtime'
import { SceneStore } from './scene'

function createTestDocumentSurface(
  documents: Parameters<typeof createSceneCanvasDocumentSurface>[0]['documents'],
  renderingOverrides: Partial<
    Parameters<typeof createSceneCanvasDocumentSurface>[0]['rendering']
  > & { invalidate?: () => void } = {},
  camera: TestView = createTestView(),
): CanvasDocumentSurface {
  const rendering = {
    container: null,
    presented: signal(true),
    awaitPresentation: vi.fn(),
    invalidate: vi.fn(),
    unmount: vi.fn(),
    ...renderingOverrides,
  } as Parameters<typeof createSceneCanvasDocumentSurface>[0]['rendering']
  return createSceneCanvasDocumentSurface({
    inspection: { mount: () => { throw new Error('Inspection is not used by this fixture.') }, reset: () => {}, dispose: () => {} },
    documents,
    cameraHost: camera.host,
    viewNavigation: camera.navigation,
    rendering,
    setChromeShown: vi.fn(),
    clearHoveredEntity: vi.fn(),
    disposeRuntime: vi.fn(),
    disposeInteraction: vi.fn(),
    disposeCamera: vi.fn(),
    disposeEffects: vi.fn(),
  })
}

describe('Scene Canvas document surface lifecycle', () => {
  it('clears a temporary focus after successful load or replacement but retains it when replacement is rejected', () => {
    const camera = createTestView()
    const file = new SceneStore().toCanopiFile()
    const surface = createTestDocumentSurface({
      loadDocument: vi.fn(),
      replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
        finalizeReplacement()
        return { callerFinalizerInvoked: true }
      }),
      captureForPersistence: vi.fn((_metadata, document) => ({
        content: document,
        isCurrent: () => true,
        acknowledgeSaved: () => 'applied' as const,
      })),
    }, {}, camera)

    camera.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { paddingCssPx: 48 })
    surface.loadDocument(file)
    expect(camera.navigation.returnFromTemporaryFocus()).toBe(false)

    camera.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { paddingCssPx: 48 })
    surface.replaceDocument(file, createCanvasDocumentReplacementToken(), vi.fn())
    expect(camera.navigation.returnFromTemporaryFocus()).toBe(false)

    const rejected = createTestDocumentSurface({
      loadDocument: vi.fn(),
      replaceDocument: vi.fn(() => {
        throw new CanvasDocumentReplacementNotAdmittedError(new Error('not admitted'))
      }),
      captureForPersistence: vi.fn((_metadata, document) => ({
        content: document,
        isCurrent: () => true,
        acknowledgeSaved: () => 'applied' as const,
      })),
    }, {}, camera)
    camera.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { paddingCssPx: 48 })
    expect(() => rejected.replaceDocument(file, createCanvasDocumentReplacementToken(), vi.fn())).toThrow('not admitted')
    expect(camera.navigation.returnFromTemporaryFocus()).toBe(true)
  })

  it('continues destroying every owner after interaction disposal fails', () => {
    const calls: string[] = []
    const camera = createTestView()
    const surface = createSceneCanvasDocumentSurface({
    inspection: { mount: () => { throw new Error('Inspection is not used by this fixture.') }, reset: () => {}, dispose: () => {} },
      documents: {
        loadDocument: vi.fn(),
        replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
          finalizeReplacement()
          return { callerFinalizerInvoked: true }
        }),
        captureForPersistence: vi.fn((_metadata, document) => ({
          content: document,
          isCurrent: () => true,
          acknowledgeSaved: () => 'applied',
        })),
      },
      cameraHost: camera.host,
      viewNavigation: camera.navigation,
      rendering: {
        container: null,
        presented: signal(true),
        awaitPresentation: vi.fn(),
        invalidate: vi.fn(),
        unmount: () => {
          calls.push('rendering')
        },
      },
      setChromeShown: vi.fn(),
      clearHoveredEntity: () => {
        calls.push('hover')
      },
      disposeRuntime: () => {
        calls.push('runtime')
      },
      disposeInteraction: () => {
        calls.push('interaction')
        throw new Error('interaction disposal failed')
      },
      disposeEffects: () => {
        calls.push('effects')
      },
      disposeCamera: () => {
        calls.push('camera')
      },
    })

    expect(() => surface.destroy()).toThrow('interaction disposal failed')
    expect(calls).toEqual(['runtime', 'hover', 'interaction', 'effects', 'camera', 'rendering'])
  })

  it('keeps first hydration authority-owned and persistence-busy until settlement succeeds', () => {
    const file = new SceneStore().toCanopiFile()
    const captureForPersistence = vi.fn((_metadata, document) => ({
      content: document,
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied' as const,
    }))
    let failHydration = true
    const loadDocument = vi.fn(() => {
      expect(surface.hasLoadedDocument()).toBe(true)
      expect(() => surface.captureForPersistence({ name: file.name }, file))
        .toThrow(CanvasAuthorityBusyError)
      if (failHydration) throw new Error('late hydration publication failed')
    })
    const surface: CanvasDocumentSurface = createTestDocumentSurface({
      loadDocument,
      replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
        finalizeReplacement()
        return { callerFinalizerInvoked: true }
      }),
      captureForPersistence,
    })

    expect(() => surface.loadDocument(file)).toThrow('late hydration publication failed')
    expect(surface.hasLoadedDocument()).toBe(true)
    expect(() => surface.captureForPersistence({ name: file.name }, file))
      .toThrow('document-settlement')
    expect(captureForPersistence).not.toHaveBeenCalled()

    failHydration = false
    surface.loadDocument(file)

    expect(() => surface.captureForPersistence({ name: file.name }, file)).not.toThrow()
    expect(captureForPersistence).toHaveBeenCalledOnce()
  })

  it('keeps the loaded document saveable when a later load is refused while an edit owns the Scene', () => {
    const file = new SceneStore().toCanopiFile()
    const captureForPersistence = vi.fn((_metadata, document) => ({
      content: document,
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied' as const,
    }))
    let busy = false
    const surface = createTestDocumentSurface({
      loadDocument: vi.fn(() => {
        if (busy) throw new CanvasAuthorityBusyError('keyboard-nudge')
      }),
      replaceDocument: vi.fn(),
      captureForPersistence,
    })
    surface.loadDocument(file)
    busy = true

    expect(() => surface.loadDocument(file)).toThrow(CanvasAuthorityBusyError)
    expect(surface.hasLoadedDocument()).toBe(true)
    expect(() => surface.captureForPersistence({ name: file.name }, file)).not.toThrow()
    expect(captureForPersistence).toHaveBeenCalledOnce()
  })

  it('keeps replacement persistence-busy across a late failure and retry', () => {
    const file = new SceneStore().toCanopiFile()
    const captureForPersistence = vi.fn((_metadata, document) => ({
      content: document,
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied' as const,
    }))
    let failReplacement = true
    const replaceDocument = vi.fn((_file, _token, finalizeReplacement: () => void) => {
      finalizeReplacement()
      if (failReplacement) throw new Error('late replacement publication failed')
      return { callerFinalizerInvoked: true }
    })
    const surface = createTestDocumentSurface({
      loadDocument: vi.fn(),
      replaceDocument,
      captureForPersistence,
    })
    surface.loadDocument(file)
    const token = createCanvasDocumentReplacementToken()

    expect(() => surface.replaceDocument(file, token, vi.fn()))
      .toThrow('late replacement publication failed')
    expect(() => surface.captureForPersistence({ name: file.name }, file))
      .toThrow('document-settlement')

    failReplacement = false
    expect(surface.replaceDocument(file, token, vi.fn())).toEqual({
      callerFinalizerInvoked: true,
    })
    expect(() => surface.captureForPersistence({ name: file.name }, file)).not.toThrow()
  })

  it('restores the prior document state when replacement is not admitted', () => {
    const current = new SceneStore().toCanopiFile()
    const preparationError = new Error('replacement preparation failed')
    const captureForPersistence = vi.fn((_metadata, document) => ({
      content: document,
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied' as const,
    }))
    const surface = createTestDocumentSurface({
      loadDocument: vi.fn(),
      replaceDocument: vi.fn(() => {
        throw new CanvasDocumentReplacementNotAdmittedError(preparationError)
      }),
      captureForPersistence,
    })
    surface.loadDocument(current)

    expect(() => surface.replaceDocument(
      current,
      createCanvasDocumentReplacementToken(),
      vi.fn(),
    )).toThrow('replacement preparation failed')
    expect(() => surface.captureForPersistence({ name: current.name }, current))
      .not.toThrow()
    expect(captureForPersistence).toHaveBeenCalledOnce()
  })
})
