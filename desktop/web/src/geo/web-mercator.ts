/**
 * geo/web-mercator.ts: Owner of Web Mercator formulas and derived constants (no-webmercator-literal, ADR 0001, 2.1-Q45, contracts §18 F19 & §20).
 * Invariant: fundamental constants come from canopi-types via generated/canopi-design-format.ts; no other TS module
 * carries Web Mercator literals or projection formulas.
 */

import {
  WEB_MERCATOR_MAX_LATITUDE_DEG,
  WGS84_SEMI_MAJOR_AXIS_M,
} from '../generated/canopi-design-format'

const DEGREES_TO_RADIANS = Math.PI / 180

/** The largest 1e-9 degree grid latitude inside Web Mercator's ±WEB_MERCATOR_MAX_LATITUDE_DEG. */
export const WEB_MERCATOR_GRID_MAX_LATITUDE_DEG = Math.floor(WEB_MERCATOR_MAX_LATITUDE_DEG * 1e9) / 1e9

/** Half the Web Mercator world extent in EPSG:3857 metres (π * a). */
export const WEB_MERCATOR_HALF_WORLD_M = Math.PI * WGS84_SEMI_MAJOR_AXIS_M

export interface MapMercatorCoordinate {
  x: number
  y: number
}

function mercatorXfromLng(lng: number): number {
  return (180 + lng) / 360
}

function mercatorYfromLat(lat: number): number {
  return (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * DEGREES_TO_RADIANS / 2)))) / 360
}

function lngFromMercatorX(x: number): number {
  return x * 360 - 180
}

function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360
  return 360 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90
}

/** Normalized [0, 1] Web Mercator coordinate (MapLibre convention). */
export function geoToMercator(lng: number, lat: number): MapMercatorCoordinate {
  return {
    x: mercatorXfromLng(lng),
    y: mercatorYfromLat(lat),
  }
}

/** Geographic lon/lat from normalized [0, 1] Web Mercator coordinate. */
export function mercatorToGeo(x: number, y: number) {
  return {
    lng: lngFromMercatorX(x),
    lat: latFromMercatorY(y),
  }
}

/** EPSG:3857 Web Mercator X in metres from longitude in degrees. */
export function lonToWebMercatorX(lon: number): number {
  return (lon / 180) * WEB_MERCATOR_HALF_WORLD_M
}

/** Longitude in degrees from EPSG:3857 Web Mercator X in metres. */
export function webMercatorXToLon(x: number): number {
  return (x / WEB_MERCATOR_HALF_WORLD_M) * 180
}

/** Latitude in degrees from EPSG:3857 Web Mercator Y in metres. */
export function webMercatorYToLat(y: number): number {
  return (Math.atan(Math.exp((y / WEB_MERCATOR_HALF_WORLD_M) * Math.PI)) * 360) / Math.PI - 90
}
