import getRgb from '../../../cmyk-to-rgb.js'
import Crs from '../reader/decode/crs.js'
import type FileHeader from './file-header.js'
import type LRect from '../reader/decode/lrect.js'
import type TdPoly from '../reader/decode/td-poly.js'
import type BaseSymbol from '../reader/decode/symbol.js'
import type { ParameterStringValues } from '../reader/decode/parameter-string.js'

type ParameterStringMap = Record<number | string, ParameterStringValues[]>

export interface OcadObjectWithBounds {
  objIndex: {
    rc: LRect
    status?: number
  }
  [key: string]: unknown
}

/**
 * Loose shape for a raw parameter-string record retained for byte-exact
 * round-trip. See `parameter-string.ts` for the strict class shape.
 */
export interface RawParameterStringRecord {
  recType: number
  values?: ParameterStringValues
  _byteRange?: { start: number; end: number }
  _indexRecord?: { pos: number; len: number; recType: number; objIndex: number }
}


export interface Color {
  number: number
  cmyk: [number, number, number, number]
  name: string
  rgb: string
  renderOrder: number
  rgbArray: Uint8ClampedArray
}

export default class OcadFile {
  header: FileHeader
  buffer?: Buffer
  parameterStrings: ParameterStringMap
  /**
   * Full ParameterString records in original disk order, retained for
   * byte-exact round-trip by the writer. Each carries `_byteRange` and
   * `_indexRecord` pointing into `buffer`. `parameterStrings` (grouped by
   * recType) remains the primary accessor for consumers.
   */
  rawParameterStrings: RawParameterStringRecord[]
  objects: OcadObjectWithBounds[]
  symbols: BaseSymbol[]
  warnings: string[]
  colors: Color[]

  constructor(
    header: FileHeader,
    parameterStrings: ParameterStringMap,
    objects: OcadObjectWithBounds[],
    symbols: BaseSymbol[],
    warnings: string[]
  ) {
    this.header = header
    this.parameterStrings = parameterStrings
    this.rawParameterStrings = []
    this.objects = objects
    this.symbols = symbols
    this.warnings = warnings

    this.colors = []
    const colorDefs = parameterStrings[9] || []
    for (let i = 0; i < colorDefs.length; i++) {
      const colorDef = colorDefs[i]
      const cmyk = [
        colorDef.c || 0,
        colorDef.m || 0,
        colorDef.y || 0,
        colorDef.k || 0,
      ].map(Number) as [number, number, number, number]
      const rgb = getRgb(cmyk)
      const color = {
        number: Number(colorDef.n),
        cmyk,
        name: colorDef._first,
        rgb: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
        renderOrder: i,
        rgbArray: rgb,
      }
      this.colors[Number(color.number)] = color
    }
  }

  getCrs(): Crs {
    const scalePar = this.parameterStrings['1039']
      ? this.parameterStrings['1039'][0]
      : { x: '0', y: '0', m: '1', _first: '', _pairs: [] }
    return new Crs(scalePar)
  }

  getBounds(projection: (coord: TdPoly) => number[] = v => v): number[] {
    const bounds = [
      Number.MAX_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]

    for (const [[x1, y1], [x2, y2]] of this.objects.map(o =>
      Object.values(o.objIndex.rc).map(projection)
    )) {
      bounds[0] = Math.min(x1, x2, bounds[0])
      bounds[1] = Math.min(y1, y2, bounds[1])
      bounds[2] = Math.max(x1, x2, bounds[2])
      bounds[3] = Math.max(y1, y2, bounds[3])
    }

    return bounds
  }
}
