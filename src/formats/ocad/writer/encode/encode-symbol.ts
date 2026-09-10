import { Buffer } from 'node:buffer'
import BufferWriter from './buffer-writer.js'
import { writeSymbolElement } from './encode-symbol-element.js'
import {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
} from '../../reader/decode/symbol-types.js'

interface Symbol11Like {
  // BaseSymbol header
  size: number
  symNum: number
  otp: number
  flags: number
  selected: boolean
  status: number
  preferredDrawingTool: number
  csMode: number
  csObjType: number
  csCdFlags: number
  extent: number
  filePos: number
  // Symbol11 body
  nColors: number
  colors: number[]
  description: string
  descriptionWords?: number[]
  iconBits: number[]
  symbolTreeGroup: number[]
  mystery64?: Uint8Array
  /** Unparsed trailing bytes captured by the reader (frame params, etc). */
  _tail?: Uint8Array
}

interface PointSymbolLike extends Symbol11Like {
  type: typeof PointSymbolType
  elements: Parameters<typeof writeSymbolElement>[1][]
}

interface LineSymbolLike extends Symbol11Like {
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
  doubleLine: {
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
    dblBackgroundColor?: number
    dblRes: number[]
  }
  decrease: {
    decMode: number
    decSymbolSize: number
    decSymbolDistance: boolean
    decSymbolWidth: boolean
  }
  frColor: number
  frWidth: number
  frStyle: number
  useSymbolFlags: number
  reserved: number
  primSymElements: Parameters<typeof writeSymbolElement>[1][]
  secSymElements: Parameters<typeof writeSymbolElement>[1][]
  cornerSymElements: Parameters<typeof writeSymbolElement>[1][]
  startSymElements: Parameters<typeof writeSymbolElement>[1][]
  endSymElements: Parameters<typeof writeSymbolElement>[1][]
}

interface AreaSymbol12Like extends Symbol11Like {
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
  structDraw: number
  structWidth: number
  structHeight: number
  structAngle: number
  structIrregularVarX: number
  structIrregularVarY: number
  structIrregularMinDist: number
  structRes: number
  elements: Parameters<typeof writeSymbolElement>[1][]
}

interface TextSymbol11Like extends Symbol11Like {
  type: typeof TextSymbolType
  fontName: string
  /** Raw 32-byte fontName field captured by the reader (length prefix + chars + trailing junk). */
  _fontNameBytes?: Uint8Array
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
}

type AnySymbol =
  | PointSymbolLike
  | LineSymbolLike
  | AreaSymbol12Like
  | TextSymbol11Like

/**
 * Encode a Symbol11-family symbol record (v12 / v2018). Patches the
 * leading `size` field with the final record length before returning.
 */
export function writeSymbol(writer: BufferWriter, symbol: AnySymbol): void {
  const start = writer.offset
  writer.writeInteger(0) // size — patched at end
  writer.writeInteger(symbol.symNum)
  writer.writeByte(symbol.otp)
  writer.writeByte(symbol.flags)
  writer.writeByte(symbol.selected ? 1 : 0)
  writer.writeByte(symbol.status)
  writer.writeByte(symbol.preferredDrawingTool)
  writer.writeByte(symbol.csMode)
  writer.writeByte(symbol.csObjType)
  writer.writeByte(symbol.csCdFlags)
  writer.writeInteger(symbol.extent)
  writer.writeCardinal(symbol.filePos >>> 0)

  // Symbol11 body
  writer.writeByte(0) // notUsed1
  writer.writeByte(0) // notUsed2
  writer.writeSmallInt(symbol.nColors)
  for (let i = 0; i < 14; i++) {
    writer.writeSmallInt(symbol.colors[i] ?? 0)
  }
  writeSymbol11Description(writer, symbol)
  writeIconBits(writer, symbol.iconBits)
  for (let i = 0; i < 64; i++) {
    writer.writeWord(symbol.symbolTreeGroup[i] ?? 0)
  }
  writeMystery64(writer, symbol.mystery64)

  // Type-specific body
  switch (symbol.type) {
    case PointSymbolType:
      writePointBody(writer, symbol as PointSymbolLike)
      break
    case LineSymbolType:
      writeLineBody(writer, symbol as LineSymbolLike)
      break
    case AreaSymbolType:
      writeAreaBody(writer, symbol as AreaSymbol12Like)
      break
    case TextSymbolType:
      writeTextBody(writer, symbol as TextSymbol11Like)
      break
    default:
      throw new Error(`Unsupported symbol type: ${(symbol as { type: number }).type}`)
  }

  // Emit any unparsed trailing bytes captured by the reader (e.g. text
  // symbol frame parameters). Without this, lossless round-trip wouldn't
  // work for symbols whose readers don't fully consume the record.
  if (symbol._tail && symbol._tail.length > 0) {
    writer.writeBytes(Buffer.from(symbol._tail))
  }

  const size = writer.offset - start
  writer.patchInteger(start, size)
}

