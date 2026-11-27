import { invokeTyped, mintOperationId } from './transport'
import type { CanopiFileV10 } from '../generated/contracts'
import type { SavedObjectStamp } from '../types/saved-object-stamps'
import { pickCancelled, pickOpen, pickSave } from './dialogs'

export async function getSavedObjectStamps(): Promise<SavedObjectStamp[]> {
  return invokeTyped('get_saved_object_stamps', undefined, mintOperationId('u'))
}

export async function createSavedObjectStamp(
  name: string,
  payloadJson: string,
): Promise<SavedObjectStamp> {
  return invokeTyped('create_saved_object_stamp', { name, payloadJson }, mintOperationId('u'))
}

export async function renameSavedObjectStamp(
  id: string,
  name: string,
): Promise<SavedObjectStamp> {
  return invokeTyped('rename_saved_object_stamp', { id, name }, mintOperationId('u'))
}

export async function deleteSavedObjectStamp(id: string): Promise<boolean> {
  return invokeTyped('delete_saved_object_stamp', { id }, mintOperationId('u'))
}

export async function restoreSavedObjectStamp(stamp: SavedObjectStamp): Promise<SavedObjectStamp> {
  return invokeTyped('restore_saved_object_stamp', { stamp }, mintOperationId('u'))
}

export async function reorderSavedObjectStamps(ids: string[]): Promise<SavedObjectStamp[]> {
  return invokeTyped('reorder_saved_object_stamps', { ids }, mintOperationId('u'))
}

/** `content` is canonical `.canopi` JSON (`encodeCanopiDesign`); the caller encodes. */
export async function exportSavedObjectStampCanopiFile(
  content: Record<string, unknown>,
  defaultName: string,
): Promise<string> {
  const outcome = await pickSave('stamp-export', defaultName)
  if (outcome.kind === 'cancelled') throw pickCancelled('dialog.pick_save')
  return invokeTyped('export_saved_object_stamp_canopi_file', {
    path: outcome.path,
    content,
  }, mintOperationId('u'))
}

export async function importSavedObjectStampCanopiFile(): Promise<CanopiFileV10> {
  const outcome = await pickOpen('stamp-import')
  if (outcome.kind === 'cancelled') throw pickCancelled('dialog.pick_open')
  return invokeTyped('load_saved_object_stamp_canopi_file', { path: outcome.paths[0]! }, mintOperationId('u'))
}
