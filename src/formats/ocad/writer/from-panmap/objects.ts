import type { MapObject, MapSymbol } from '../../../../panmap/model.js'
import {
  shiftHoleFlagsToOcad,
  radiansToOcadAngle,
  expandTextBoxCoords,
} from '../../codecs/index.js'
import { parseSymbolCode } from '../../../../panmap/symbol-code.js'
import { boundsForCoords } from '../../../../panmap/coord.js'
import { otpForType } from './object-type.js'

/**
 * Translate MapObject[] into the record + index-entry shape
 * the OCAD writer expects.
 *
 * Each output is one entry with:
 *   - the full TObject12 field set consumed by writeTObject12
 *   - an `objIndex` block for writeObjectIndexEntry
 *
 * The objects the writer consumes are effectively a merge of both —
 * `writeObjectRecords` reads TObject fields, `writeObjectIndexBlocks`
 * reads the `objIndex` sub-object.
 *
 * Coordinates for xmap-sourced maps come from `TdPoly` (already in
 * OCAD's `x >> 8` form with xFlags/yFlags in the low byte); gitmap
 * stores them the same way. `writeCoord` handles both flat tuples and
 * `{x,y,xFlags,yFlags}` shapes, so no coord translation is needed.
 */
export function synthesizeObjects(
  objects: MapObject[],
  symbols: MapSymbol[],
  symNums?: Map<MapSymbol['id'], number>,
): unknown[] {
  // Object coords are canonical y-down in the model (a93c61a); OCD stores
  // y-up. Always flip on write — no source-format branching.
  const flipY = true
  const symToOcadNum = buildSymNumLookup(symbols, symNums)
  const out: unknown[] = []
  for (const obj of objects) {
    if (obj.hidden) continue
    const ocadSym = symToOcadNum(obj.symbolId)
    if (ocadSym == null) continue
    const symbol = symbols.find(s => s.id === obj.symbolId)
    const otp = otpForObject(obj, symbol)
    let coords = normalizeCoords(obj.coordinates ?? [], flipY, symbol)
    // OCAD text objects (otp=4/5) expect 5 coords: the text anchor
    // followed by the four corners of a bounding box that Mapper
    // uses for click-hit + alignment. Canonical text objects only
    // carry the anchor, so synthesize a plausible box around it.
    // Without this, Mapper logs "Trying to import a text object with
    // unknown coordinate format" and drops the object.
    if (otp === 4 && coords.length === 1) {
      coords = expandTextBoxCoords(coords[0], obj.text ?? '')
    }
    const rc = boundsFor(coords)
    out.push({
      sym: ocadSym,
      otp,
      // OCAD's single object angle carries the fill-PATTERN rotation for areas
      // and the object rotation for points/text — write whichever this object
      // has (an area keeps rotation in `pattern`, a point in `rotation`), so the
      // pattern rotation isn't dropped on a gitmap→ocd write.
      ang: radiansToOcadAngle(obj.pattern?.rotation || obj.rotation),
      nItem: coords.length,
      nText: obj.text ? obj.text.length + 1 : 0,
      nObjectString: obj.tag ? obj.tag.length + 1 : 0,
      objectStringType: obj.tagType ?? 0,
      coordinates: coords,
      text: obj.text,
      objectString: obj.tag,
      unicode: false,
      col: 0,
      lineWidth: 0,
      diamFlags: 0,
      serverObjectId: 0,
      height: 0,
      creationDate: 0,
      multirepresentationId: 0,
      modificationDate: 0,
      nDatabaseString: 0,
      res1: 0,
      objIndex: {
        rc: { min: rc.min, max: rc.max },
        pos: 0,
        len: 0,
        sym: ocadSym,
        objType: otp,
        encryptedMode: 0,
        status: 1, // 1 = normal
        viewType: 0,
        // Real Mapper output uses `0` for objects that don't override
        // the symbol color; `-1` becomes 0xFFFF on-disk and triggers
        // Mapper's "color id not found: 65535" warning.
        color: 0,
        group: 0,
        impLayer: 0,
        dbDatasetHash: 0,
        dbKeyHash: 0,
        _index: 0,
      },
    })
  }
  return out
}

function buildSymNumLookup(
  symbols: MapSymbol[],
  symNums?: Map<MapSymbol['id'], number>,
): (id: unknown) => number | null {
  const byId = new Map<unknown, number>()
  for (const s of symbols) {
    const num =
      symNums?.get(s.id) ??
      parseSymbolCode(s.code || String(s.sourceId ?? s.id))
    byId.set(s.id, num)
    // Also key by sourceId so objects that carry raw ids
    // (e.g. numeric OCAD ids) resolve without a rename step.
    if (s.sourceId !== undefined) byId.set(s.sourceId, num)
  }
  return id => byId.get(id) ?? (typeof id === 'number' ? id : null)
}

/**
 * OCAD's `otp` field on TObject records: 1=point, 2=line, 3=area,
 * 4=unformatted text, 5=formatted text, 6=line-text, 7=rectangle.
 * We use type='text' → 4 which mapper accepts, avoiding the
 * text-box requirement of `otp=5`.
 */
