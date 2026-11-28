import { signal } from '@preact/signals'

export const gridVisible = signal<boolean>(true)

/** Canvas-only visibility of zone dimension callouts (device/view state, never persisted in `.canopi` or `print_setup`). */
export const zoneDimensionsVisible = signal<boolean>(true)

export function toggleZoneDimensions(): void {
  zoneDimensionsVisible.value = !zoneDimensionsVisible.value
}
