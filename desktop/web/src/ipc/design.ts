import { invokeTyped, mintOperationId } from './transport'
import type {
  CanopiFile,
  DesignNotebookSection,
  DesignNotebookSnapshot,
  DesignSummary,
} from '../types/design'
import type {
  DesignDraftSummary,
  ReadOnlyDesign,
  RecentDesignSummary,
} from '../generated/contracts'

/** Read a Design saved by a newer Canopi into its read-only view (2.1-M478). */
export async function readNewerDesign(text: string): Promise<ReadOnlyDesign> {
  return invokeTyped('read_newer_design', { text }, mintOperationId('u'))
}

export async function listDesignDrafts(): Promise<DesignDraftSummary[]> {
  return invokeTyped('list_design_drafts', undefined, mintOperationId('u'))
}

export async function deleteDesignDraft(id: string): Promise<void> {
  return invokeTyped('delete_design_draft', { id }, mintOperationId('u'))
}

/** Create a new empty design with default layers. */
export async function newDesign(): Promise<CanopiFile> {
  return invokeTyped('new_design', undefined, mintOperationId('u'))
}

/** Get recently opened files list. */
export async function getRecentFiles(): Promise<DesignSummary[]> {
  return invokeTyped('get_recent_files', undefined, mintOperationId('u'))
}

/**
 * Start › Recent Designs previews (counts, ground bounds, sketch) read from
 * the listed files. Paths not on the list are skipped.
 */
export async function getRecentDesignPreviews(paths: readonly string[]): Promise<RecentDesignSummary[]> {
  return invokeTyped('get_recent_design_previews', { paths }, mintOperationId('u'))
}

/** Start › Recent Designs › Remove from list; the file is untouched. */
export async function removeRecentDesign(path: string): Promise<void> {
  return invokeTyped('remove_recent_design', { path }, mintOperationId('u'))
}

/** Start › Recent Designs › Show in folder. */
export async function showRecentDesignInFolder(path: string): Promise<void> {
  return invokeTyped('show_recent_design_in_folder', { path }, mintOperationId('u'))
}

/** Get saved Design references plus user-owned Notebook Section organization. */
export async function getDesignNotebook(): Promise<DesignNotebookSnapshot> {
  return invokeTyped('get_design_notebook', undefined, mintOperationId('u'))
}

export async function createNotebookSection(name: string): Promise<DesignNotebookSection> {
  return invokeTyped('create_notebook_section', { name }, mintOperationId('u'))
}

export async function addDesignReferenceToNotebook(
  path: string,
  content: CanopiFile,
): Promise<void> {
  return invokeTyped('add_design_reference_to_notebook', { path, content }, mintOperationId('u'))
}

export async function renameNotebookSection(sectionId: string, name: string): Promise<void> {
  return invokeTyped('rename_notebook_section', { sectionId, name }, mintOperationId('u'))
}

export async function deleteNotebookSection(sectionId: string): Promise<void> {
  return invokeTyped('delete_notebook_section', { sectionId }, mintOperationId('u'))
}

export async function moveDesignReferenceToSection(
  path: string,
  sectionId: string | null,
): Promise<void> {
  return invokeTyped('move_design_reference_to_section', { path, sectionId }, mintOperationId('u'))
}

export async function relocateDesignReference(
  path: string,
  sectionId: string | null,
  paths: string[],
): Promise<void> {
  return invokeTyped('relocate_design_reference', { path, sectionId, paths }, mintOperationId('u'))
}

export async function removeDesignReference(path: string): Promise<void> {
  return invokeTyped('remove_design_reference', { path }, mintOperationId('u'))
}

export async function reorderNotebookSections(sectionIds: string[]): Promise<void> {
  return invokeTyped('reorder_notebook_sections', { sectionIds }, mintOperationId('u'))
}

export async function reorderDesignReferences(paths: string[]): Promise<void> {
  return invokeTyped('reorder_design_references', { paths }, mintOperationId('u'))
}
