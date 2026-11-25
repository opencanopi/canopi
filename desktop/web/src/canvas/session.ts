import { computed, signal } from '@preact/signals'
import { setCanvasTool } from './session-state'
import type {
  CanvasCommandSurface,
  CanvasDocumentSurface,
  CanvasKeyboardPort,
  CanvasLayerCommandSurface,
  CanvasPlantPresentationCommandSurface,
  CanvasQuerySurface,
  CanvasRuntimeSurfaces,
  CanvasSceneEditCommandSurface,
  CanvasToolCommandSurface,
  CanvasViewportCommandSurface,
} from './runtime/runtime'
import type { ToolId } from './runtime/interaction-types'

export const currentCanvasSession = signal<CanvasRuntimeSurfaces | null>(null)
export const currentCanvasCommandSurface = computed<CanvasCommandSurface | null>(() =>
  currentCanvasSession.value?.commands ?? null,
)
export const currentCanvasToolCommandSurface = computed<CanvasToolCommandSurface | null>(() =>
  currentCanvasSession.value?.commands.tools ?? null,
)
export const currentCanvasViewportCommandSurface = computed<CanvasViewportCommandSurface | null>(() =>
  currentCanvasSession.value?.commands.viewport ?? null,
)
const currentCanvasLayerCommandSurface = computed<CanvasLayerCommandSurface | null>(() =>
  currentCanvasSession.value?.commands.layers ?? null,
)
export const currentCanvasSceneEditCommandSurface = computed<CanvasSceneEditCommandSurface | null>(() =>
  currentCanvasSession.value?.commands.sceneEdits ?? null,
)
export const currentCanvasPlantPresentationCommandSurface = computed<CanvasPlantPresentationCommandSurface | null>(() =>
  currentCanvasSession.value?.commands.plantPresentation ?? null,
)
export const currentCanvasSpeciesFocusCommands = computed(() =>
  currentCanvasSession.value?.commands.speciesFocus ?? null,
)
export const currentCanvasQuerySurface = computed<CanvasQuerySurface | null>(() =>
  currentCanvasSession.value?.queries ?? null,
)
export const currentCanvasDocumentSurface = computed<CanvasDocumentSurface | null>(() =>
  currentCanvasSession.value?.documents ?? null,
)
export { currentCanvasDesignPinHovered, currentCanvasHasSelection, currentCanvasSelection, currentCanvasTool, currentCanvasToolGuidance } from './session-state'

export function getCurrentCanvasSession(): CanvasRuntimeSurfaces | null {
  return currentCanvasSession.value
}

/** The live session's keyboard port, which the key router hands every key (spec §1.6); null with no canvas. */
export function currentCanvasKeyboardPort(): CanvasKeyboardPort | null {
  return currentCanvasSession.peek()?.keyboard ?? null
}

export function getCurrentCanvasCommandSurface(): CanvasCommandSurface | null {
  return currentCanvasCommandSurface.value
}

export function getCurrentCanvasViewportCommandSurface(): CanvasViewportCommandSurface | null {
  return currentCanvasViewportCommandSurface.value
}

export function getCurrentCanvasLayerCommandSurface(): CanvasLayerCommandSurface | null {
  return currentCanvasLayerCommandSurface.value
}

export function setCurrentCanvasSession(surfaces: CanvasRuntimeSurfaces | null): void {
  currentCanvasSession.value = surfaces
}

export function setCurrentCanvasTool(id: ToolId): void {
  const session = currentCanvasToolCommandSurface.value
  if (session) {
    session.setTool(id)
    return
  }
  setCanvasTool(id)
}
