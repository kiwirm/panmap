import BaseSymbol from './symbol.js'
import type { BaseSymbolProps } from './symbol.js'
import type BufferReader from './buffer-reader.js'
import { TextSymbolType } from './symbol-types.js'

export const VerticalAlignBottom = 0
export const VerticalAlignMiddle = 4
export const VerticalAlignTop = 8
export const HorizontalAlignLeft = 0
export const HorizontalAlignCenter = 1
export const HorizontalAlignRight = 2
export const HorizontalAlignAllLine = 3

const verticalAlignment = (a: number) => a & 0xfc
const horizontalAlignment = (a: number) => a & 0x03

export interface TextSymbolProps {
  type: typeof TextSymbolType
  fontName: string
  fontColor: number
  fontSize: number
  weight: number
  italic: boolean
  res1: number
  charSpace: number
  wordSpace: number
  alignment: number
  lineSpace: number
  paraSpace: number
  indentFirst: number
  indentOther: number
  nTabs: number
  tabs: number[]
  lbOn: boolean
  lbColor: number
  lbWidth: number
  lbDist: number
  res2: number
  frMode: number
  frStyle: number
  pointSymOn: boolean
  pointSymNumber: number
  getHorizontalAlignment(): number
  getVerticalAlignment(): number
}

export type TextSymbolDef = BaseSymbolProps & TextSymbolProps

export default class TextSymbol extends BaseSymbol implements TextSymbolProps {
  type: typeof TextSymbolType = TextSymbolType
  fontName!: string
  fontColor!: number
  fontSize!: number
  weight!: number
  italic!: boolean
  res1!: number
  charSpace!: number
  wordSpace!: number
  alignment!: number
  lineSpace!: number
  paraSpace!: number
  indentFirst!: number
  indentOther!: number
  nTabs!: number
  tabs!: number[]
  lbOn!: boolean
  lbColor!: number
  lbWidth!: number
  lbDist!: number
  res2!: number
  frMode!: number
  frStyle!: number
  pointSymOn!: boolean
  pointSymNumber!: number
  /** Raw 32-byte fontName field as on disk (length prefix + chars + junk). */
  _fontNameBytes?: Uint8Array

  constructor(reader: BufferReader, version: number) {
    super()
    this.readHeader(reader)
    this.readCommonBody(reader, version)

    // ASCII fontName: 1 length byte + up to 31 chars (Pascal-style),
    // followed by trailing junk OCAD may leave behind when fonts change.
    // Capture all 32 raw bytes so the encoder can emit them verbatim.
    const fontNameStart = reader.offset
    const fontLength = reader.readByte()
    let fontName = ''
    for (let i = 0; i < fontLength; i++) {
      const c = reader.readByte()
      if (c) fontName += String.fromCharCode(c)
    }
    for (let i = 1; i < 32 - fontLength; i++) reader.readByte()
    this.fontName = fontName
    this._fontNameBytes = new Uint8Array(
      reader.buffer.subarray(fontNameStart, fontNameStart + 32)
    )

    this.fontColor = reader.readSmallInt()
    this.fontSize = reader.readSmallInt()
    this.weight = reader.readSmallInt()
    this.italic = !!reader.readByte()
    this.res1 = reader.readByte()
    this.charSpace = reader.readSmallInt()
    this.wordSpace = reader.readSmallInt()
    this.alignment = reader.readSmallInt()
    this.lineSpace = reader.readSmallInt()
    this.paraSpace = reader.readSmallInt()
    this.indentFirst = reader.readSmallInt()
    this.indentOther = reader.readSmallInt()
    this.nTabs = reader.readSmallInt()
    this.tabs = new Array(32)
    for (let i = 0; i < 32; i++) this.tabs[i] = reader.readCardinal()
    this.lbOn = reader.readWordBool()
    this.lbColor = reader.readSmallInt()
    this.lbWidth = reader.readSmallInt()
    this.lbDist = reader.readSmallInt()
    this.res2 = reader.readSmallInt()
    this.frMode = reader.readByte()
    this.frStyle = reader.readByte()
    this.pointSymOn = !!reader.readByte()
    this.pointSymNumber = reader.readByte()
    // TODO: Some frame parameters ignored here
  }

  getVerticalAlignment(): number {
    return verticalAlignment(this.alignment)
  }

  getHorizontalAlignment(): number {
    return horizontalAlignment(this.alignment)
  }
}
