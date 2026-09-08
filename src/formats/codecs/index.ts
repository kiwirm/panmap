/**
 * Format ↔ canonical conversion codecs.
 *
 * Each module here co-locates BOTH directions of one format-representation
 * detail (encode = canonical→format, decode = format→canonical) so the pair
 * can't drift out of sync — the class of bug where a writer applies a transform
 * that no reader undoes (or vice-versa). Add a new detail as its own file.
 *
 *   y-axis       — vertical-axis orientation per format (single source of truth)
 *   ocad-coord   — OCAD 32-bit packed ordinate ↔ value + flag byte
 *   ocad-angle   — OCAD tenths-of-degree ↔ radians (+ canonical 0.1° snap)
 *   hole-flags   — hole-ring flag position (last-of-prev ↔ first-of-new)
 *   omap-flags   — OMap flag byte ↔ canonical xFlags/yFlags
 *   text-box     — OCAD 5-coord text box ↔ canonical anchor
 */
export { needsYFlip, yAxisOf, type YAxis } from './y-axis.js'
export {
  OCAD_COORD_FLAG_BITS,
  packOcadOrdinate,
  unpackOcadValue,
  unpackOcadFlags,
} from './ocad-coord.js'
export {
  ocadAngleToRadians,
  radiansToOcadAngle,
  snapRotationToOcadGrid,
} from './ocad-angle.js'
export { shiftHoleFlagsToOcad, shiftHoleFlagsFromOcad } from './hole-flags.js'
export { normaliseOmapFlags, coordinatesForOmap } from './omap-flags.js'
export { canonicalTextAnchor, expandTextBoxCoords, type OcadTextBoxCoord } from './text-box.js'
