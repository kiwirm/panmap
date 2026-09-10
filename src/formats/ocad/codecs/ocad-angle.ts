/**
 * OCAD object/pattern angle — read/write inverse pair.
 *
 * OCAD stores an angle as `ang`, an integer in tenths of a degree. The reader
 * converts it to the canonical radians; the writer rounds radians back to the
 * integer tenths. That round-trip is lossy (0.1° resolution), so an OMap-
 * sourced copy of the same object (OMap keeps full float precision) only
 * canonicalises identically once it has passed through this quantisation.
 */

/** OCAD tenths-of-a-degree → canonical radians. */
export function ocadAngleToRadians(ang: number | undefined): number {
  return ang ? (ang / 1800) * Math.PI : 0
}

/** Canonical radians → OCAD tenths-of-a-degree (integer). */
export function radiansToOcadAngle(radians: number | undefined): number {
  return Math.round(((radians ?? 0) * 1800) / Math.PI)
}
