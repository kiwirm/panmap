import { Buffer } from 'node:buffer'
import type BufferWriter from './buffer-writer.js'

interface ParameterStringLike {
  values: {
    _first: string
    _pairs: Array<{ code: string; value: string | string[] }>
  }
}

/**
 * Encode a parameter string record: `<first>\t<code1><value1>\t...` then
 * a single null terminator byte. UTF-8 encoded.
 *
 * If `paddedLength` is provided, additional null bytes are appended so
 * the on-disk record matches the original index record's `len`. OCAD
 * records have trailing padding for stable in-place edits — preserving
 * it lets unmodified records round-trip byte-exactly.
 *
 * Returns the on-disk length actually written (>= string + 1).
 */
export function writeParameterString(
  writer: BufferWriter,
  ps: ParameterStringLike & { _indexRecord?: { len: number } },
  paddedLength?: number
): number {
  const start = writer.offset
  const parts: string[] = [ps.values._first || '']
  for (const pair of ps.values._pairs || []) {
    const values = Array.isArray(pair.value) ? pair.value : [pair.value]
    for (const v of values) {
      parts.push(pair.code + (v ?? ''))
    }
  }
  const encoded = Buffer.from(parts.join('\t'), 'utf-8')
  writer.writeBytes(encoded)
  writer.writeByte(0)
  const targetLen = paddedLength ?? ps._indexRecord?.len
  if (typeof targetLen === 'number' && targetLen > writer.offset - start) {
    writer.writeZeros(targetLen - (writer.offset - start))
  }
  return writer.offset - start
}
