import type BufferWriter from './buffer-writer.js'
import { writeParameterString } from './encode-parameter-string.js'

const BLOCK_ENTRIES = 256
const STRING_INDEX_ENTRY_SIZE = 16
const STRING_INDEX_BLOCK_SIZE = 4 + BLOCK_ENTRIES * STRING_INDEX_ENTRY_SIZE

export interface RawParameterString {
  recType: number
  values?: {
    _first: string
    _pairs: Array<{ code: string; value: string | string[] }>
  }
  _indexRecord?: { pos: number; len: number; recType: number; objIndex: number }
}

/**
 * Writes parameter string records via the field-level encoder. A record
 * with no `values` is emitted as an empty slot.
 */
export function writeParameterStringRecords(
  writer: BufferWriter,
  strings: RawParameterString[],
): { offsets: number[]; lengths: number[] } {
  const offsets: number[] = []
  const lengths: number[] = []
  for (const ps of strings) {
    if (!ps || !ps.values) {
      offsets.push(0)
      lengths.push(0)
      continue
    }
    const start = writer.offset
    const len = writeParameterString(
      writer,
      ps as Parameters<typeof writeParameterString>[1],
    )
    offsets.push(start)
    lengths.push(len)
  }
  return { offsets, lengths }
}

export function writeStringIndexBlocks(
  writer: BufferWriter,
  strings: RawParameterString[],
  offsets: number[],
  lengths: number[],
): number {
  if (!strings.length) return 0

  const blockCount = Math.max(1, Math.ceil(strings.length / BLOCK_ENTRIES))
  const blockOffsets: number[] = []
  for (let b = 0; b < blockCount; b++) {
    blockOffsets.push(writer.offset)
    writer.writeInteger(0) // nextStringIndexBlock (patched below)
    for (let i = 0; i < BLOCK_ENTRIES; i++) {
      const flat = b * BLOCK_ENTRIES + i
      if (flat >= strings.length || !offsets[flat]) {
        writer.writeZeros(STRING_INDEX_ENTRY_SIZE)
        continue
      }
      writeStringIndexEntry(writer, offsets[flat], lengths[flat], strings[flat])
    }
  }

  for (let b = 0; b < blockCount - 1; b++) {
    writer.patchInteger(blockOffsets[b], blockOffsets[b + 1])
  }

  return blockOffsets[0]
}

function writeStringIndexEntry(
  writer: BufferWriter,
  pos: number,
  len: number,
  ps: RawParameterString,
): void {
  writer.writeInteger(pos)
  writer.writeInteger(len)
  writer.writeInteger(ps.recType | 0)
  writer.writeInteger(ps._indexRecord?.objIndex ?? 0)
}

export { STRING_INDEX_BLOCK_SIZE, STRING_INDEX_ENTRY_SIZE }
