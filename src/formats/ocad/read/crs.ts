import crsGrids from './crs-grids.js'
import TdPoly from './td-poly.js'
import type { GridDef } from './crs-grids.js'
import type { ParameterStringValues } from './parameter-string.js'

// OCAD uses 1/100 mm of "paper coordinates" as units, we
// want to convert to meters in real world
const hundredsMmToMeter = 1 / (100 * 1000)

export default class Crs {
  easting: number
  northing: number
  scale: number
  gridId: number
  grivation: number
  grid: GridDef | undefined
  code: number
  catalog: string | null
  name: string | null

  constructor(scalePar: ParameterStringValues) {
    const {
      x: easting,
      y: northing,
      m: scale,
      i: gridId,
      a: grivation,
    } = scalePar

    this.easting = Number(easting)
    this.northing = Number(northing)
    this.scale = Number(scale)
    this.gridId = Number(gridId)
    this.grivation = (Number(grivation) / 180) * Math.PI

    this.grid = crsGrids.find(g => g[0] === this.gridId)
    const [, code, catalog, name] = this.grid || [this.gridId, 0, null, null]
    this.code = code
    this.catalog = catalog
    this.name = name
  }

  toProjectedCoord(coord: TdPoly | number[]): TdPoly | number[] {
    coord = rotate(coord, -this.grivation)

    const projected = [
      coord[0] * hundredsMmToMeter * this.scale + this.easting,
      coord[1] * hundredsMmToMeter * this.scale + this.northing,
    ]
    return coord instanceof TdPoly
      ? new TdPoly(projected[0], projected[1], coord.xFlags, coord.yFlags)
      : projected
  }

  toMapCoord(coord: TdPoly | number[]): TdPoly | number[] {
    const map = [
      (coord[0] - this.easting) / hundredsMmToMeter / this.scale,
      (coord[1] - this.northing) / hundredsMmToMeter / this.scale,
    ]
    coord = rotate(coord, this.grivation)
    return coord instanceof TdPoly
      ? new TdPoly(map[0], map[1], coord.xFlags, coord.yFlags)
      : map
  }
}

/**
 * Rotates a coordinate around the origin.
 *
 * @param {number[]|TdPoly} c the coordinate to rotate
 * @param {number} theta rotation angle in radians
 * @returns {number[]|TdPoly} the rotated coordinate;
 * if the input is a TdPoly, the output is a TdPoly instance, otherwise just a coordinate array
 */
function rotate(c: TdPoly | number[], theta: number): TdPoly | number[] {
  if (c instanceof TdPoly) {
    return c.rotate(theta)
  } else {
    return [
      c[0] * Math.cos(theta) - c[1] * Math.sin(theta),
      c[0] * Math.sin(theta) + c[1] * Math.cos(theta),
    ]
  }
}