function otpForObject(obj: MapObject, symbol?: MapSymbol): number {
  switch (obj.type) {
    case 'point':
      return 1
    case 'line':
      return 2
    case 'area':
      return 3
    case 'text':
      return 4
    default:
      return symbol ? otpForType(symbol.type) : 1
  }
}

interface FlatCoord {
  0: number
  1: number
  xFlags: number
  yFlags: number
}

/** Convert Panmap coord tuples into the {x,y,xFlags,yFlags} shape the
 *  writer's `writeCoord` uses. `flipY` negates y for non-OCAD sources
 *  (paper Y-down → OCAD Y-up).
 *
 *  Two coordinate conventions have to be bridged here:
 *   - Mapper / xmap convention: the "hole-point" flag sits on the LAST
 *     coord of the previous ring (or, equivalently, marks the point
 *     that closes a subpath).
 *   - OCAD on-disk convention: the hole flag sits on the FIRST coord
 *     of the new hole ring.
 *
 *  Mapper's own ocd_file_import.cpp says exactly this: "hole points
 *  need to be set as the last point of a part of an area object
 *  instead of the first point of the next part". Since we're going the
 *  other way (Panmap → OCAD), we shift the flag forward by one:
 *  coord[i] carrying the flag emits coord[i]-without-flag, and the
 *  flag is applied to coord[i+1] instead. Without this shift Mapper
 *  triangulates holes against the outer ring's edges and paints thin
 *  triangle streaks all over large areas. */
/**
 * Which OCAD byte a marked vertex gets. The canonical model has ONE
 * marked-vertex flag (`dash`, stored as yFlags 0x01) because Mapper has
 * only one — its OCD import folds both OCAD flags into `DashPoint`
 * (`ocd_file_import.cpp`: `if ((y & FlagDash) || (y & FlagCorner))
 * setDashPoint(true)`). Which of the two to write back is not stored but
 * DERIVED from the symbol, reproducing Mapper's own export rule
 * (`ocd_file_export.cpp`):
 *
 *     if (!symbol || symbol->getType() != Symbol::Line)   FlagCorner
 *     else if (dash_symbol empty && line->isDashed())     FlagDash
 *     else                                                FlagCorner
 *
 * So a dashed line with no corner symbol gets the dash byte; everything
 * else gets corner (which is also what places the corner symbol, e.g.
 * the 104 cliff/bank tags).
 */
function markedVertexFlag(symbol: MapSymbol | undefined): number {
  const YFLAG_CORNER = 0x01
  const YFLAG_DASH = 0x08
  if (!symbol || symbol.type !== 'line') return YFLAG_CORNER
  let dashed = false
  let hasCornerSymbol = false
  for (const layer of symbol.layers ?? []) {
    const l = layer as Record<string, unknown>
    if (l.dash) dashed = true
    const corner = l.cornerSymElements
    if (Array.isArray(corner) && corner.length > 0) hasCornerSymbol = true
  }
  return dashed && !hasCornerSymbol ? YFLAG_DASH : YFLAG_CORNER
}

function normalizeCoords(
  input: unknown[],
  flipY: boolean,
  symbol?: MapSymbol,
): FlatCoord[] {
  const s = flipY ? -1 : 1
  const markedFlag = markedVertexFlag(symbol)
  // Re-target the canonical marked-vertex bit (0x01) onto whichever byte
  // this symbol calls for, leaving the hole bit (0x02) untouched.
  const retarget = (yFlags: number): number =>
    yFlags & 0x01 ? (yFlags & ~0x01) | markedFlag : yFlags
  const raw: FlatCoord[] = []
  for (const c of input) {
    if (Array.isArray(c)) {
      const t = c as unknown as { xFlags?: number; yFlags?: number }
      raw.push({
        0: Number(c[0]) | 0,
        1: (Number(c[1]) * s) | 0,
        xFlags: (t.xFlags ?? 0) & 0xff,
        yFlags: retarget((t.yFlags ?? 0) & 0xff),
      })
    } else if (c && typeof c === 'object') {
      const o = c as {
        x?: number
        y?: number
        xFlags?: number
        yFlags?: number
      }
      raw.push({
        0: Number(o.x ?? 0) | 0,
        1: (Number(o.y ?? 0) * s) | 0,
        xFlags: (o.xFlags ?? 0) & 0xff,
        yFlags: retarget((o.yFlags ?? 0) & 0xff),
      })
    }
  }
  // Move each hole flag last-of-prev → first-of-new (OCAD's on-disk
  // convention). The exact inverse runs on read (`shiftHoleFlagsFromOcad`);
  // both live together in ../../codecs/hole-flags.ts.
  return shiftHoleFlagsToOcad(raw)
}

function boundsFor(coords: FlatCoord[]): {
  min: [number, number]
  max: [number, number]
} {
  // OCAD coords are always finite integers, so the finite-skip in
  // boundsForCoords is a no-op here. FlatCoord is `{0, 1, xFlags, yFlags}`,
  // resolved via boundsForCoords' array-index fallback.
  return boundsForCoords(coords) ?? { min: [0, 0], max: [0, 0] }
}
