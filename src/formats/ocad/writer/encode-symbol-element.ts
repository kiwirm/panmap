import type BufferWriter from './buffer-writer.js'
import { packOcadOrdinate } from '../../codecs/index.js'

/**
 * On-disk OCAD symbol-element record. Shared by the writer (this file
 * consumes it), the synth path (`synthesize-symbols.ts` builds it),
 * and the reader (`to-map.ts` translates it into PanMap render
 * layers). Element `type` is one of `LineElementType` /
 * `AreaElementType` / `CircleElementType` / `DotElementType`
 * (see `../internal/symbol-element-types.ts`).
 */
export interface OcadElement {
  type: number
  flags: number
  color: number
  lineWidth: number
  diameter: number
  numberCoords: number
  coords: Array<
    [number, number]
    | { xFlags?: number; yFlags?: number; 0?: number; 1?: number }
  >
}

/** @deprecated use `OcadElement`. Preserved for existing importers. */
export type SymbolElementLike = OcadElement

/**
 * Inverse of `SymbolElement` reader: 16-byte header (type/flags/color/
 * lineWidth/diameter/numberCoords + 4 reserved bytes) followed by
 * numberCoords coord pairs (each = 2 Integers packed with low-byte flags).
 *
 * Returns the number of 16-bit words written (header = 8 words + 4*nCoords).
 * Callers use this to compute the symbol's `dataSize` field.
 */
export function writeSymbolElement(
  writer: BufferWriter,
  element: OcadElement
): number {
  writer.writeSmallInt(element.type)
  writer.writeWord(element.flags)
  writer.writeSmallInt(element.color)
  writer.writeSmallInt(element.lineWidth)
  writer.writeSmallInt(element.diameter)
  writer.writeSmallInt(element.numberCoords)
  writer.writeCardinal(0) // Reserved

  for (let i = 0; i < element.numberCoords; i++) {
    writeCoord(writer, element.coords[i])
  }

  // `dataSize` in OCAD symbol records uses an idiosyncratic unit: the
  // reader iterates with `i += 2; i += numberCoords` per element, so each
  // element contributes (2 + numberCoords) units regardless of the
  // 16+8*nCoords bytes it actually occupies on disk. Matching the
  // reader's convention is what makes round-trip work.
  return 2 + element.numberCoords
}

/**
 * Any shape a caller might hand us for a coordinate: TdPoly (array with
 * xFlags/yFlags), plain [x, y], {x, y}, or an object with numeric-indexed
 * fields. Normalized via `toOcadCoord`.
 */
export type OcadCoordInput =
  | [number, number]
  | ArrayLike<number>
  | { x?: number; y?: number; 0?: number; 1?: number; xFlags?: number; yFlags?: number }

/** Canonical OCAD coord: raw x/y in map units plus per-axis flag bytes. */
export interface OcadCoord {
  x: number
  y: number
  xFlags: number
  yFlags: number
}

export function toOcadCoord(coord: OcadCoordInput): OcadCoord {
  const arr = coord as ArrayLike<number>
  const obj = coord as { x?: number; y?: number; xFlags?: number; yFlags?: number }
  const hasIndex0 = (coord as { 0?: number })[0] !== undefined
  return {
    x: hasIndex0 || Array.isArray(coord) ? arr[0] : (obj.x ?? 0),
    y: hasIndex0 || Array.isArray(coord) ? arr[1] : (obj.y ?? 0),
    xFlags: (obj.xFlags ?? 0) & 0xff,
    yFlags: (obj.yFlags ?? 0) & 0xff,
  }
}

/** Encode a coord in any accepted input shape. */
export function writeCoord(writer: BufferWriter, coord: OcadCoordInput): void {
  const { x, y, xFlags, yFlags } = toOcadCoord(coord)
  // Pack value + flag byte back into OCAD's 32-bit ordinate (inverse of the
  // reader's unpack). JS bit ops are 32-bit so this wraps to the original int32.
  writer.writeInteger(packOcadOrdinate(x, xFlags))
  writer.writeInteger(packOcadOrdinate(y, yFlags))
}
