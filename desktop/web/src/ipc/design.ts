import { invokeCommand } from './transport'
import type {
  CanopiFile,
  DesignDraftSummary,
  DesignNotebookSection,
  DesignNotebookSnapshot,
  DesignSaveOutcome,
  DesignSummary,
  LoadedDesign,
  RecentDesignSummary,
} from '../types/design'
import { encodeCanopiDesign } from '../app/contracts/canopi-design-wire'
import { DesignHomeConflictError } from '../app/document-session/continuous-save'
import {
  prepareDesignWriteDestination,
  type PreparedDesignWriteDestination,
} from '../app/document-session/write-admission'
import { pickOpen, pickSave } from './dialogs'

// ---------------------------------------------------------------------------
// File dialogs: the host shows them (`./dialogs`, `desktop/src/host/dialogs.rs`)
// through the dialog plugin's callback API, which never waits on the GTK main
// loop; Open starts and Save defaults in the folder of the last Design loaded
// or saved in this window.
// ---------------------------------------------------------------------------

export interface DesignSaveDestinationHint {
  readonly currentPath: string | null
  readonly suggestedName: string
}

/**
 * Select a native Design destination without starting external I/O: Save As
 * suggests the current file's name, a first save the Design's name.
 */
export async function selectDesignSavePath({
  currentPath,
  suggestedName,
}: DesignSaveDestinationHint): Promise<string> {
  // Windows paths separate folders with backslashes.
  const currentName = currentPath?.slice(Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\')) + 1)
  const outcome = await pickSave('design-save', currentName || suggestedName || 'Untitled')
  if (outcome.kind === 'cancelled') throw new Error('Dialog cancelled')
  return outcome.path
}

/**
 * Couple one native Design file to its write. The write refuses to replace a
 * file that no longer holds `expectedFingerprint` (`null` overwrites) and
 * reports the written fingerprint before the save settles.
 */
export function prepareDesignWrite(
  path: string,
  expectedFingerprint: string | null,
  onWritten: (fingerprint: string) => void,
): PreparedDesignWriteDestination {
  return prepareDesignWriteDestination({
    resource: `native-design:${path}`,
    destinationPath: path,
    write: async (content) => {
      const outcome = await saveDesign(path, content, expectedFingerprint)
      if (outcome.kind === 'conflict') {
        throw new DesignHomeConflictError(outcome.current_fingerprint === null)
      }
      onWritten(outcome.fingerprint)
    },
  })
}

/** Couple one Design Draft in app data to its write. */
export function prepareDraftWrite(id: string): PreparedDesignWriteDestination {
  return prepareDesignWriteDestination({
    resource: `native-draft:${id}`,
    write: (content) => saveDesignDraft(id, content),
  })
}

/**
 * Show the host's Open dialog, then load the chosen design.
 * Returns the loaded Design with its path. Throws "Dialog cancelled" if user dismisses.
 */
export async function openDesignDialog(): Promise<{ design: LoadedDesign; path: string }> {
  const outcome = await pickOpen('design-open')
  if (outcome.kind === 'cancelled') throw new Error('Dialog cancelled')
  const filePath = outcome.paths[0]!
  const design = await loadDesign(filePath)
  return { design, path: filePath }
}

// ---------------------------------------------------------------------------
// Direct IPC wrappers — keep Design writers private to prepared destinations.
// ---------------------------------------------------------------------------

/** Write a Design file unless it changed on disk since `expectedFingerprint`. */
async function saveDesign(
  path: string,
  content: CanopiFile,
  expectedFingerprint: string | null,
): Promise<DesignSaveOutcome> {
  return invokeCommand('save_design', {
    path,
    content: encodeCanopiDesign(content),
    expectedFingerprint,
  })
}

/**
 * Load a design from a known path (e.g. recent files) with its fingerprint;
 * only the current format opens (ADR 0021).
 * Rejects with a `DesignLoadFailure` (`app/contracts/canopi-design-errors.ts`).
 */
export async function loadDesign(path: string): Promise<LoadedDesign> {
  return invokeCommand('load_design', { path })
}

async function saveDesignDraft(id: string, content: CanopiFile): Promise<void> {
  return invokeCommand('save_design_draft', { id, content: encodeCanopiDesign(content) })
}

export async function loadDesignDraft(id: string): Promise<CanopiFile> {
  return invokeCommand('load_design_draft', { id })
}

export async function listDesignDrafts(): Promise<DesignDraftSummary[]> {
  return invokeCommand('list_design_drafts')
}

export async function deleteDesignDraft(id: string): Promise<void> {
  return invokeCommand('delete_design_draft', { id })
}

/** Create a new empty design with default layers. */
export async function newDesign(): Promise<CanopiFile> {
  return invokeCommand('new_design')
}

/** Get recently opened files list. */
export async function getRecentFiles(): Promise<DesignSummary[]> {
  return invokeCommand('get_recent_files')
}

/**
 * Start › Recent Designs previews (counts, ground bounds, sketch) read from
 * the listed files. Paths not on the list are skipped.
 */
export async function getRecentDesignPreviews(paths: readonly string[]): Promise<RecentDesignSummary[]> {
  return invokeCommand('get_recent_design_previews', { paths })
}

/** Start › Recent Designs › Remove from list; the file is untouched. */
export async function removeRecentDesign(path: string): Promise<void> {
  return invokeCommand('remove_recent_design', { path })
}

/** Start › Recent Designs › Show in folder. */
export async function showRecentDesignInFolder(path: string): Promise<void> {
  return invokeCommand('show_recent_design_in_folder', { path })
}

/** Get saved Design references plus user-owned Notebook Section organization. */
export async function getDesignNotebook(): Promise<DesignNotebookSnapshot> {
  return invokeCommand('get_design_notebook')
}

export async function createNotebookSection(name: string): Promise<DesignNotebookSection> {
  return invokeCommand('create_notebook_section', { name })
}

export async function addDesignReferenceToNotebook(
  path: string,
  content: CanopiFile,
): Promise<void> {
  return invokeCommand('add_design_reference_to_notebook', { path, content })
}

export async function renameNotebookSection(sectionId: string, name: string): Promise<void> {
  return invokeCommand('rename_notebook_section', { sectionId, name })
}

export async function deleteNotebookSection(sectionId: string): Promise<void> {
  return invokeCommand('delete_notebook_section', { sectionId })
}

export async function moveDesignReferenceToSection(
  path: string,
  sectionId: string | null,
): Promise<void> {
  return invokeCommand('move_design_reference_to_section', { path, sectionId })
}

export async function relocateDesignReference(
  path: string,
  sectionId: string | null,
  paths: string[],
): Promise<void> {
  return invokeCommand('relocate_design_reference', { path, sectionId, paths })
}

export async function removeDesignReference(path: string): Promise<void> {
  return invokeCommand('remove_design_reference', { path })
}

export async function reorderNotebookSections(sectionIds: string[]): Promise<void> {
  return invokeCommand('reorder_notebook_sections', { sectionIds })
}

export async function reorderDesignReferences(paths: string[]): Promise<void> {
  return invokeCommand('reorder_design_references', { paths })
}
