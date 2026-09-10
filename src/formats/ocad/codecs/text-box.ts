/**
 * OCAD single-anchor text ↔ canonical anchor — a (lossy) inverse pair.
 *
 * OCAD stores a point-anchored label as 5 coords: the anchor followed by 4 box
 * corners (clockwise). The box is derived from font metrics and is re-snapped by
 * Mapper on open, so it carries no canonical geometry — OMap (and Mapper's own
 * importer, `fillTextPathCoords`) keep only the anchor. `canonicalTextAnchor`
 * reduces on read; `expandTextBoxCoords` re-synthesises the box on write. The
 * pair is lossy (the box is regenerated, not preserved) by design.
 */

export interface OcadTextBoxCoord {
  0: number
  1: number
  xFlags: number
  yFlags: number
}

/**
 * Reduce OCAD's 5-coord single-anchor text to just the anchor. Non-anchor
 * shapes (a 4-coord box text, or an already-reduced anchor) are left untouched.
 */
export function canonicalTextAnchor<T>(coords: T[]): T[] {
  return coords.length === 5 ? coords.slice(0, 1) : coords
}

/**
 * Build a 5-coord text bounding box for an OCAD `otp=4` text object: anchor,
 * then four corners going anchor → below-left → below-right → above-right →
 * above-left. Sizes are approximated from the string length and a nominal line
 * height in map units (1 unit = 0.01 mm); real OCAD stores exact font metrics,
 * but for a from-scratch write we don't have them and Mapper snaps the box on
 * re-open anyway.
 */
export function expandTextBoxCoords(
  anchor: OcadTextBoxCoord,
  text: string
): OcadTextBoxCoord[] {
  const CHAR_WIDTH = 60 // ~0.6 mm per char at 5-6 pt — matches sample "Lima Rd" (378 / ~7 chars ≈ 54)
  const LINE_HEIGHT = 128 // ~1.3 mm, matching the sample rectangles
  const width = Math.max(CHAR_WIDTH, text.length * CHAR_WIDTH)
  const anchorX = anchor[0]
  const anchorY = anchor[1]
  // Anchor sits on the box's left edge; box extends right for `width` and up/
  // down around the anchor's baseline. In OCAD's Y-up world "below" is smaller y.
  const belowY = anchorY - Math.round(LINE_HEIGHT * 0.15)
  const aboveY = anchorY + Math.round(LINE_HEIGHT * 0.85)
  const rightX = anchorX + width
  const mk = (x: number, y: number): OcadTextBoxCoord => ({ 0: x, 1: y, xFlags: 0, yFlags: 0 })
  return [anchor, mk(anchorX, belowY), mk(rightX, belowY), mk(rightX, aboveY), mk(anchorX, aboveY)]
}
