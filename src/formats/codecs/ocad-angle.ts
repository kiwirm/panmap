/**
 * OCAD object/pattern angle — read/write inverse pair, plus the canonical snap.
 *
 * OCAD stores an angle as `ang`, an integer in tenths of a degree. The reader
 * converts it to the canonical radians; the writer rounds radians back to the
 * integer tenths. Because that round-trip is lossy (0.1° resolution),
 * `snapRotationToOcadGrid` applies exactly the same quantisation so an OCD- and
 * an OMap-sourced copy of the same object canonicalise to the identical angle
 * (OMap keeps full float precision, OCAD cannot).
 */

/** OCAD tenths-of-a-degree → canonical radians. */
export function ocadAngleToRadians(ang: number | undefined): number {
  return ang ? (ang / 1800) * Math.PI : 0
}

/** Canonical radians → OCAD tenths-of-a-degree (integer). */
export function radiansToOcadAngle(radians: number | undefined): number {
  return Math.round(((radians ?? 0) * 1800) / Math.PI)
}

/**
 * Snap a radian angle to OCAD's representable 0.1° grid (round-trip through the
 * integer tenths-of-degree form). Used to canonicalise rotation so the same
 * object serialises identically regardless of source format.
 */
export function snapRotationToOcadGrid(radians: unknown): number {
  const r = Number(radians)
  if (!r || !Number.isFinite(r)) return 0
  return ocadAngleToRadians(radiansToOcadAngle(r))
}
