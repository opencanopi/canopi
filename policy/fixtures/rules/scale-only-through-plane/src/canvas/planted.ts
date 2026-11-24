// Planted violation for scale-only-through-plane (§18 F36, contracts §20):
// latitude-based cosine scaling outside desktop/web/src/geo/.
export function plantedLatitudeScale(lat: number): number {
  return Math.cos(lat * Math.PI / 180)
}
