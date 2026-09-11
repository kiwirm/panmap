import type BufferWriter from './buffer-writer.js'
import type FileHeader from '../../native/file-header.js'

export const HEADER_SIZE = 60

export interface HeaderOffsets {
  symbolIndexBlock: number
  objectIndexBlock: number
  stringIndexBlock: number
  fileNamePos?: number
  fileNameSize?: number
  mrStartBlockPosition?: number
}

/**
 * Writes a 60-byte OCAD file header. The header references the first
 * symbol/object/string index block; everything else is copied from the
 * source header on the OcadFile.
 */
export function writeHeader(
  writer: BufferWriter,
  header: FileHeader,
  offsets: HeaderOffsets,
): void {
  writer.writeSmallInt(header.ocadMark) // 0x0CAD
  writer.writeByte(header.fileType)
  writer.writeByte(0) // FileStatus (unused)
  writer.writeSmallInt(header.version)
  writer.writeByte(header.subVersion)
  writer.writeByte(header.subSubVersion)
  writer.writeCardinal(offsets.symbolIndexBlock)
  writer.writeCardinal(offsets.objectIndexBlock)
  writer.writeInteger(header.offlineSyncSerial)
  writer.writeInteger(header.currentFileVersion)
  writer.writeCardinal(0) // Internal 1
  writer.writeCardinal(0) // Internal 2
  writer.writeCardinal(offsets.stringIndexBlock)
  writer.writeCardinal(offsets.fileNamePos ?? header.fileNamePos ?? 0)
  writer.writeCardinal(offsets.fileNameSize ?? header.fileNameSize ?? 0)
  writer.writeCardinal(0) // Internal 3
  writer.writeCardinal(0) // Res1
  writer.writeCardinal(0) // Res2
  writer.writeCardinal(
    offsets.mrStartBlockPosition ?? header.mrStartBlockPosition ?? 0,
  )
}

/** Reserve 60 bytes for the header so it can be patched in at the end. */
export function reserveHeader(writer: BufferWriter): void {
  writer.writeZeros(HEADER_SIZE)
}
