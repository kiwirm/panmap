import { YFLAG_FIRST_HOLE_POINT } from '../../map/coord.js'

/**
 * Hole-flag position codec — a co-located inverse pair.
 *
 * The `0x02` hole-start bit marks a multi-ring area's ring boundary, but the
 * two sides disagree on which coord carries it:
 *   - Canonical / xmap / every consumer (SVG splitter, geojson, diff): the LAST
 *     coord of the *previous* ring.
 *   - OCAD on disk: the FIRST coord of the *new* (hole) ring — one later.
 *
 * So an OCAD write moves each hole flag one coord forward, and an OCAD read
 * moves it back. `test/hole-flags.test.js` asserts `fromOcad(toOcad(x)) === x`.
 *
 * The LAST coord is deliberately excluded from both: a `0x02` on the final coord
 * is a closed-line ClosePoint marker, not a hole boundary — the forward shift
 * (source index < length) never lands a real interior-hole flag there, and the
 * consumers already ignore it (`isFirstHolePoint(c) && i < length-1`). Moving it
 * would corrupt closed lines (measured: 220 on bottle-lake).
 */
export function shiftHoleFlagsToOcad<T extends { yFlags?: number }>(coords: T[]): T[] {
  // Walk high→low so a moved flag isn't re-moved: each interior hole flag at
  // k (k ≤ length-2) advances to k+1; a last-coord flag is only ever a target.
  for (let i = coords.length - 1; i > 0; i--) {
    const src = coords[i - 1]
    if (((src.yFlags ?? 0) & YFLAG_FIRST_HOLE_POINT) === 0) continue
    src.yFlags = (src.yFlags ?? 0) & ~YFLAG_FIRST_HOLE_POINT
    coords[i].yFlags = (coords[i].yFlags ?? 0) | YFLAG_FIRST_HOLE_POINT
  }
  return coords
}

export function shiftHoleFlagsFromOcad<T extends { yFlags?: number }>(coords: T[]): T[] {
  // Exact inverse: walk low→high (a moved flag lands on an already-passed
  // index, so it's never re-moved) and move each interior hole flag at j back
  // to j-1. Skip the final coord — see the ClosePoint note above.
  for (let i = 1; i < coords.length - 1; i++) {
    if (((coords[i].yFlags ?? 0) & YFLAG_FIRST_HOLE_POINT) === 0) continue
    coords[i].yFlags = (coords[i].yFlags ?? 0) & ~YFLAG_FIRST_HOLE_POINT
    coords[i - 1].yFlags = (coords[i - 1].yFlags ?? 0) | YFLAG_FIRST_HOLE_POINT
  }
  return coords
}
