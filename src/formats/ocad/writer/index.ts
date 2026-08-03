import { Buffer } from 'node:buffer'
import BufferWriter from './buffer-writer.js'
import {
  HEADER_SIZE,
  writeHeader,
  reserveHeader,
} from './encode-header.js'
import {
  writeSymbolRecords,
  writeSymbolIndexBlocks,
} from './encode-symbols.js'
import {
  writeObjectRecords,
  writeObjectIndexBlocks,
} from './encode-objects.js'
import {
  writeParameterStringRecords,
  writeStringIndexBlocks,
} from './encode-strings.js'
import type OcadFile from '../internal/ocad-file.js'

/**
 * Encode an OcadFile back to bytes.
 *
 * Currently targets OCAD versions 12 and 2018 (`header.version` of 12 or
 * 2018). The layout is reconstructed from scratch — header is rewritten
 * with fresh index-block offsets, and symbol/object/string records are
 * emitted from their captured raw byte ranges. Records added in memory
 * without a `_byteRange` are skipped pending field-level encoders.
 *
 * Layout:
 *
 *   [header 60 bytes]
 *   [symbol records ...]            ← offsets recorded
 *   [symbol index blocks ...]       ← header.symbolIndexBlock points here
 *   [object records ...]            ← offsets recorded
 *   [object index blocks ...]       ← header.objectIndexBlock points here
 *   [parameter string records ...]
 *   [string index blocks ...]       ← header.stringIndexBlock points here
 */
export function encodeOcadFile(ocadFile: OcadFile): Buffer {
  // `buffer` is only used by the byte-passthrough fast path in each
  // record writer; when it's missing (synthesized OcadFile), every
  // record falls back to its field-level encoder and this stub is
  // never actually read.
  const source = ocadFile.buffer ?? Buffer.alloc(0)
  // Reader stores the version tag verbatim; both v12 and v2018 files
  // write `header.version === 12` bytes (see `FileHeader.createFor`),
  // and 2018 shows up in the model only when the reader observed a
  // v2018 build tag. Accept both.
  const supported = new Set([12, 2018])
  if (!supported.has(ocadFile.header.version)) {
    throw new Error(
      `OCAD writer currently only supports versions 12 and 2018 (got ${ocadFile.header.version}).`
    )
  }

  const writer = new BufferWriter(Math.max(source.length, 4096) + 4096)

  reserveHeader(writer)

  const symbolOffsets = writeSymbolRecords(writer, ocadFile.symbols, source)
  const symbolIndexBlock = writeSymbolIndexBlocks(writer, symbolOffsets)

  const objects = ocadFile.objects as unknown as Parameters<
    typeof writeObjectRecords
  >[1]
  const objectResult = writeObjectRecords(writer, objects, source)
  const objectIndexBlock = writeObjectIndexBlocks(
    writer,
    objects,
    objectResult.offsets,
    objectResult.lengths,
    source
  )

  const stringResult = writeParameterStringRecords(
    writer,
    ocadFile.rawParameterStrings,
    source
  )
  const stringIndexBlock = writeStringIndexBlocks(
    writer,
    ocadFile.rawParameterStrings,
    stringResult.offsets,
    stringResult.lengths
  )

  // Now lay down the header at offset 0 by writing into a fresh writer
  // and copying — simpler than patching individual cardinals.
  const headerWriter = new BufferWriter(HEADER_SIZE)
  writeHeader(headerWriter, ocadFile.header, {
    symbolIndexBlock,
    objectIndexBlock,
    stringIndexBlock,
  })
  const headerBytes = headerWriter.toBuffer()
  const finalBuf = writer.toBuffer()
  headerBytes.copy(finalBuf, 0, 0, HEADER_SIZE)
  return finalBuf
}
