import ParameterString from './parameter-string.js'
import type BufferReader from './buffer-reader.js'

export interface TStringIndex {
  pos: number
  len: number
  recType: number
  objIndex: number
}

export default class StringIndexBlock {
  nextStringIndexBlock: number
  table: TStringIndex[]

  constructor(reader: BufferReader) {
    this.nextStringIndexBlock = reader.readInteger()
    this.table = new Array(256)
    for (let i = 0; i < 256; i++) {
      this.table[i] = {
        pos: reader.readInteger(),
        len: reader.readInteger(),
        recType: reader.readInteger(),
        objIndex: reader.readInteger(),
      }
    }
  }

  getStrings(reader: BufferReader): Record<number, ParameterString[]> {
    return this.getStringsInOrder(reader).reduce((pss, ps) => {
      let typeStrings = pss[ps.recType]
      if (!typeStrings) {
        pss[ps.recType] = typeStrings = []
      }

      typeStrings.push(ps)

      return pss
    }, {} as Record<number, ParameterString[]>)
  }

  /** Same parsing as `getStrings`, but returns records in original disk order. */
  getStringsInOrder(reader: BufferReader): ParameterString[] {
    return this.table
      .filter(si => si.recType > 0)
      .map(si => {
        reader.push(si.pos)
        const s = new ParameterString(reader, si)
        reader.pop()
        return s
      })
  }
}
