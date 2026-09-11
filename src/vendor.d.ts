/**
 * Ambient declarations for untyped npm dependencies used by the CLI
 * exporters and the OCAD georeferencing reader. These stubs type only
 * the members panmap actually calls — they are intentionally minimal,
 * not a full model of each library's API.
 */

declare module 'reproject' {
  import type { FeatureCollection } from 'geojson'
  /** Reproject a GeoJSON object from a proj4 definition to WGS84 lon/lat. */
  export function toWgs84(
    geojson: FeatureCollection,
    from?: string,
    to?: string,
  ): FeatureCollection
  const reproject: { toWgs84: typeof toWgs84 }
  export default reproject
}

declare module 'geojson-vt' {
  import type { GeoJSON } from 'geojson'
  /** A z/x/y tile address produced by the slicer. */
  interface TileCoord {
    z: number
    x: number
    y: number
  }
  interface GeoJsonVtIndex {
    tileCoords: TileCoord[]
    getTile(z: number, x: number, y: number): unknown
  }
  export default function geojsonvt(
    data: GeoJSON,
    options?: {
      maxZoom?: number
      indexMaxZoom?: number
      indexMaxPoints?: number
      [key: string]: unknown
    },
  ): GeoJsonVtIndex
}

declare module 'vt-pbf' {
  /** Serialise a geojson-vt tile (keyed by layer name) into MVT bytes. */
  export function fromGeojsonVt(
    layers: Record<string, unknown>,
    options?: unknown,
  ): Uint8Array
  const vtpbf: { fromGeojsonVt: typeof fromGeojsonVt }
  export default vtpbf
}

declare module 'bezier-js' {
  interface BezierPoint {
    x: number
    y: number
  }
  /** Minimal surface: construct from a flat coord list, sample a LUT. */
  export default class Bezier {
    constructor(coords: number[])
    getLUT(steps?: number): BezierPoint[]
  }
}

declare module 'proj4' {
  interface Proj4 {
    (
      fromProjection: string,
      toProjection: string,
      coordinates: number[],
    ): number[]
    (fromProjection: string, coordinates: number[]): number[]
  }
  const proj4: Proj4
  export default proj4
}
