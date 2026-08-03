import { Buffer } from 'node:buffer'
import type BufferWriter from './buffer-writer.js'
import type { ObjectIndex } from '../internal/object-index.js'
import { writeTObject12 } from './encode-tobject.js'

const BLOCK_ENTRIES = 256
const OBJECT_INDEX_ENTRY_SIZE = 40
const OBJECT_INDEX_BLOCK_SIZE = 4 + BLOCK_ENTRIES * OBJECT_INDEX_ENTRY_SIZE

export interface ObjectWithRange {
  objIndex: ObjectIndex
  _byteRange?: { start: number; end: number }
}

/**
 * Writes TObject records back-to-back. Each record uses its captured
 * byte slice when present (byte-exact passthrough); otherwise the
 * v12/v2018 TObject encoder is invoked.
 */
export function writeObjectRecords(
  writer: BufferWriter,
  objects: ObjectWithRange[],
  sourceBuffer: Buffer
): { offsets: number[]; lengths: number[] } {
  const offsets: number[] = []
  const lengths: number[] = []
  for (const object of objects) {
    if (!object) {
      offsets.push(0)
      lengths.push(0)
      continue
    }
    if (object._byteRange) {
      const { start, end } = object._byteRange
      offsets.push(writer.offset)
      lengths.push(end - start)
      writer.writeBytes(sourceBuffer.subarray(start, end))
      continue
    }
    const start = writer.offset
    writeTObject12(
      writer,
      object as unknown as Parameters<typeof writeTObject12>[1]
    )
    offsets.push(start)
    lengths.push(writer.offset - start)
  }
  return { offsets, lengths }
}

/**
 * Writes a chain of object index blocks. For each object whose original
 * index-entry bytes are captured (via `objIndex._entryByteRange`), the
 * entry is copied verbatim and only `pos` (offset +16) and `len`
 * (offset +20) are overwritten to point at the new record location.
 *
 * Returns the offset of the first block, or 0 if no objects were emitted.
 */
export function writeObjectIndexBlocks(
  writer: BufferWriter,
  objects: ObjectWithRange[],
  offsets: number[],
  lengths: number[],
  sourceBuffer: Buffer
): number {
  if (!objects.length) return 0

  const blockCount = Math.max(1, Math.ceil(objects.length / BLOCK_ENTRIES))
  const blockOffsets: number[] = []
  for (let b = 0; b < blockCount; b++) {
    blockOffsets.push(writer.offset)
    writer.writeInteger(0) // nextObjectIndexBlock (patched below)
    for (let i = 0; i < BLOCK_ENTRIES; i++) {
      const flat = b * BLOCK_ENTRIES + i
      if (flat >= objects.length || !offsets[flat]) {
        writer.writeZeros(OBJECT_INDEX_ENTRY_SIZE)
        continue
      }
      writeObjectIndexEntry(
        writer,
        objects[flat].objIndex,
        offsets[flat],
        lengths[flat],
        sourceBuffer
      )
    }
  }

  for (let b = 0; b < blockCount - 1; b++) {
    writer.patchInteger(blockOffsets[b], blockOffsets[b + 1])
  }

  return blockOffsets[0]
}

function writeObjectIndexEntry(
  writer: BufferWriter,
  objIndex: ObjectIndex,
  pos: number,
  len: number,
  sourceBuffer: Buffer
): void {
  if (objIndex._entryByteRange) {
    const { start, end } = objIndex._entryByteRange
    const entry = Buffer.from(sourceBuffer.subarray(start, end))
    entry.writeInt32LE(pos, 16)
    entry.writeInt32LE(len, 20)
    writer.writeBytes(entry)
    return
  }
  // Field-level encode for synthesized objects. Layout matches the
  // reader in object-index.ts:
  //   [rc.min.x i32][rc.min.y i32][rc.max.x i32][rc.max.y i32]
  //   [pos i32][len i32][sym i32][objType i8][encryptedMode i8]
  //   [status i8][viewType i8][color i16][group i16][impLayer i16]
  //   [dbDatasetHash i8][dbKeyHash i8] = 40 bytes total.
  const rc = objIndex.rc
  const min = (rc?.min ?? { 0: 0, 1: 0 }) as unknown as [number, number]
  const max = (rc?.max ?? { 0: 0, 1: 0 }) as unknown as [number, number]
  writer.writeInteger(Number(min[0]) | 0)
  writer.writeInteger(Number(min[1]) | 0)
  writer.writeInteger(Number(max[0]) | 0)
  writer.writeInteger(Number(max[1]) | 0)
  writer.writeInteger(pos | 0)
  writer.writeInteger(len | 0)
  writer.writeInteger(objIndex.sym | 0)
  writer.writeByte(objIndex.objType & 0xff)
  writer.writeByte(objIndex.encryptedMode & 0xff)
  writer.writeByte(objIndex.status & 0xff)
  writer.writeByte(objIndex.viewType & 0xff)
  writer.writeSmallInt(objIndex.color | 0)
  writer.writeSmallInt(objIndex.group | 0)
  writer.writeSmallInt(objIndex.impLayer | 0)
  writer.writeByte(objIndex.dbDatasetHash & 0xff)
  writer.writeByte(objIndex.dbKeyHash & 0xff)
}

export { OBJECT_INDEX_BLOCK_SIZE, OBJECT_INDEX_ENTRY_SIZE }
