import BaseSymbol from './symbol.js'
import type { BaseSymbolProps } from './symbol.js'
import type SymbolElement from './symbol-element.js'
import type BufferReader from './buffer-reader.js'
import { LineSymbolType } from '../../native/symbol-types.js'

export interface DoubleLine {
  dblMode: number
  dblFlags: number
  dblFillColor: number
  dblLeftColor: number
  dblRightColor: number
  dblWidth: number
  dblLeftWidth: number
  dblRightWidth: number
  dblLength: number
  dblGap: number
  /** v11+ only. */
  dblBackgroundColor?: number
  dblRes: number[]
}

export interface Decrease {
  decMode: number
  /** v11+ field; on v10 the field is `decLast` and is stored on `_decLast`. */
  decSymbolSize?: number
  decSymbolDistance?: boolean
  decSymbolWidth?: boolean
  /** v10-only. */
  _decLast?: number
  _res?: number
}

export interface LineSymbolProps {
  type: typeof LineSymbolType
  lineColor: number
  lineWidth: number
  lineStyle: number
  distFromStart: number
  distToEnd: number
  mainLength: number
  endLength: number
  mainGap: number
  secGap: number
  endGap: number
  minSym: number
  nPrimSym: number
  primSymDist: number
  doubleLine: DoubleLine
  decrease: Decrease
  frColor: number
  frWidth: number
  frStyle: number
  primDSize: number
  secDSize: number
  cornerDSize: number
  startDSize: number
  endDSize: number
  useSymbolFlags: number
  reserved: number
  primSymElements: SymbolElement[]
  secSymElements: SymbolElement[]
  cornerSymElements: SymbolElement[]
  startSymElements: SymbolElement[]
  endSymElements: SymbolElement[]
}

export type LineSymbolDef = BaseSymbolProps & LineSymbolProps

export default class LineSymbol extends BaseSymbol implements LineSymbolProps {
  type: typeof LineSymbolType = LineSymbolType
  lineColor!: number
  lineWidth!: number
  lineStyle!: number
  distFromStart!: number
  distToEnd!: number
  mainLength!: number
  endLength!: number
  mainGap!: number
  secGap!: number
  endGap!: number
  minSym!: number
  nPrimSym!: number
  primSymDist!: number
  doubleLine!: DoubleLine
  decrease!: Decrease
  frColor!: number
  frWidth!: number
  frStyle!: number
  primDSize!: number
  secDSize!: number
  cornerDSize!: number
  startDSize!: number
  endDSize!: number
  useSymbolFlags!: number
  reserved!: number
  primSymElements!: SymbolElement[]
  secSymElements!: SymbolElement[]
  cornerSymElements!: SymbolElement[]
  startSymElements!: SymbolElement[]
  endSymElements!: SymbolElement[]

  constructor(reader: BufferReader, version: number) {
    super()
    this.readHeader(reader)
    this.readCommonBody(reader, version)

    this.lineColor = reader.readSmallInt()
    this.lineWidth = reader.readSmallInt()
    this.lineStyle = reader.readSmallInt()
    this.distFromStart = reader.readSmallInt()
    this.distToEnd = reader.readSmallInt()
    this.mainLength = reader.readSmallInt()
    this.endLength = reader.readSmallInt()
    this.mainGap = reader.readSmallInt()
    this.secGap = reader.readSmallInt()
    this.endGap = reader.readSmallInt()
    this.minSym = reader.readSmallInt()
    this.nPrimSym = reader.readSmallInt()
    this.primSymDist = reader.readSmallInt()

    this.doubleLine = readDoubleLine(reader, version)
    this.decrease = readDecrease(reader, version)

    this.frColor = reader.readSmallInt()
    this.frWidth = reader.readSmallInt()
    this.frStyle = reader.readSmallInt()
    this.primDSize = reader.readWord()
    this.secDSize = reader.readWord()
    this.cornerDSize = reader.readWord()
    this.startDSize = reader.readWord()
    this.endDSize = reader.readWord()
    this.useSymbolFlags = reader.readByte()
    this.reserved = reader.readByte()

    this.primSymElements = this.readElements(reader, this.primDSize)
    this.secSymElements = this.readElements(reader, this.secDSize)
    this.cornerSymElements = this.readElements(reader, this.cornerDSize)
    this.startSymElements = this.readElements(reader, this.startDSize)
    this.endSymElements = this.readElements(reader, this.endDSize)
  }
}

function readDoubleLine(reader: BufferReader, version: number): DoubleLine {
  const dl: DoubleLine = {
    dblMode: reader.readWord(),
    dblFlags: reader.readWord(),
    dblFillColor: reader.readSmallInt(),
    dblLeftColor: reader.readSmallInt(),
    dblRightColor: reader.readSmallInt(),
    dblWidth: reader.readSmallInt(),
    dblLeftWidth: reader.readSmallInt(),
    dblRightWidth: reader.readSmallInt(),
    dblLength: reader.readSmallInt(),
    dblGap: reader.readSmallInt(),
    dblRes: [],
  }
  if (version === 10) {
    dl.dblRes = [reader.readSmallInt(), reader.readSmallInt(), reader.readSmallInt()]
  } else {
    dl.dblBackgroundColor = reader.readSmallInt()
    dl.dblRes = [reader.readSmallInt(), reader.readSmallInt()]
  }
  return dl
}

function readDecrease(reader: BufferReader, version: number): Decrease {
  if (version === 10) {
    return {
      decMode: reader.readWord(),
      _decLast: reader.readWord(),
      _res: reader.readWord(),
    }
  }
  return {
    decMode: reader.readWord(),
    decSymbolSize: reader.readSmallInt(),
    decSymbolDistance: !!reader.readByte(),
    decSymbolWidth: !!reader.readByte(),
  }
}
