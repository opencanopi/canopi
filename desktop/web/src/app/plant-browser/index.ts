import type { SpeciesCatalogWorkbench } from './workbench'

export * from './workbench'
export { createEmptySpeciesFilter, plantFilterCatalog, plantFilterModel } from './plant-filter-model'

const workbenchSlot: { current: SpeciesCatalogWorkbench | null } = { current: null }

/** Installs the active edition's species catalog workbench (called by L5 edition roots). */
export function installSpeciesCatalogWorkbench(workbench: SpeciesCatalogWorkbench): () => void {
  const previous = workbenchSlot.current
  workbenchSlot.current = workbench
  return () => {
    if (workbenchSlot.current === workbench) workbenchSlot.current = previous
  }
}

function activeWorkbench(): SpeciesCatalogWorkbench {
  if (workbenchSlot.current === null) {
    throw new Error('SpeciesCatalogWorkbench is not installed: an edition root must bind it before use.')
  }
  return workbenchSlot.current
}

/** Lazy facade over the active edition's species catalog workbench (Stage 2 A1: no top-level port read). */
export const speciesCatalogWorkbench: SpeciesCatalogWorkbench = new Proxy({} as SpeciesCatalogWorkbench, {
  get(_target, prop, receiver) {
    const wb = activeWorkbench()
    const value = Reflect.get(wb, prop, receiver)
    return typeof value === 'function' ? value.bind(wb) : value
  },
  set(_target, prop, value, receiver) {
    return Reflect.set(activeWorkbench(), prop, value, receiver)
  },
  has(_target, prop) {
    return Reflect.has(activeWorkbench(), prop)
  },
  ownKeys() {
    return workbenchSlot.current === null ? [] : Reflect.ownKeys(workbenchSlot.current)
  },
  getOwnPropertyDescriptor(_target, prop) {
    return workbenchSlot.current === null ? undefined : Reflect.getOwnPropertyDescriptor(workbenchSlot.current, prop)
  },
  defineProperty(_target, prop, descriptor) {
    return Reflect.defineProperty(activeWorkbench(), prop, descriptor)
  },
})
export type {
  ActiveArrayChipField,
  ActiveBooleanChipField,
  ActiveChipField,
  ActiveNumericChipField,
  SpeciesFilterKey,
  StripBooleanField,
  StripChoiceField,
  StripControlField,
  StripOptionSource,
  StripThresholdField,
} from './plant-filter-model'
