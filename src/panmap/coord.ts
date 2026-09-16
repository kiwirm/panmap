/**
 * Shared helpers for coordinate arrays. Coordinates in the Panmap model
 * are `[x, y]` tuples that may carry any of these optional flags:
 *
 *   - `xFlags` / `yFlags` — raw OCAD bit fields (see td-poly.ts).
 *   - `flags`             — OMap / XMap bit fields.
 *   - `omapFlags`         — explicit alias for OMap flags when both sources
 *                           needed distinguishing.
 *
 * `TdPoly` (an Array subclass) already provides bit-checking methods; this
 * module lets exporters use the same predicates on plain-object coords.
 */

export interface FlaggedCoord {
  [index: number]: number
  length: number
  isFirstBezier?: () => boolean
  isSecondBezier?: () => boolean
  isFirstHolePoint?: () => boolean
  xFlags?: number
  yFlags?: number
  flags?: number
  omapFlags?: number
  angle?: number
}

/**
 * Object-shaped coord — the alternative to `FlaggedCoord`'s array
 * shape. XMap and gitmap readers produce this form; OCAD readers
 * produce TdPoly (array-shaped). Union `Coord` covers both.
 */
export interface ObjectCoord {
  x: number
  y: number
  xFlags?: number
  yFlags?: number
  flags?: number
  omapFlags?: number
}

/**
 * Canonical coordinate: either an array-shaped tuple (TdPoly,
 * `[x, y]` with flag properties) or an object with x/y fields.
 * `MapObject.coordinates` is `Coord[]`.
 */
export type Coord = FlaggedCoord | ObjectCoord

/** Return the x component of any-shape coord, or 0. */
export function coordX(c: Coord | undefined): number {
  if (!c) return 0
  if (Array.isArray(c)) return Number(c[0] ?? 0)
  return Number((c as ObjectCoord).x ?? 0)
}

/** Return the y component of any-shape coord, or 0. */
export function coordY(c: Coord | undefined): number {
  if (!c) return 0
  if (Array.isArray(c)) return Number(c[1] ?? 0)
  return Number((c as ObjectCoord).y ?? 0)
}

/** Return the XMap-native `flags` byte (0 if absent). */
export function coordFlags(c: Coord | undefined): number {
  if (!c) return 0
  return Number((c as { flags?: number }).flags ?? 0)
}

/**
 * Named bit values for `xFlags` / `yFlags`, mirroring `TdPoly`'s
 * predicate methods. Exporters that write raw bit patterns (xmap
 * write, ocad synth) should use these rather than hex literals so
 * the bit-to-meaning map lives in one place.
 */
export const XFLAG_FIRST_BEZIER = 0x01
export const XFLAG_SECOND_BEZIER = 0x02
export const XFLAG_NO_LEFT_LINE = 0x04
export const XFLAG_BORDER_OR_VIRTUAL_LINE = 0x08

export const YFLAG_CORNER = 0x01
export const YFLAG_FIRST_HOLE_POINT = 0x02
export const YFLAG_NO_RIGHT_LINE = 0x04
export const YFLAG_DASH_POINT = 0x08

export function isFirstBezier(coord: FlaggedCoord): boolean {
  return !!(
    coord &&
    ((coord.isFirstBezier && coord.isFirstBezier()) ||
      (coord.xFlags ?? 0) & XFLAG_FIRST_BEZIER)
  )
}

export function isSecondBezier(coord: FlaggedCoord): boolean {
  return !!(
    coord &&
    ((coord.isSecondBezier && coord.isSecondBezier()) ||
      (coord.xFlags ?? 0) & XFLAG_SECOND_BEZIER)
  )
}

export function isFirstHolePoint(coord: FlaggedCoord): boolean {
  return !!(
    coord &&
    ((coord.isFirstHolePoint && coord.isFirstHolePoint()) ||
      (coord.yFlags ?? 0) & YFLAG_FIRST_HOLE_POINT)
  )
}

/** Partition a coord list into groups, starting a NEW group at each hole
 *  point (split-before). Shared by the GeoJSON ring builder and the SVG
 *  line-offset splitter. Note: diff-runs' toRings uses the opposite
 *  (split-after) convention and does NOT use this. */
export function splitRingsAtHolePoints<T>(coords: readonly T[]): T[][] {
  const rings: T[][] = [[]]
  for (const c of coords) {
    const last = rings[rings.length - 1]
    if (last.length && isFirstHolePoint(c as FlaggedCoord)) rings.push([])
    rings[rings.length - 1].push(c)
  }
  return rings
}

// The OMap↔canonical flag-byte translation (`normaliseOmapFlags` decode +
// `coordinatesForOmap` encode) lives together in ../formats/codecs/omap-flags.ts.

export interface Bounds {
  min: [number, number]
  max: [number, number]
}

/**
 * Compute bounding box of a coordinate array; returns null for empty input.
 *
 * Accepts array-shaped coords (`[x, y]`, e.g. TdPoly) and object-shaped
 * coords (`{x, y}`). For objects, array-index access (`c[0]`/`c[1]`) is used
 * as the fallback so OCAD's `{0, 1, xFlags, yFlags}` coord objects resolve
 * too. Non-finite components are skipped; the array-shaped path is unchanged.
 */
export function boundsForCoords(
  coordinates: readonly unknown[],
): Bounds | null {
  if (!coordinates || !coordinates.length) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const c of coordinates) {
    const o = c as { x?: number; y?: number } & ArrayLike<number>
    const x = Number(Array.isArray(c) ? c[0] : (o.x ?? o[0]))
    const y = Number(Array.isArray(c) ? c[1] : (o.y ?? o[1]))
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return null
  return { min: [minX, minY], max: [maxX, maxY] }
}

/** Line-symbol render-layer keys that hold arrays of nested symbol elements. */
export const LINE_ELEMENT_LAYER_KEYS = [
  'primSymElements',
  'secSymElements',
  'cornerSymElements',
  'startSymElements',
  'endSymElements',
] as const

export type LineElementLayerKey = (typeof LINE_ELEMENT_LAYER_KEYS)[number]
