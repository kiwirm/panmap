/**
 * OCAD text-symbol field encodings — read/write inverse pairs.
 *
 * Co-locates both directions of the two OCAD text-symbol details the reader
 * (to-map) and writer (synthesize/symbol-bodies/text) each used to implement
 * half of, cross-referencing each other in comments to stay in sync:
 *
 *   alignment — OCAD packs horizontal in bits 0-1, vertical in bits 2-3 of one
 *               byte.
 *   font size — OCAD stores tenths of a point; canonical stores millimetres
 *               (1 pt = 25.4/72 mm, so raw = mm × 720 / 25.4).
 */
export interface OcadTextAlign {
  horizontal: number
  vertical: number
}

/** Split OCAD's packed alignment byte into horizontal + vertical (each 0-3). */
export function unpackOcadTextAlign(alignment: number): OcadTextAlign {
  return {
    horizontal: alignment & 0x03,
    vertical: (alignment >> 2) & 0x03,
  }
}

/** Pack horizontal + vertical alignment (each 0-3) into OCAD's alignment byte. */
export function packOcadTextAlign(
  horizontal: number,
  vertical: number,
): number {
  return (horizontal & 0x03) | ((vertical & 0x03) << 2)
}

/** OCAD tenths-of-a-point font size → canonical millimetres. */
export function ocadFontSizeToMm(raw: number): number {
  return (raw * 25.4) / 720
}

/** Canonical millimetres → OCAD tenths-of-a-point font size (integer). */
export function mmToOcadFontSize(mm: number): number {
  return Math.round((mm * 720) / 25.4)
}
