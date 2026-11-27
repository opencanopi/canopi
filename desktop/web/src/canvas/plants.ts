/** Below 0.5 px/m (a far overview) every plant draws as a dot, whatever its symbol. */
export function isDotScale(pixelsPerMetre: number): boolean {
  return pixelsPerMetre < 0.5
}
