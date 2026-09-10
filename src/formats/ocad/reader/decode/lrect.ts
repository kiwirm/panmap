import TdPoly from './td-poly.js'
import type BufferReader from './buffer-reader.js'

export default class LRect {
  min: TdPoly
  max: TdPoly

  constructor(reader: BufferReader) {
    this.min = new TdPoly(reader.readInteger(), reader.readInteger())
    this.max = new TdPoly(reader.readInteger(), reader.readInteger())
  }
}
