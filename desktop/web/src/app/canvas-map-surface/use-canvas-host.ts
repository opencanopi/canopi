// app/canvas-map-surface/use-canvas-host.ts  (L3)
//
// The one Preact hook mounting CanvasHost for Desktop, Web and the UI gallery (§5; canopi-f47t.52.8).
// Only this module calls mountCanvasHost in production; edition roots install their runtime binding at boot.

import { computed, signal, type ReadonlySignal } from '@preact/signals'
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks'
import { reportFailure } from '../../failures/report'
import type { LayerSlotId } from '../../maplibre/map-lifetime'
import { createAppSceneRuntimePanelTargetAdapter } from '../canvas-runtime/panel-target-adapter'
import { flushSettingsProjection } from '../settings/projection'
import {
  IDLE_CANVAS_SURFACE_STATE,
  mountCanvasHost,
  type CanvasHostCompositionOptions,
  type CanvasHostCore,
  type CanvasHostHandle,
  type CanvasHostView,
  type CanvasSurfaceState,
} from './canvas-host'
import { persistLastView } from './last-view'
import {
  createWorkspaceRuntimeComposition,
  type WorkspaceRuntimeComposition,
  type WorkspaceRuntimeCompositionOptions,
} from './workspace-runtime-composition'

type CanvasHostCompositionAdapters = Pick<
  WorkspaceRuntimeCompositionOptions,
  'appAdapter' | 'mapContributions' | 'readSnapshot' | 'readBackgroundPresentation'
>

export interface CanvasHostRuntimeBinding {
  readonly core: CanvasHostCore
  readonly adapters?: CanvasHostCompositionAdapters
  readonly createComposition?: (options: CanvasHostCompositionOptions) => WorkspaceRuntimeComposition
}

const runtimeBindingSlot: { current: (() => CanvasHostRuntimeBinding) | null } = { current: null }

/**
 * Installs the active edition's canvas-host runtime binding (called once by editions/desktop/boot.ts,
 * editions/web/boot.ts, or editions/gallery/main.tsx). Returns a disposer restoring the prior binding.
 */
export function installCanvasHostRuntime(factory: (() => CanvasHostRuntimeBinding) | null): () => void {
  const previous = runtimeBindingSlot.current
  runtimeBindingSlot.current = factory
  return () => {
    if (runtimeBindingSlot.current === factory) runtimeBindingSlot.current = previous
  }
}

function readCanvasHostRuntime(): CanvasHostRuntimeBinding {
  if (!runtimeBindingSlot.current) throw new Error('Canvas host runtime is not installed')
  return runtimeBindingSlot.current()
}

interface MutableDomRef<T> {
  current: T | null
}

/**
 * Connects a canvas container ref to the one CanvasHost lifecycle.
 * Uses useLayoutEffect so Preact 11 releases the lease synchronously at unmount before a successor mounts (F0e).
 */
export function useCanvasHost(containerRef: MutableDomRef<HTMLDivElement>): CanvasHostView {
  const stateRef = useRef<{
    readonly handle: ReturnType<typeof signal<CanvasHostHandle | null>>
    readonly surface: ReadonlySignal<CanvasSurfaceState>
    readonly ready: ReadonlySignal<boolean>
  } | null>(null)
  if (!stateRef.current) {
    const handle = signal<CanvasHostHandle | null>(null)
    stateRef.current = {
      handle,
      surface: computed(() => handle.value?.surface.value ?? IDLE_CANVAS_SURFACE_STATE),
      ready: computed(() => handle.value?.ready.value ?? false),
    }
  }
  const { handle: handleSignal, surface, ready } = stateRef.current

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const binding = readCanvasHostRuntime()
    const createComposition = binding.createComposition ?? ((options: CanvasHostCompositionOptions) => {
      if (!binding.adapters) throw new Error('Canvas host runtime requires adapters or createComposition')
      return createWorkspaceRuntimeComposition({
        ...options,
        ...binding.adapters,
        targetPresentation: createAppSceneRuntimePanelTargetAdapter(),
        onViewSettled: persistLastView,
      })
    })
    const handle = mountCanvasHost({
      elements: { container },
      core: binding.core,
      createComposition,
      flushSettings: flushSettingsProjection,
      reportFailure: (error, info) => {
        reportFailure(error, { shown: 'none', source: info.source })
      },
    })
    handleSignal.value = handle

    return () => {
      if (handleSignal.peek() === handle) handleSignal.value = null
      void handle.dispose()
    }
  }, [containerRef, handleSignal])

  const retryMap = useCallback(() => handleSignal.peek()?.retryMap() ?? false, [handleSignal])
  const retryLayer = useCallback((slot: LayerSlotId) => {
    handleSignal.peek()?.retryLayer(slot)
  }, [handleSignal])

  return { surface, ready, retryMap, retryLayer }
}
