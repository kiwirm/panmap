import crsGrids from '../formats/ocad/native/crs-grids.js'
import type { GridDef } from '../formats/ocad/native/crs-grids.js'

// Map units are 0.01 mm; project into metres. The paper-to-metre
// factor is (1 / 100 mm) × (1 metre / 1000 mm) = 1 / 100_000.
const MAP_UNITS_TO_M = 1 / 100_000

/**
 * Coord-transformation view over a `MapCrs`. Preserves the
 * `easting`/`northing`/`scale`/`gridId`/`grivation`/`code`/`catalog`/`name`
 * fields that the OCAD-shape `Crs` class exposed, plus the two
 * transformation methods used by consumers (geojson export, cli info).
 *
 * Constructed via `crsFromCanonical` from any georeferenced `Panmap`,
 * regardless of source format.
 */
export class CrsView {
  easting: number
  northing: number
  scale: number
  gridId: number
  grivation: number
  grid: GridDef | undefined
  code: number
  catalog: string | null
  name: string | null

  constructor(params: {
    easting: number
    northing: number
    scale: number
    grivation: number
    epsg?: number
  }) {
    this.easting = params.easting
    this.northing = params.northing
    this.scale = params.scale
    this.grivation = (params.grivation / 180) * Math.PI

    const grid = params.epsg !== undefined
      ? crsGrids.find(g => g[1] === params.epsg && g[2] === 'EPSG')
      : undefined
    this.grid = grid
    this.gridId = grid?.[0] ?? params.epsg ?? 0
    this.code = grid?.[1] ?? params.epsg ?? 0
    this.catalog = grid?.[2] ?? null
    this.name = grid?.[3] ?? null
  }

  toProjectedCoord(coord: number[]): number[] {
    const rotated = rotate(coord, -this.grivation)
    return [
      rotated[0] * MAP_UNITS_TO_M * this.scale + this.easting,
      rotated[1] * MAP_UNITS_TO_M * this.scale + this.northing,
    ]
  }

  toMapCoord(coord: number[]): number[] {
    const local = [
      (coord[0] - this.easting) / MAP_UNITS_TO_M / this.scale,
      (coord[1] - this.northing) / MAP_UNITS_TO_M / this.scale,
    ]
    return rotate(local, this.grivation)
  }
}

export function crsFromCanonical(params: {
  easting: number
  northing: number
  scale: number
  grivation: number
  epsg?: number
}): CrsView {
  return new CrsView(params)
}

function rotate(c: number[], theta: number): number[] {
  return [
    c[0] * Math.cos(theta) - c[1] * Math.sin(theta),
    c[0] * Math.sin(theta) + c[1] * Math.cos(theta),
  ]
}
