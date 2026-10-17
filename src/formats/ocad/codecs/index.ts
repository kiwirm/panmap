/**
 * OCAD ↔ canonical conversion codecs.
 *
 * Each module co-locates BOTH directions of one OCAD-representation detail
 * (encode = canonical→OCAD, decode = OCAD→canonical) so the pair can't drift
 * out of sync — the class of bug where a writer applies a transform no reader
 * undoes. Add a new detail as its own file.
 *
 *   ocad-coord     — OCAD 32-bit packed ordinate ↔ value + flag byte
 *   ocad-angle     — OCAD tenths-of-a-degree ↔ radians
 *   hole-flags     — hole-ring flag position (last-of-prev ↔ first-of-new)
 *   text-box       — OCAD 5-coord text box ↔ canonical anchor
 *   text-symbol    — text align byte ↔ enum, font size ↔ mm
 *   element-flags  — OCAD point-symbol element `flags` byte ↔ cap/join style
 */
export {
  packOcadOrdinate,
  unpackOcadValue,
  unpackOcadFlags,
} from './ocad-coord.js'
export { ocadAngleToRadians, radiansToOcadAngle } from './ocad-angle.js'
export { shiftHoleFlagsToOcad, shiftHoleFlagsFromOcad } from './hole-flags.js'
export {
  canonicalTextAnchor,
  expandTextBoxCoords,
  type OcadTextBoxCoord,
} from './text-box.js'
export {
  unpackOcadTextAlign,
  packOcadTextAlign,
  ocadFontSizeToMm,
  mmToOcadFontSize,
} from './text-symbol.js'
export {
  decodeOcadElementFlags,
  encodeOcadElementFlags,
  type CapJoin,
} from './element-flags.js'
