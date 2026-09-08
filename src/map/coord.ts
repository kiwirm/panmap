/**
 * Shared helpers for coordinate arrays. Coordinates in the PanMap model
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
  [index: number]: number;
  length: number;
  isFirstBezier?: () => boolean;
  isSecondBezier?: () => boolean;
  isFirstHolePoint?: () => boolean;
  xFlags?: number;
  yFlags?: number;
  flags?: number;
  omapFlags?: number;
  angle?: number;
}

/**
 * Object-shaped coord — the alternative to `FlaggedCoord`'s array
 * shape. XMap and gitmap readers produce this form; OCAD readers
 * produce TdPoly (array-shaped). Union `Coord` covers both.
 */
export interface ObjectCoord {
  x: number;
  y: number;
  xFlags?: number;
  yFlags?: number;
  flags?: number;
  omapFlags?: number;
}

/**
 * Canonical coordinate: either an array-shaped tuple (TdPoly,
 * `[x, y]` with flag properties) or an object with x/y fields.
 * `MapObject.coordinates` is `Coord[]`.
 */
export type Coord = FlaggedCoord | ObjectCoord;

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
    ((coord.isFirstBezier && coord.isFirstBezier()) || ((coord.xFlags ?? 0) & XFLAG_FIRST_BEZIER))
  );
}

export function isSecondBezier(coord: FlaggedCoord): boolean {
  return !!(
    coord &&
    ((coord.isSecondBezier && coord.isSecondBezier()) || ((coord.xFlags ?? 0) & XFLAG_SECOND_BEZIER))
  );
}

export function isFirstHolePoint(coord: FlaggedCoord): boolean {
  return !!(
    coord &&
    ((coord.isFirstHolePoint && coord.isFirstHolePoint()) || ((coord.yFlags ?? 0) & YFLAG_FIRST_HOLE_POINT))
  );
}

// The OMap↔canonical flag-byte translation (`normaliseOmapFlags` decode +
// `coordinatesForOmap` encode) lives together in ../formats/codecs/omap-flags.ts.

export interface Bounds {
  min: [number, number];
  max: [number, number];
}

/** Compute bounding box of a coordinate array; returns null for empty input. */
export function boundsForCoords(
  coordinates: ReadonlyArray<ArrayLike<number>>,
): Bounds | null {
  if (!coordinates || !coordinates.length) return null;
  let minX = Number.POSITIVE_INFINITY; let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY; let maxY = Number.NEGATIVE_INFINITY;
  for (const c of coordinates) {
    const x = Number(c[0]);
    const y = Number(c[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { min: [minX, minY], max: [maxX, maxY] };
}

/** Line-symbol render-layer keys that hold arrays of nested symbol elements. */
export const LINE_ELEMENT_LAYER_KEYS = [
  "primSymElements",
  "secSymElements",
  "cornerSymElements",
  "startSymElements",
  "endSymElements",
] as const;

export type LineElementLayerKey = (typeof LINE_ELEMENT_LAYER_KEYS)[number];
