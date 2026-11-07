import { invokeCommand } from './transport'
import type { CanopiFile } from '../types/design'
import type { SavedObjectStamp } from '../types/saved-object-stamps'
import { pickOpen, pickSave } from './dialogs'

export async function getSavedObjectStamps(): Promise<SavedObjectStamp[]> {
  return invokeCommand('get_saved_object_stamps')
}

export async function createSavedObjectStamp(
  name: string,
  payloadJson: string,
): Promise<SavedObjectStamp> {
  return invokeCommand('create_saved_object_stamp', { name, payloadJson })
}

export async function renameSavedObjectStamp(
  id: string,
  name: string,
): Promise<SavedObjectStamp> {
  return invokeCommand('rename_saved_object_stamp', { id, name })
}

export async function deleteSavedObjectStamp(id: string): Promise<boolean> {
  return invokeCommand('delete_saved_object_stamp', { id })
}

export async function reorderSavedObjectStamps(ids: string[]): Promise<SavedObjectStamp[]> {
  return invokeCommand('reorder_saved_object_stamps', { ids })
}

/** `content` is canonical `.canopi` JSON (`encodeCanopiDesign`); the caller encodes. */
export async function exportSavedObjectStampCanopiFile(
  content: Record<string, unknown>,
  defaultName: string,
): Promise<string> {
  const outcome = await pickSave('stamp-export', defaultName)
  if (outcome.kind === 'cancelled') throw new Error('Dialog cancelled')
  return invokeCommand('export_saved_object_stamp_canopi_file', {
    path: outcome.path,
    content,
  })
}

export async function importSavedObjectStampCanopiFile(): Promise<CanopiFile> {
  const outcome = await pickOpen('stamp-import')
  if (outcome.kind === 'cancelled') throw new Error('Dialog cancelled')
  return invokeCommand('load_saved_object_stamp_canopi_file', { path: outcome.paths[0]! })
}