function writeSymbol11Description(
  writer: BufferWriter,
  symbol: Symbol11Like
): void {
  // 64 words = 128 bytes UTF-16 (Mapper's Utf16PascalString<64>).
  // Prefer `descriptionWords` (captured raw) so trailing / embedded
  // zero bytes round-trip; fall back to re-encoding the JS string if
  // a caller built the symbol from scratch. Anything shorter than 64
  // words gets null-padded so Mapper's reader stops at the terminator
  // instead of continuing into iconBits (which surfaced as garbage
  // Chinese ideographs when the icon-index bytes were misread as
  // UTF-16 code units).
  const words = symbol.descriptionWords
  if (words && words.length >= 64) {
    for (let i = 0; i < 64; i++) writer.writeWord(words[i])
    return
  }
  const desc = symbol.description || ''
  for (let i = 0; i < 64; i++) {
    if (words && i < words.length) writer.writeWord(words[i])
    else writer.writeWord(i < desc.length ? desc.charCodeAt(i) : 0)
  }
}

function writeIconBits(writer: BufferWriter, iconBits: number[] | undefined): void {
  for (let i = 0; i < 484; i++) writer.writeByte(iconBits?.[i] ?? 0)
}

function writeMystery64(
  writer: BufferWriter,
  mystery64: Uint8Array | undefined
): void {
  // Historical: this used to emit 64 bytes of "mystery" data that
  // was actually the second half of the description field, misread
  // by the old symbol reader. The reader now covers the full 128-byte
  // description, so there's nothing left to write here — but we
  // still emit any legacy bytes captured on an older `mystery64` for
  // safety (they'll be zero-length arrays after re-reading).
  if (mystery64 && mystery64.length > 0) {
    writer.writeBytes(Buffer.from(mystery64))
  }
}

// --- Point ------------------------------------------------------------

function writePointBody(writer: BufferWriter, symbol: PointSymbolLike): void {
  const elementsStart = writer.offset
  // dataSize placeholder — patched after we encode elements.
  writer.writeWord(0)
  writer.writeSmallInt(0) // Reserved
  let dataWords = 0
  for (const el of symbol.elements || []) {
    dataWords += writeSymbolElement(writer, el)
  }
  // Patch dataSize as Word at the offset we reserved.
  writer.patchWord(elementsStart, dataWords)
}

// --- Line -------------------------------------------------------------

function writeLineBody(writer: BufferWriter, symbol: LineSymbolLike): void {
  writer.writeSmallInt(symbol.lineColor)
  writer.writeSmallInt(symbol.lineWidth)
  writer.writeSmallInt(symbol.lineStyle)
  writer.writeSmallInt(symbol.distFromStart)
  writer.writeSmallInt(symbol.distToEnd)
  writer.writeSmallInt(symbol.mainLength)
  writer.writeSmallInt(symbol.endLength)
  writer.writeSmallInt(symbol.mainGap)
  writer.writeSmallInt(symbol.secGap)
  writer.writeSmallInt(symbol.endGap)
  writer.writeSmallInt(symbol.minSym)
  writer.writeSmallInt(symbol.nPrimSym)
  writer.writeSmallInt(symbol.primSymDist)

  // DoubleLine11
  const dl = symbol.doubleLine
  writer.writeWord(dl.dblMode)
  writer.writeWord(dl.dblFlags)
  writer.writeSmallInt(dl.dblFillColor)
  writer.writeSmallInt(dl.dblLeftColor)
  writer.writeSmallInt(dl.dblRightColor)
  writer.writeSmallInt(dl.dblWidth)
  writer.writeSmallInt(dl.dblLeftWidth)
  writer.writeSmallInt(dl.dblRightWidth)
  writer.writeSmallInt(dl.dblLength)
  writer.writeSmallInt(dl.dblGap)
  writer.writeSmallInt(dl.dblBackgroundColor ?? 0)
  for (let i = 0; i < 2; i++) writer.writeSmallInt(dl.dblRes?.[i] ?? 0)

  // Decrease11
  const dec = symbol.decrease
  writer.writeWord(dec.decMode)
  writer.writeSmallInt(dec.decSymbolSize)
  writer.writeByte(dec.decSymbolDistance ? 1 : 0)
  writer.writeByte(dec.decSymbolWidth ? 1 : 0)

  writer.writeSmallInt(symbol.frColor)
  writer.writeSmallInt(symbol.frWidth)
  writer.writeSmallInt(symbol.frStyle)

  // primDSize/.../endDSize Word placeholders — we patch them after
  // encoding each element list so they reflect actual element sizes.
  const dSizeOffsets = [0, 0, 0, 0, 0].map(() => {
    const at = writer.offset
    writer.writeWord(0)
    return at
  })
  writer.writeByte(symbol.useSymbolFlags)
  writer.writeByte(symbol.reserved)

  const sizes = [
    encodeElementList(writer, symbol.primSymElements),
    encodeElementList(writer, symbol.secSymElements),
    encodeElementList(writer, symbol.cornerSymElements),
    encodeElementList(writer, symbol.startSymElements),
    encodeElementList(writer, symbol.endSymElements),
  ]
  for (let i = 0; i < 5; i++) writer.patchWord(dSizeOffsets[i], sizes[i])
}

