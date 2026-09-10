import TdPoly from './td-poly.js'
import { InvalidSymbolElementError } from './errors.js'
import type BufferReader from './buffer-reader.js'
import type { SymbolElementType } from './symbol-element-types.js'

export default class SymbolElement {
  type: SymbolElementType
  flags: number
  color: number
  lineWidth: number
  diameter: number
  numberCoords: number
  coords: TdPoly[]

  constructor(reader: BufferReader) {
    const type = reader.readSmallInt()
    if (type < 1 || type > 4) {
      throw new InvalidSymbolElementError(
        `Symbol element with invalid type (${type}).`
      )
    }

    this.type = type as SymbolElementType
    this.flags = reader.readWord()
    this.color = reader.readSmallInt()
    this.lineWidth = reader.readSmallInt()
    this.diameter = reader.readSmallInt()
    this.numberCoords = reader.readSmallInt()
    reader.readCardinal() // Reserved

    if (this.numberCoords < 0) {
      // Negative coord counts have appeared in real files; bail rather than allocate.
      throw new InvalidSymbolElementError(
        `Symbol element with invalid (${this.numberCoords}) number of coordinates.`,
        this
      )
    }

    this.coords = new Array(this.numberCoords)
    for (let j = 0; j < this.numberCoords; j++) {
      this.coords[j] = new TdPoly(reader.readInteger(), reader.readInteger())
    }
  }
}
