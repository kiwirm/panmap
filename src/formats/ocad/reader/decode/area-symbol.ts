import BaseSymbol from './symbol.js'
import type { BaseSymbolProps } from './symbol.js'
import type SymbolElement from './symbol-element.js'
import type BufferReader from './buffer-reader.js'
import { AreaSymbolType } from '../../native/symbol-types.js'

export interface AreaSymbolProps {
  type: typeof AreaSymbolType
  borderSym: number
  fillColor: number
  hatchMode: number
  hatchColor: number
  hatchLineWidth: number
  hatchDist: number
  hatchAngle1: number
  hatchAngle2: number
  fillOn: boolean
  borderOn: boolean
  structMode: number
  structWidth: number
  structHeight: number
  structAngle: number
  structRes: number
  dataSize: number
  elements: SymbolElement[]
  /** v12+ only. */
  structDraw?: number
  structIrregularVarX?: number
  structIrregularVarY?: number
  structIrregularMinDist?: number
}

export type AreaSymbolDef = BaseSymbolProps & AreaSymbolProps

export default class AreaSymbol extends BaseSymbol implements AreaSymbolProps {
  type: typeof AreaSymbolType = AreaSymbolType
  borderSym!: number
  fillColor!: number
  hatchMode!: number
  hatchColor!: number
  hatchLineWidth!: number
  hatchDist!: number
  hatchAngle1!: number
  hatchAngle2!: number
  fillOn!: boolean
  borderOn!: boolean
  structMode!: number
  structWidth!: number
  structHeight!: number
  structAngle!: number
  structRes!: number
  dataSize!: number
  elements!: SymbolElement[]
  structDraw?: number
  structIrregularVarX?: number
  structIrregularVarY?: number
  structIrregularMinDist?: number

  constructor(reader: BufferReader, version: number) {
    super()
    this.readHeader(reader)
    this.readCommonBody(reader, version)

    this.borderSym = reader.readInteger()
    this.fillColor = reader.readSmallInt()
    this.hatchMode = reader.readSmallInt()
    this.hatchColor = reader.readSmallInt()
    this.hatchLineWidth = reader.readSmallInt()
    this.hatchDist = reader.readSmallInt()
    this.hatchAngle1 = reader.readSmallInt()
    this.hatchAngle2 = reader.readSmallInt()
    this.fillOn = !!reader.readByte()
    this.borderOn = !!reader.readByte()

    if (version >= 12) {
      this.structMode = reader.readByte()
      this.structDraw = reader.readByte()
      this.structWidth = reader.readSmallInt()
      this.structHeight = reader.readSmallInt()
      this.structAngle = reader.readSmallInt()
      this.structIrregularVarX = reader.readByte()
      this.structIrregularVarY = reader.readByte()
      this.structIrregularMinDist = reader.readSmallInt()
    } else {
      this.structMode = reader.readSmallInt()
      this.structWidth = reader.readSmallInt()
      this.structHeight = reader.readSmallInt()
      this.structAngle = reader.readSmallInt()
    }
    this.structRes = reader.readSmallInt()
    this.dataSize = reader.readWord()

    this.elements = this.readElements(reader, this.dataSize)
  }
}
