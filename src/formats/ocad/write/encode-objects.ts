import type BufferWriter from './buffer-writer.js'
import type { ObjectIndex } from '../read/object-index.js'
import { writeTObject12 } from './encode-tobject.js'
import { packOcadOrdinate } from '../codecs/index.js'

const BLOCK_ENTRIES = 256
const OBJECT_INDEX_ENTRY_SIZE = 40
const OBJECT_INDEX_BLOCK_SIZE = 4 + BLOCK_ENTRIES * OBJECT_INDEX_ENTRY_SIZE

export interface ObjectRecord {
  objIndex: ObjectIndex
}

/**
 * Writes TObject records back-to-back via the v12/v2018 TObject encoder
 * (objects are always synthesized from PanMap fields).
 */
export function writeObjectRecords(
  writer: BufferWriter,
  objects: ObjectRecord[]
): { offsets: number[]; lengths: number[] } {
  const offsets: number[] = []
  const lengths: number[] = []
  for (const object of objects) {
    if (!object) {
      offsets.push(0)
      lengths.push(0)
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
 * Writes a chain of object index blocks. Each entry is field-encoded from
 * the object's ObjectIndex (bounds, symbol, position, length, flags).
 *
 * Returns the offset of the first block, or 0 if no objects were emitted.
 */
export function writeObjectIndexBlocks(
  writer: BufferWriter,
  objects: ObjectRecord[],
  offsets: number[],
  lengths: number[]
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
        lengths[flat]
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
  len: number
): void {
  // Field-level encode. Layout matches the reader in object-index.ts:
  //   [rc.min.x i32][rc.min.y i32][rc.max.x i32][rc.max.y i32]
  //   [pos i32][len i32][sym i32][objType i8][encryptedMode i8]
  //   [status i8][viewType i8][color i16][group i16][impLayer i16]
  //   [dbDatasetHash i8][dbKeyHash i8] = 40 bytes total.
  // Bounds are OcdPoint32: same packing as coordinates (`(value << 8) | flags`,
  // flags 0). The reader unshifts (see td-poly.ts) so the panmap-side value we
  // hold here is in unshifted units — pack on write. Without this, Condes reads
  // the bounds as 256× smaller than the objects and renders a blank canvas.
  const rc = objIndex.rc
  const min = (rc?.min ?? { 0: 0, 1: 0 }) as unknown as [number, number]
  const max = (rc?.max ?? { 0: 0, 1: 0 }) as unknown as [number, number]
  writer.writeInteger(packOcadOrdinate(Number(min[0]) | 0))
  writer.writeInteger(packOcadOrdinate(Number(min[1]) | 0))
  writer.writeInteger(packOcadOrdinate(Number(max[0]) | 0))
  writer.writeInteger(packOcadOrdinate(Number(max[1]) | 0))
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