function encodeElementList(
  writer: BufferWriter,
  elements: Parameters<typeof writeSymbolElement>[1][] | undefined
): number {
  let total = 0
  for (const el of elements || []) total += writeSymbolElement(writer, el)
  return total
}

// --- Area (v12 / v2018) -----------------------------------------------

function writeAreaBody(writer: BufferWriter, symbol: AreaSymbol12Like): void {
  writer.writeInteger(symbol.borderSym)
  writer.writeSmallInt(symbol.fillColor)
  writer.writeSmallInt(symbol.hatchMode)
  writer.writeSmallInt(symbol.hatchColor)
  writer.writeSmallInt(symbol.hatchLineWidth)
  writer.writeSmallInt(symbol.hatchDist)
  writer.writeSmallInt(symbol.hatchAngle1)
  writer.writeSmallInt(symbol.hatchAngle2)
  writer.writeByte(symbol.fillOn ? 1 : 0)
  writer.writeByte(symbol.borderOn ? 1 : 0)
  writer.writeByte(symbol.structMode)
  writer.writeByte(symbol.structDraw)
  writer.writeSmallInt(symbol.structWidth)
  writer.writeSmallInt(symbol.structHeight)
  writer.writeSmallInt(symbol.structAngle)
  writer.writeByte(symbol.structIrregularVarX)
  writer.writeByte(symbol.structIrregularVarY)
  writer.writeSmallInt(symbol.structIrregularMinDist)
  writer.writeSmallInt(symbol.structRes)
  const dataSizeAt = writer.offset
  writer.writeWord(0) // dataSize placeholder
  const dataWords = encodeElementList(writer, symbol.elements)
  writer.patchWord(dataSizeAt, dataWords)
}

// --- Text -------------------------------------------------------------

function writeTextBody(writer: BufferWriter, symbol: TextSymbol11Like): void {
  // 32-byte ASCII fontName. Prefer the captured raw bytes (preserves
  // post-length-prefix junk OCAD sometimes leaves behind when fonts are
  // changed); fall back to re-encoding from the parsed string.
  if (symbol._fontNameBytes && symbol._fontNameBytes.length === 32) {
    writer.writeBytes(Buffer.from(symbol._fontNameBytes))
  } else {
    writeFontName(writer, symbol.fontName || '')
  }

  writer.writeSmallInt(symbol.fontColor)
  writer.writeSmallInt(symbol.fontSize)
  writer.writeSmallInt(symbol.weight)
  writer.writeByte(symbol.italic ? 1 : 0)
  writer.writeByte(symbol.res1)
  writer.writeSmallInt(symbol.charSpace)
  writer.writeSmallInt(symbol.wordSpace)
  writer.writeSmallInt(symbol.alignment)
  writer.writeSmallInt(symbol.lineSpace)
  writer.writeSmallInt(symbol.paraSpace)
  writer.writeSmallInt(symbol.indentFirst)
  writer.writeSmallInt(symbol.indentOther)
  writer.writeSmallInt(symbol.nTabs)
  for (let i = 0; i < 32; i++) writer.writeCardinal((symbol.tabs?.[i] ?? 0) >>> 0)
  writer.writeWord(symbol.lbOn ? 1 : 0)
  writer.writeSmallInt(symbol.lbColor)
  writer.writeSmallInt(symbol.lbWidth)
  writer.writeSmallInt(symbol.lbDist)
  writer.writeSmallInt(symbol.res2)
  writer.writeByte(symbol.frMode)
  writer.writeByte(symbol.frStyle)
  writer.writeByte(symbol.pointSymOn ? 1 : 0)
  writer.writeByte(symbol.pointSymNumber)
}

function writeFontName(writer: BufferWriter, fontName: string): void {
  const bytes = Buffer.from(fontName, 'ascii').subarray(0, 31)
  writer.writeByte(bytes.length)
  writer.writeBytes(bytes)
  for (let i = bytes.length; i < 31; i++) writer.writeByte(0)
}

