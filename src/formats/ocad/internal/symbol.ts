import SymbolElement from './symbol-element.js'
import { InvalidSymbolElementError } from './errors.js'
import type BufferReader from './buffer-reader.js'

export interface SymbolHeader {
  size: number
  symNum: number
  number: string
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
}

export interface SymbolCommonBody {
  nColors: number
  colors: number[]
  description: string
  iconBits: number[]
}

export interface Symbol10Extras {
  group: number
}

export interface Symbol11Extras {
  /** UTF-16 description as raw words (32 of them = 64 bytes). Captured for round-trip. */
  descriptionWords: number[]
  /** 64-word symbol-tree-group block (v11+). */
  symbolTreeGroup: number[]
  /** 64 reserved/unparsed bytes following symbolTreeGroup (v11+). */
  mystery64: Uint8Array
}

/**
 * Properties carried on every parsed Symbol regardless of OCAD version.
 *
 * v10 symbols additionally carry `group` (a single small int).
 * v11+ symbols carry `descriptionWords`, `symbolTreeGroup`, and `mystery64`.
 * Per-type fields live on the concrete subclasses.
 */
export type BaseSymbolProps = SymbolHeader &
  SymbolCommonBody &
  Partial<Symbol10Extras & Symbol11Extras> & {
    warnings: Error[]
    isHidden(): boolean
  }

export type BaseSymbolDef = BaseSymbolProps & Record<string, unknown>

/**
 * Base class for all OCAD symbol records. Per-type subclasses implement
 * their body in the constructor after calling `readHeader` and the version's
 * common-body reader.
 */
export default abstract class BaseSymbol implements BaseSymbolProps {
  abstract type: number
  warnings: Error[] = []
  size!: number
  symNum!: number
  number!: string
  otp!: number
  flags!: number
  selected!: boolean
  status!: number
  preferredDrawingTool!: number
  csMode!: number
  csObjType!: number
  csCdFlags!: number
  extent!: number
  filePos!: number

  nColors!: number
  colors!: number[]
  description!: string
  iconBits!: number[]

  group?: number
  descriptionWords?: number[]
  symbolTreeGroup?: number[]
  mystery64?: Uint8Array

  _byteRange?: { start: number; end: number }
  _tail?: Uint8Array

  protected readHeader(reader: BufferReader): void {
    this.size = reader.readInteger()
    this.symNum = reader.readInteger()
    this.number = `${Math.floor(this.symNum / 1000)}.${this.symNum % 1000}`
    this.otp = reader.readByte()
    this.flags = reader.readByte()
    this.selected = !!reader.readByte()
    this.status = reader.readByte()
    this.preferredDrawingTool = reader.readByte()
    this.csMode = reader.readByte()
    this.csObjType = reader.readByte()
    this.csCdFlags = reader.readByte()
    this.extent = reader.readInteger()
    this.filePos = reader.readCardinal()
  }

  protected readCommonBody(reader: BufferReader, version: number): void {
    if (version === 10) readBody10(this, reader)
    else readBody11(this, reader)
  }

  protected readElements(
    reader: BufferReader,
    dataSize: number
  ): SymbolElement[] {
    const elements: SymbolElement[] = []
    for (let i = 0; i < dataSize; i += 2) {
      try {
        reader.push(reader.offset)
        const element = new SymbolElement(reader)
        elements.push(element)
        i += element.numberCoords
      } catch (e) {
        if (e instanceof InvalidSymbolElementError) {
          this.warnings.push(e)
        } else {
          throw e
        }
      } finally {
        const size = reader.getSize()
        reader.pop()
        reader.skip(size)
      }
    }
    return elements
  }

  isHidden(): boolean {
    return (this.status & 0x02) === 2
  }
}

function readBody10(symbol: BaseSymbol, reader: BufferReader): void {
  symbol.group = reader.readSmallInt()
  symbol.nColors = reader.readSmallInt()
  symbol.colors = new Array(14)
  for (let i = 0; i < 14; i++) symbol.colors[i] = reader.readSmallInt()

  // Pascal-style description: 1 length byte + 31 chars.
  let description = ''
  reader.readByte() // length, not used (we read all 31 chars)
  for (let i = 1; i < 32; i++) {
    const c = reader.readByte()
    if (c) description += String.fromCharCode(c)
  }
  symbol.description = description

  symbol.iconBits = new Array(484)
  for (let i = 0; i < 484; i++) symbol.iconBits[i] = reader.readByte()
}

function readBody11(symbol: BaseSymbol, reader: BufferReader): void {
  reader.readByte() // notUsed1
  reader.readByte() // notUsed2
  symbol.nColors = reader.readSmallInt()
  symbol.colors = new Array(14)
  for (let i = 0; i < 14; i++) symbol.colors[i] = reader.readSmallInt()

  // UTF-16 description: 64 words (128 bytes). Matches Mapper's
  // `Utf16PascalString<64>` — earlier versions of this reader
  // treated the field as 32 words and reappropriated the second
  // half as an unnamed "mystery64" block. That happened to preserve
  // byte layout in an OCAD → OCAD round-trip, but broke Mapper's
  // description display for from-scratch symbols because we only
  // wrote 32 words, letting the second 32 leak in as garbage.
  symbol.descriptionWords = new Array(64)
  for (let i = 0; i < 64; i++) symbol.descriptionWords[i] = reader.readWord()
  const terminator = symbol.descriptionWords.indexOf(0)
  const codes =
    terminator === -1
      ? symbol.descriptionWords
      : symbol.descriptionWords.slice(0, terminator)
  symbol.description = String.fromCharCode(...codes)

  symbol.iconBits = new Array(484)
  for (let i = 0; i < 484; i++) symbol.iconBits[i] = reader.readByte()

  symbol.symbolTreeGroup = new Array(64)
  for (let i = 0; i < 64; i++) symbol.symbolTreeGroup[i] = reader.readWord()

  // No trailing mystery bytes — the old 64-byte "mystery64" was
  // actually the second half of the description field.
  symbol.mystery64 = new Uint8Array(0)
}
