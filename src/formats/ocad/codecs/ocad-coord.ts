/**
 * OCAD on-disk coordinate packing — read/write inverse pair.
 *
 * OCAD stores each ordinate as one 32-bit little-endian int: the value (in
 * 1/100 mm units) in the high 24 bits, a flag byte in the low 8. The reader
 * splits it (`value = raw >> 8`, arithmetic shift preserves sign; `flags = raw
 * & 0xff`); the writer packs it back (`raw = (value << 8) | flags`). JS bit ops
 * are 32-bit so the writer naturally wraps to the original int32.
 *
 * Keep both directions here so a change to the packing can't be made to one
 * side without the other.
 */
export const OCAD_COORD_FLAG_BITS = 8

/** Value (high 24 bits) of a packed OCAD ordinate. */
export function unpackOcadValue(raw: number): number {
  return raw >> OCAD_COORD_FLAG_BITS
}

/** Flag byte (low 8 bits) of a packed OCAD ordinate. */
export function unpackOcadFlags(raw: number): number {
  return raw & 0xff
}

/** Pack a value + flag byte into OCAD's 32-bit ordinate. */
export function packOcadOrdinate(value: number, flags = 0): number {
  return (value << OCAD_COORD_FLAG_BITS) | (flags & 0xff)
}
