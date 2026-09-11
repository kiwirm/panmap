/**
 * Element helpers: convert OCAD point-elements (and pass through
 * xmap-shaped nested elements) into the xmap `<point_symbol>` /
 * `<element>` record shapes used by point/line/area bodies.
 */
import type {
  OmapLineSymbol,
  OmapObject,
  OmapPointSymbol,
  OmapSymbol,
} from '../../native.js'
import { coordX, coordY, coordFlags } from '../../../../panmap/coord.js'
import type { Coord } from '../../../../panmap/coord.js'
import { colorRef, rewriteSymbolColors } from './colors.js'

/**
 * Turn a flat array of OCAD point-elements (from `primSymElements` /
 * `elements` / etc.) into an xmap-shaped `<point_symbol>` record. Each
 * OCAD element becomes one nested `<element>` block containing an inline
 * `<symbol>` describing the shape's line / area / point drawing and an
 * `<object>` carrying the coords.
 *
 * OCAD element types (`element.type`):
 *   1 = line      → object type=1 + line_symbol
 *   2 = area      → object type=1 + area_symbol
 *   3 = circle    → object type=0 + point_symbol with outer_color/outer_width (ring)
 *   4 = dot       → object type=0 + point_symbol with inner_color (filled)
 */
function ocadElementsToXmapPointSymbol(
  elements: unknown[],
  colorIds: Map<string | number, number>,
): OmapSymbol | undefined {
  if (!elements?.length) return undefined
  // Two element shapes reach here:
  //   • OCAD-shaped (from OCD reader): `{ type, color, coords, ... }`.
  //     Convert via `ocadElementToXmapElement`.
  //   • xmap-shaped (from XMap reader): `{ symbol, object }` already
  //     in xmap's nested form. Pass through untouched — otherwise the
  //     ocad-only conversion silently drops them (missing `type` field
  //     → returns null → elements collapses to empty).
  const isXmapShaped = (
    el: unknown,
  ): el is { symbol: OmapSymbol; object: OmapObject } =>
    !!el && typeof el === 'object' && 'symbol' in el && 'object' in el
  const converted: Array<{ symbol: OmapSymbol; object: OmapObject }> = []
  for (const el of elements) {
    if (isXmapShaped(el)) {
      // XMap-shaped nested elements came from gitmap where all colour
      // references were replaced with string ids (e.g.
      // `color_white_over_green_and_brown_17`). OMAP requires numeric
      // priorities. Rewrite the nested symbol's colours before
      // passthrough — otherwise Mapper renders these primitives in the
      // "unknown colour" fallback (bright pink/magenta).
      converted.push({
        symbol: rewriteSymbolColors(el.symbol, colorIds),
        object: el.object,
      })
    } else {
      const ocadEl = ocadElementToXmapElement(el, colorIds)
      if (ocadEl) converted.push(ocadEl)
    }
  }
  if (!converted.length) return undefined
  return {
    id: -1,
    type: 1,
    pointSymbol: {
      innerColor: -1,
      innerRadius: 0,
      outerColor: -1,
      outerWidth: 0,
      rotatable: false,
      elements: converted,
    },
  }
}

function ocadElementToXmapElement(
  el: unknown,
  colorIds: Map<string | number, number>,
): { symbol: OmapSymbol; object: OmapObject } | null {
  const e = el as {
    type?: number
    flags?: number
    color?: number
    lineWidth?: number
    diameter?: number
    coords?: Coord[]
  }
  if (!e || e.type === undefined) return null

  // Coordinates on OCAD point-elements arrive as TdPoly tuples ([x, y])
  // while xmap-native elements use { x, y } objects. Accept both so we
  // don't silently truncate coords on the ocd→xmap path. Also flip Y —
  // OCAD is Y-up, XMap is Y-down; synth-symbols un-flips on the way
  // back to OCD via `flipY = sourceFormat !== 'ocad'`.
  const coords = (e.coords ?? []).map(c => ({
    x: coordX(c),
    y: -coordY(c),
    flags: coordFlags(c) || undefined,
  }))
  const c = colorRef(e.color, colorIds)
  // OCAD line-element `flags` byte packs cap+join style:
  //   bit 0 (0x01) = RoundCap, bit 2 (0x04) = MiterJoin
  // Decode so xmap emits cap_style/join_style and Mapper's re-export
  // reconstructs the same OCAD flags. Contour slope lines (101/102/103)
  // ship with flags=4 (miter join) so this bit is a common one.
  const elFlags = e.flags ?? 0
  const elCap = elFlags & 0x01 ? 1 : 0
  const elJoin = elFlags & 0x04 ? 1 : 0

  if (e.type === 1) {
    // line
    return {
      symbol: {
        id: -1,
        type: 2,
        lineSymbol: {
          color: c,
          lineWidth: e.lineWidth ?? 0,
          minimumLength: 0,
          dashed: false,
          dashLength: 4,
          breakLength: 1,
          dashesInGroup: 1,
          inGroupBreakLength: 0.5,
          endLength: 0,
          segmentLength: 4,
          startOffset: 0,
          endOffset: 0,
          showAtLeastOneSymbol: true,
          midSymbolsPerSpot: 1,
          midSymbolDistance: 0,
          midSymbolPlacement: 0,
          minimumMidSymbolCount: 0,
          minimumMidSymbolCountWhenClosed: 0,
          suppressDashSymbolAtEnds: false,
          scaleDashSymbol: true,
          capStyle: elCap,
          joinStyle: elJoin,
        } as OmapLineSymbol,
      } as OmapSymbol,
      object: {
        type: 1,
        symbol: 0,
        coords,
        text: null,
        textBox: null,
      } as OmapObject,
    }
  }

  if (e.type === 2) {
    // area
    return {
      symbol: {
        id: -1,
        type: 4,
        areaSymbol: { innerColor: c, patterns: undefined },
      } as OmapSymbol,
      object: {
        type: 1,
        symbol: 0,
        coords,
        text: null,
        textBox: null,
      } as OmapObject,
    }
  }

  if (e.type === 3 || e.type === 4) {
    // circle (3) or dot (4)
    const filled = e.type === 4
    const dia = e.diameter ?? 0
    return {
      symbol: {
        id: -1,
        type: 1,
        pointSymbol: {
          innerColor: filled ? c : -1,
          innerRadius: filled
            ? dia / 2
            : Math.max(0, dia / 2 - (e.lineWidth ?? 0) / 2),
          outerColor: filled ? -1 : c,
          outerWidth: filled ? 0 : (e.lineWidth ?? 0),
          rotatable: false,
        } as OmapPointSymbol,
      } as OmapSymbol,
      object: {
        type: 0,
        symbol: 0,
        coords,
        text: null,
        textBox: null,
      } as OmapObject,
    }
  }

  return null
}

export { ocadElementsToXmapPointSymbol, ocadElementToXmapElement }
