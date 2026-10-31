// Planted violation of single-lonlat-point-type (§18 F39, 2.1-M212): a hand-written lon/lat point type beside the
// generated GeoPoint.
export interface PlantedPoint {
  readonly lon: number
  readonly lat: number
}
