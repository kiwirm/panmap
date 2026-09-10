import PointSymbol from './point-symbol.js'
import LineSymbol from './line-symbol.js'
import AreaSymbol from './area-symbol.js'
import TextSymbol from './text-symbol.js'
import {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
  RectangleSymbolType,
  LineTextSymbolType,
} from '../../native/symbol-types.js'
import type BufferReader from './buffer-reader.js'
import type BaseSymbol from './symbol.js'
import type { ReadOcadOptions } from './index.js'

type SymbolConstructor = new (reader: BufferReader, version: number) => BaseSymbol

const symbolByType: Record<number, SymbolConstructor | undefined> = {
  [PointSymbolType]: PointSymbol,
  [LineSymbolType]: LineSymbol,
  [AreaSymbolType]: AreaSymbol,
  [TextSymbolType]: TextSymbol,
}

const ignoredTypes: Record<number, string | undefined> = {
  [LineTextSymbolType]: 'line text symbol',
  [RectangleSymbolType]: 'rectangle symbol',
}

export default class SymbolIndexBlock {
  version: number
  nextSymbolIndexBlock: number
  symbolPosition: number[]
  warnings: string[] = []
  options: ReadOcadOptions

  constructor(
    reader: BufferReader,
    version: number,
    options: ReadOcadOptions = {}
  ) {
    this.version = version
    this.options = options
    this.nextSymbolIndexBlock = reader.readInteger()
    this.symbolPosition = new Array(256)
    for (let i = 0; i < 256; i++) {
      this.symbolPosition[i] = reader.readInteger()
    }
  }

  parseSymbols(reader: BufferReader): BaseSymbol[] {
    const out: BaseSymbol[] = []
    for (const sp of this.symbolPosition) {
      if (sp <= 0) continue
      const symbol = this.parseSymbol(reader, sp)
      if (symbol) out.push(symbol)
    }
    return out
  }

  private parseSymbol(reader: BufferReader, offset: number): BaseSymbol | null {
    reader.push(offset)
    try {
      const type = reader.buffer.readInt8(offset + 8)
      const ignored = ignoredTypes[type]
      if (ignored) {
        const symNum = reader.buffer.readInt32LE(offset + 4)
        this.warnings.push(`Ignoring ${ignored} ${symNum}.`)
        return null
      }

      const Cls = symbolByType[type]
      if (!Cls) throw new Error(`Unknown symbol type ${type}`)

      reader.push(offset)
      const symbol = new Cls(reader, this.version)
      const tailStart = reader.offset
      reader.pop()
      this.warnings.push(...symbol.warnings.map(w => String(w)))

      // Record the original byte range so the writer can byte-preserve
      // unmodified symbol records. `size` is the on-disk record size from
      // the BaseSymbol header.
      if (typeof symbol.size === 'number' && symbol.size > 0) {
        const end = offset + symbol.size
        symbol._byteRange = { start: offset, end }
        if (tailStart < end) {
          symbol._tail = reader.buffer.subarray(tailStart, end)
        }
      }
      return symbol
    } catch (e) {
      if (this.options.failOnWarning) throw e
      this.warnings.push(String(e))
      return null
    } finally {
      reader.pop()
    }
  }
}
