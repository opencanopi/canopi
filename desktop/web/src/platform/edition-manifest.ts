/**
 * platform/edition-manifest.ts: Shared A33 edition-root parity manifest type (ADR 0030, 2.1-M211).
 *
 * Each edition root (Desktop, Web) declares its surface across the six parity dimensions:
 * commands, fileDelivery, mapContributions, panels, settingsSlices, and keymap.
 * Any entry present in one root and absent in the other MUST be explained by an
 * `EditionCapabilityId` from `EDITION_CAPABILITIES` that the two editions differ on.
 */
import type { EditionCapabilityId } from '../generated/edition-capabilities'

type ParityDimension =
  | 'commands'
  | 'fileDelivery'
  | 'mapContributions'
  | 'panels'
  | 'settingsSlices'
  | 'keymap'

export interface EditionManifestEntry {
  readonly id: string
  /** Capability that gates this entry when only one edition provides it (ADR 0030). */
  readonly gatedBy?: EditionCapabilityId
  /** Capability that this edition lacks and replaces with this `instead` entry (ADR 0030). */
  readonly insteadOf?: EditionCapabilityId
}

export type EditionManifest = Readonly<Record<ParityDimension, readonly EditionManifestEntry[]>>
