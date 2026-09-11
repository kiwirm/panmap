import type BufferWriter from './buffer-writer.js'
import { writeSymbol } from './encode-symbol.js'

const BLOCK_ENTRIES = 256

export interface SymbolRecord {
  size: number
}

/**
 * Writes symbol records back-to-back at the current offset, each via the
 * field-level encoder (symbols are always synthesized from Panmap fields).
 *
 * Returns the file offset of each emitted symbol record, in input order.
 * Records that fail to encode get an offset of 0.
 */
export function writeSymbolRecords(
  writer: BufferWriter,
  symbols: SymbolRecord[],
): number[] {
  const offsets: number[] = new Array(symbols.length)
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]
    if (!symbol) {
      offsets[i] = 0
      continue
    }
    offsets[i] = writer.offset
    writeSymbol(writer, symbol as Parameters<typeof writeSymbol>[1])
  }
  return offsets
}

/**
 * Writes a chain of symbol-index blocks (256 pointers each, 1028 bytes
 * per block). Returns the offset of the first block, or 0 if the
 * `symbolOffsets` array is empty.
 */
export function writeSymbolIndexBlocks(
  writer: BufferWriter,
  symbolOffsets: number[],
): number {
  if (!symbolOffsets.length) return 0

  // Reserve block storage in one contiguous run so we can patch
  // nextBlock pointers as we go.
  const filledOffsets = symbolOffsets.filter(o => o > 0)
  const blockCount = Math.max(
    1,
    Math.ceil(filledOffsets.length / BLOCK_ENTRIES),
  )
  const blockOffsets: number[] = []
  for (let b = 0; b < blockCount; b++) {
    blockOffsets.push(writer.offset)
    writer.writeInteger(0) // nextSymbolIndexBlock (patched below)
    for (let i = 0; i < BLOCK_ENTRIES; i++) {
      const flatIndex = b * BLOCK_ENTRIES + i
      writer.writeInteger(filledOffsets[flatIndex] ?? 0)
    }
  }
  // Patch next-pointers.
  for (let b = 0; b < blockCount - 1; b++) {
    writer.patchInteger(blockOffsets[b], blockOffsets[b + 1])
  }
  return blockOffsets[0]
}

export const SYMBOL_INDEX_BLOCK_SIZE = 4 + BLOCK_ENTRIES * 4
