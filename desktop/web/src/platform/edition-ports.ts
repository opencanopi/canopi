/**
 * platform/edition-ports.ts: L1 owner of `EditionPorts`, the one record an edition root
 * (Desktop, Web, or Gallery) builds and installs once (contracts §22; Stage 2 A1).
 *
 * Invariant (Stage 2 A1): no module reads `editionPorts()` at top-level import time;
 * features read ports lazily inside functions/effects, and tests bind ports with
 * `installEditionPorts(ports)` (using its returned dispose callback).
 */
import type { EditionCapabilitySet } from '../generated/edition-capabilities'
import type { DesktopHomePort } from './design-home'
import type { EditionManifest } from './edition-manifest'
import type { ProblemReportPort } from './problem-report'
import type { SettingsPlatformAdapter } from './settings'

/** Delivery outcome for a canvas PDF export (matches app/canvas-pdf/workflow.ts). */
type PdfDeliveryOutcome = 'saved' | 'downloaded' | 'cancelled'

/** L1 port for delivering rendered PDF bytes (file dialog on Desktop, download on Web, fake in Gallery). */
export interface PdfDeliveryPort {
  save(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<PdfDeliveryOutcome>
  dispose(): void
}

/** L1 port for delivering an exported budget CSV string. */
type BudgetExportDeliveryPort = (data: string, defaultName: string) => Promise<void>

/** L1 port for fetching JSON from a geocoding endpoint (native HTTP on Desktop, browser fetch on Web). */
type GeocodingTransportPort = (url: string, signal?: AbortSignal) => Promise<unknown>

/**
 * The one port record each edition root binds and installs once (contracts §22).
 * Holds the ports that exist at 2a; later streams add their ports as they build them.
 */
export interface EditionPorts {
  readonly capabilities: EditionCapabilitySet
  readonly manifest?: EditionManifest
  readonly settings: SettingsPlatformAdapter
  readonly problemReport: ProblemReportPort
  readonly geocoding: GeocodingTransportPort
  readonly canvasPdfDelivery: () => PdfDeliveryPort
  readonly budgetExportDelivery: BudgetExportDeliveryPort
  readonly designHome?: DesktopHomePort
}

let activePorts: EditionPorts | null = null

/** Installs `ports` as the active edition ports; returns a disposer that restores the prior binding. */
export function installEditionPorts(ports: EditionPorts): () => void {
  const previous = activePorts
  activePorts = ports
  return () => {
    if (activePorts === ports) activePorts = previous
  }
}

/** Returns true when an edition root has installed ports. */
export function hasEditionPorts(): boolean {
  return activePorts !== null
}

/**
 * Reads the active `EditionPorts`. Throws if called before an edition root installs them
 * (Stage 2 A1: never read at module top level).
 */
export function editionPorts(): EditionPorts {
  if (activePorts === null) {
    throw new Error('EditionPorts are not installed: an edition root must bind them before use.')
  }
  return activePorts
}
