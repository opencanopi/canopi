import { signal } from '@preact/signals'
import { createDesignNotebookWorkbench } from '../src/app/design-notebook/workbench'
import type { DesignNotebookSnapshot } from '../src/types/design'
import { designFixture } from './fixtures'
import { activity } from './memory-backend'

const state = new URLSearchParams(location.search).get('state')
const file = designFixture()
const activePath = signal<string | null>('/gallery/orchard.canopi')
let sequence = 2
const notebook: DesignNotebookSnapshot = {
  sections: state === 'empty' ? [] : [{ id: 'site', name: 'Orchard & garden', sort_order: 0, created_at: file.created_at, updated_at: file.updated_at }, { id: 'studies', name: 'Seasonal studies', sort_order: 1, created_at: file.created_at, updated_at: file.updated_at }],
  entries: state === 'empty' ? [] : ['Orchard notebook', 'Kitchen garden', 'North boundary', 'Spring planting', 'Autumn succession'].map((name, index) => ({
    path: index === 0 ? activePath.value! : `/gallery/design-${index}.canopi`,
    name: state === 'long' ? `${name} — long-term planting and succession study` : name,
    section_id: index < 3 ? 'site' : 'studies', sort_order: index, updated_at: '2026-09-10T10:00:00Z', plant_count: 12 + index * 7,
  })),
}
const reorderEntries = async (paths: string[]) => {
  notebook.entries = paths.map((path, sort_order) => ({ ...notebook.entries.find(entry => entry.path === path)!, sort_order }))
}
export const notebookWorkbench = createDesignNotebookWorkbench({
  activePath, currentDesign: signal(file),
  loadNotebook: async () => structuredClone(notebook),
  openDesign: async path => { activePath.value = path; activity.value = 'Opened the notebook reference in memory.' },
  saveCurrent: async () => true,
  saveAsCurrent: async () => ({ status: 'applied', path: activePath.value, content: file }),
  addDesignReference: async (path, content) => { notebook.entries.push({ path, name: content.name, updated_at: content.updated_at, plant_count: content.plants.length, section_id: null, sort_order: notebook.entries.length }) },
  removeEntry: async path => { notebook.entries = notebook.entries.filter(entry => entry.path !== path) },
  createSection: async name => {
    const section = { id: `section-${sequence++}`, name, sort_order: notebook.sections.length, created_at: file.created_at, updated_at: file.updated_at }
    notebook.sections.push(section); return section
  },
  renameSection: async (id, name) => { notebook.sections = notebook.sections.map(section => section.id === id ? { ...section, name } : section) },
  deleteSection: async id => {
    notebook.sections = notebook.sections.filter(section => section.id !== id)
    notebook.entries = notebook.entries.map(entry => entry.section_id === id ? { ...entry, section_id: null } : entry)
  },
  moveEntryToSection: async (path, section_id) => { notebook.entries = notebook.entries.map(entry => entry.path === path ? { ...entry, section_id } : entry) },
  reorderSections: async ids => { notebook.sections = ids.map((id, sort_order) => ({ ...notebook.sections.find(section => section.id === id)!, sort_order })) },
  reorderEntries,
  relocateEntry: async (path, section_id, paths) => {
    notebook.entries = notebook.entries.map(entry => entry.path === path ? { ...entry, section_id } : entry)
    await reorderEntries(paths)
  },
})
if (import.meta.hot) import.meta.hot.dispose(() => notebookWorkbench.dispose())
