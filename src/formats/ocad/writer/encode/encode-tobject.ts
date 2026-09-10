import type BufferWriter from './buffer-writer.js'
import { writeCoord } from './encode-symbol-element.js'
import { TOBJECT_V12_HEADER, type FieldType } from '../../reader/decode/tobject-schema.js'

interface TObject12Like {
  sym: number
  otp: number
  unicode: boolean
  ang: number
  col: number
  lineWidth: number
  diamFlags: number
  serverObjectId: number
  height: number
  creationDate: number
  multirepresentationId: number
  modificationDate: number
  nItem: number
  nText: number
  nObjectString: number
  nDatabaseString: number
  objectStringType: number
  res1: number
  coordinates: Array<
    | [number, number]
    | { xFlags?: number; yFlags?: number; 0?: number; 1?: number }
  >
  text?: string
  objectString?: string
  databaseString?: string
}

/**
 * Encode a v12 / v2018 TObject record. The header is fixed-size; coords
 * follow at 8 bytes each; text/objectString/databaseString come last as
 * UTF-16 wide strings.
 *
 * v12/v2018 always uses 16-bit unicode (`unicode === true`). Each wide
 * string occupies `nText * 2` bytes (etc), zero-padded.
 */
function writeField(writer: BufferWriter, type: FieldType, value: number | boolean): void {
  const n = typeof value === 'boolean' ? (value ? 1 : 0) : value
  switch (type) {
    case 'i32': return writer.writeInteger(n)
    case 'u32': return writer.writeCardinal(n >>> 0)
    case 'i16': return writer.writeSmallInt(n)
    case 'u16': return writer.writeWord(n)
    case 'i8':  return writer.writeByte(n)
    case 'f64': return writer.writeDouble(n)
  }
}

export function writeTObject12(
  writer: BufferWriter,
  object: TObject12Like
): void {
  for (const [name, type] of TOBJECT_V12_HEADER) {
    writeField(writer, type, (object as unknown as Record<string, number | boolean>)[name])
  }

  for (let i = 0; i < object.nItem; i++) {
    writeCoord(writer, object.coordinates[i])
  }

  writeWideString(writer, object.text ?? '', object.nText)
  writeWideString(writer, object.objectString ?? '', object.nObjectString)
  writeWideString(writer, object.databaseString ?? '', object.nDatabaseString)
}

/**
 * Write a UTF-16LE wide string. v12/v2018 stores text as 2-byte code
 * units regardless of the `unicode` flag; the on-disk byte length is
 * `(value.length + 1) * 2` (string + null terminator word) when there
 * is text to write, or 0 bytes when both `value` and the declared
 * `declaredCount` are empty.
 *
 * Note: the `nText` / `nObjectString` / `nDatabaseString` header field
 * is NOT an on-disk byte count — it's a capacity/allocation hint set
 * per-symbol. The reader's loop breaks at the first null, so the actual
 * stored size is determined by the string content, not the count.
 */
function writeWideString(
  writer: BufferWriter,
  value: string,
  declaredCount: number
): void {
  if (!value.length && declaredCount === 0) return
  for (let i = 0; i < value.length; i++) {
    writer.writeWord(value.charCodeAt(i))
  }
  writer.writeWord(0) // null terminator word
}
