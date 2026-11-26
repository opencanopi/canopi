/**
 * ipc/design-core.ts: Typed Desktop IPC wrappers over `commands::design_core`
 * (`canopi-f47t.52.49`, contracts §10, 2.1-M156, 2.1-M539).
 */
import type {
  CanopiFileV10,
  DraftSummaryOutcome,
  FormatDecodeAnswer,
  FormatRefusal,
  GeoPoint,
  NewDesignInputContract,
  SavedObjectStampPayload,
} from '../generated/contracts'
import { invokeTyped, mintOperationId } from './transport'

export async function designCoreVersion(): Promise<string> {
  return invokeTyped('design_core_version', undefined, mintOperationId('u'))
}

export async function designCoreDecode(bytes: Uint8Array): Promise<FormatDecodeAnswer> {
  return invokeTyped('design_core_decode', { bytes: Array.from(bytes) }, mintOperationId('u'))
}

export async function designCoreEncode(
  design: unknown,
): Promise<{ ok: number[] } | { err: FormatRefusal }> {
  return invokeTyped('design_core_encode', { design }, mintOperationId('u'))
}

export async function designCoreNewDesign(input: NewDesignInputContract): Promise<CanopiFileV10> {
  return (await invokeTyped(
    'design_core_new_design',
    { input },
    mintOperationId('u'),
  )) as unknown as CanopiFileV10
}

export async function designCoreDraftSummary(
  bytes: Uint8Array,
  updatedAt: string,
): Promise<DraftSummaryOutcome> {
  return invokeTyped(
    'design_core_draft_summary',
    { bytes: Array.from(bytes), updatedAt },
    mintOperationId('u'),
  )
}

export async function designCoreDecodeStamp(
  payloadJson: string,
): Promise<{ ok: SavedObjectStampPayload } | { err: unknown }> {
  return invokeTyped('design_core_decode_stamp', { payloadJson }, mintOperationId('u'))
}

export async function designCoreEncodeStamp(
  payload: SavedObjectStampPayload,
): Promise<{ ok: string } | { err: unknown }> {
  return invokeTyped('design_core_encode_stamp', { payload }, mintOperationId('u'))
}

export async function designCoreStampToCanopi(
  payload: SavedObjectStampPayload,
  name: string,
  origin: GeoPoint,
): Promise<{ ok: number[] } | { err: FormatRefusal }> {
  return invokeTyped('design_core_stamp_to_canopi', { payload, name, origin }, mintOperationId('u'))
}

export async function designCoreCanopiToStamp(
  bytes: Uint8Array,
  origin: GeoPoint,
): Promise<{ ok: SavedObjectStampPayload } | { err: unknown }> {
  return invokeTyped(
    'design_core_canopi_to_stamp',
    { bytes: Array.from(bytes), origin },
    mintOperationId('u'),
  )
}
