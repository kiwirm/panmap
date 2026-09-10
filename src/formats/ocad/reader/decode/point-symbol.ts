import BaseSymbol from './symbol.js'
import type { BaseSymbolProps } from './symbol.js'
import type SymbolElement from './symbol-element.js'
import type BufferReader from './buffer-reader.js'
import { PointSymbolType } from '../../native/symbol-types.js'

export interface PointSymbolProps {
  type: typeof PointSymbolType
  dataSize: number
  elements: SymbolElement[]
}

export type PointSymbolDef = BaseSymbolProps & PointSymbolProps

export default class PointSymbol extends BaseSymbol implements PointSymbolProps {
  type: typeof PointSymbolType = PointSymbolType
  dataSize!: number
  elements!: SymbolElement[]

  constructor(reader: BufferReader, version: number) {
    super()
    this.readHeader(reader)
    this.readCommonBody(reader, version)

    this.dataSize = reader.readWord()
    reader.readSmallInt() // Reserved

    this.elements = this.readElements(reader, this.dataSize)
  }
}
