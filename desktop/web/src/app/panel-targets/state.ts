import { signal } from '@preact/signals'
import type { PanelTarget } from '../../generated/contracts'

export type PanelTargetPresentationOrigin = 'timeline' | 'budget' | 'consortium' | 'species-detail'

export const hoveredPanelTargets = signal<readonly PanelTarget[]>([])
export const selectedPanelTargets = signal<readonly PanelTarget[]>([])
export const selectedPanelTargetOrigin = signal<PanelTargetPresentationOrigin | null>(null)
export const hoveredCanvasTargets = signal<readonly PanelTarget[]>([])
/** Targets whose plants a panel's plant finder rings on the map. */
export const matchedPanelTargets = signal<readonly PanelTarget[]>([])
