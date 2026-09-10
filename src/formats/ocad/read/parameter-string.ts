import { StringDecoder } from 'node:string_decoder'
import type BufferReader from './buffer-reader.js'

const decoder = new StringDecoder('utf8')

type StringIndexValue = string | string[]

interface TStringIndex {
  pos: number
  len: number
  recType: number
  objIndex: number
}

export type ParameterStringValues = {
  _first: string
  _pairs: { code: string; value: StringIndexValue }[]
  [key: string]: StringIndexValue | { code: string; value: StringIndexValue }[]
}

/**
 * Represents an OCAD parameter string. The string has the following format:
 * ```
 * <first value>\t<code1><value1>\t<code2><value2>\t...
 * ```
 *
 * The values can be accessed through the `values` property. The first value is
 * stored in the `_first` property. The code-value pairs are stored in the
 * `_pairs` property.
 */
export default class ParameterString {
  recType: number
  values: ParameterStringValues
  /** Source byte range (length matches the index `len` for unmodified records). */
  _byteRange?: { start: number; end: number }
  /** Original index record (carries recType, objIndex, len) for round-trip. */
  _indexRecord?: TStringIndex

  constructor(reader: BufferReader, indexRecord: TStringIndex) {
    this.recType = indexRecord.recType
    this._indexRecord = indexRecord

    const offset = reader.offset
    let strLen = 0
    while (reader.readByte()) strLen++
    this._byteRange = { start: offset, end: offset + indexRecord.len }
    const val = decoder.end(reader.buffer.subarray(offset, offset + strLen))

    const vals = val.split('\t')
    this.values = { _first: vals[0], _pairs: [] }
    for (let i = 1; i < vals.length; i++) {
      const code = vals[i][0]
      const value = vals[i].substring(1)
      let codeValues = this.values[code] as StringIndexValue | undefined
      if (!codeValues) {
        this.values[code] = value
      } else {
        if (!Array.isArray(codeValues)) {
          codeValues = this.values[code] = [codeValues]
        }
        codeValues.push(value)
      }

      this.values._pairs.push({ code, value })
    }
  }
}
