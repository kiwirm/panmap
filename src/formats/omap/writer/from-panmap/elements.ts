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
  options: {
    // Enables Mapper's single-dot / single-circle "inline into outer
    // point_symbol" canonicalisation (see `tryInlineSingleDotCircle`).
    // Callers that will discard the wrapper and only consume its
    // `.pointSymbol.elements` (e.g. top-level point-symbol builders)
    // must leave this OFF — inlining folds the sole child up into the
    // wrapper, which then has no `.elements` for those callers to pull.
    // Line-decoration builders (mid/start/end/dashSymbol on a
    // line_symbol) DO want inlining — Mapper writes cliff/bank/etc.
    // tag decorations as an inline dot without a nested <element>.
    inlineSingleDot?: boolean
  } = {},
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
      // Also negate y on `object.coords`: the OMap reader canonicalises
      // element coords to y-UP (see `normalisePointElementsYUp` in
      // reader/flatten-line-decor.ts), but XMap XML stores element
      // coords y-DOWN. Mirror the reader's flip on the way out.
      converted.push({
        symbol: negateXmapPointElementYs(
          rewriteSymbolColors(el.symbol, colorIds),
        ),
        object: negateObjectCoordsY(el.object),
      })
    } else {
      const ocadEl = ocadElementToXmapElement(el, colorIds)
      if (ocadEl) converted.push(ocadEl)
    }
  }
  if (!converted.length) return undefined
  // Inline the single-dot / single-circle canonicalisation. Mapper writes
  // a mid_symbol / start_symbol / etc. containing exactly one dot as
  //   <symbol><point_symbol inner_radius="X" inner_color="Y" elements="0"/></symbol>
  // (the dot is folded directly into the outer point_symbol, no <element>
  // child). OCD-sourced maps arrive here with the same dot expressed as
  // a single OCD DOT element; wrapping it in the generic outer scaffold
  // would produce a nested `<point_symbol><element><symbol><point_symbol/>
  // </symbol></element></point_symbol>` — semantically equivalent but
  // NOT byte-parity with Mapper's authoring. Detect the "single flat
  // dot / circle" case and promote its fields onto the outer wrapper so
  // xmap→gitmap→xmap round-trips through mapwall land on Mapper's
  // canonical form.
  if (options.inlineSingleDot && converted.length === 1) {
    const inlined = tryInlineSingleDotCircle(converted[0])
    if (inlined) return inlined
  }
  // Line-decoration wrappers (mid_symbol / start_symbol / end_symbol /
  // dash_symbol on a line_symbol) always spin with the line direction in
  // Mapper's world — cliff tags are perpendicular to the cliff, arrowheads
  // face along the line, etc. Mapper stores `rotatable="true"` on every
  // such wrapper by convention, plus `inner_radius="1000"` as the rotation-
  // gizmo hint. Match to avoid drift and keep decorations pointing the
  // right way after ocd→xmap round-trip.
  return {
    id: -1,
    code: '',
    type: 1,
    pointSymbol: {
      innerColor: -1,
      innerRadius: 100,
      outerColor: -1,
      outerWidth: 0,
      rotatable: true,
      elements: converted,
    },
  }
}

/**
 * When the wrapper's single child is a bare dot / circle at the origin,
 * return the outer symbol with that dot's inner_radius / inner_color /
 * outer_width / outer_color folded in directly (no nested `<element>`).
 * Returns null when the child is anything else (a line, an area, an
 * off-origin dot, a compound point_symbol with its own children).
 */
function tryInlineSingleDotCircle(
  child: { symbol: OmapSymbol; object: OmapObject },
): OmapSymbol | null {
  const s = child.symbol
  const ps = s?.pointSymbol
  if (!ps) return null
  // A dot or circle emitted by `ocadElementToXmapElement` has just one
  // coord at the origin, no nested elements, and no line/area sibling
  // on the same symbol. Any deviation means this is a real compound
  // element that must stay wrapped.
  if (s.lineSymbol || s.areaSymbol || s.textSymbol || s.combinedSymbol) {
    return null
  }
  if (ps.elements && ps.elements.length > 0) return null
  const coords = child.object?.coords
  if (Array.isArray(coords) && coords.length > 0) {
    const c = coords[0] as { x?: number; y?: number } | number[]
    const x = Array.isArray(c) ? c[0] : (c?.x ?? 0)
    const y = Array.isArray(c) ? c[1] : (c?.y ?? 0)
    if (x !== 0 || y !== 0) return null
    if (coords.length !== 1) return null
  }
  return {
    id: -1,
    code: '',
    type: 1,
    pointSymbol: {
      innerColor: ps.innerColor ?? -1,
      innerRadius: ps.innerRadius ?? 0,
      outerColor: ps.outerColor ?? -1,
      outerWidth: ps.outerWidth ?? 0,
      // Mapper always sets rotatable=true on line-decoration wrappers,
      // which is what our caller is emitting; preserve.
      rotatable: true,
    } as OmapPointSymbol,
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
  // don't silently truncate coords on the ocd→xmap path. Flip Y: element
  // coords in the canonical model are y-UP (per gitmap serializer,
  // "Element coords are symbol-internal (y-up)"), and XMap XML stores
  // element coords y-DOWN. The OMap reader's flatten-line-decor.ts
  // applies the same flip on the way in, so the two flips cancel for a
  // clean xmap-xmap round-trip.
  // Derive the xmap flag byte when a coord carries canonical
  // `xFlags`/`yFlags` rather than a native xmap `flags` (gitmap- and
  // OCD-sourced elements do — `coordFlags` only reads the native byte, so
  // without this every icon vertex is written plain and curved point
  // symbols like 101.2/3/4 "Contour, minimum knoll" come out as
  // straight-edge polygons). Mapper marks a curve on the vertex BEFORE its
  // two control points, so a cp1 at i sets CurveStart on i-1 — the inverse
  // of `mapXmapCoordsToOcadElement` on the way in.
  const rawCoords = e.coords ?? []
  const derived = rawCoords.map(() => 0)
  rawCoords.forEach((c, i) => {
    const f = c as { xFlags?: number; yFlags?: number }
    if (Number(f.xFlags ?? 0) & 0x01 && i > 0) derived[i - 1] |= 0x01
    if (Number(f.yFlags ?? 0) & 0x01) derived[i] |= 0x20
  })
  // Mapper marks the duplicated closing vertex of a ring with ClosePoint
  // (0x02). OCAD has no twin — a ring is closed by the repeated coord
  // alone — so the canonical model drops the flag and it is re-derived
  // here: the path is closed when its last vertex repeats its first.
  // Without this a closed icon (101.2 / 101.4 minimum-knoll contour)
  // renders as an open curve.
  if (rawCoords.length > 2) {
    const first = rawCoords[0]
    const last = rawCoords[rawCoords.length - 1]
    if (coordX(first) === coordX(last) && coordY(first) === coordY(last)) {
      derived[rawCoords.length - 1] |= 0x02
    }
  }
  const coords = rawCoords.map((c, i) => ({
    x: coordX(c),
    y: -coordY(c),
    flags: coordFlags(c) || derived[i] || undefined,
  }))
  const c = colorRef(e.color, colorIds)
  // OCAD line-element `flags` byte packs cap+join style:
  //   bit 0 (0x01) = RoundCap, bit 2 (0x04) = MiterJoin
  // Decode so xmap emits cap_style/join_style and Mapper's re-export
  // reconstructs the same OCAD flags.
  const elFlags = e.flags ?? 0
  const elCap = elFlags & 0x01 ? 1 : 0
  const elJoin = elFlags & 0x04 ? 1 : 0

  if (e.type === 1) {
    // line
    return {
      symbol: {
        id: -1,
        code: '',
        type: 2,
        lineSymbol: {
          color: c,
          lineWidth: e.lineWidth ?? 0,
          minimumLength: 0,
          dashed: false,
          // Mapper's XMap unit is 1/100 mm; internal model units are 1/10 mm
          // (writer's `dim()` = value / MAP_UNIT_SCALE = value * 10).
          // Mapper writes 4000/1000/500/4000 as the built-in defaults for
          // dash geometry even on solid lines, so match — internal 400
          // → XML 4000 etc. Emitting 4/1/0.5/4 here left every nested
          // line element rendering at 1/100 of Mapper's intended dash
          // spacing (visible: contour minimum-knoll 101.2 lost its arc,
          // cliff 104 lost its intermediate tags).
          dashLength: 400,
          breakLength: 100,
          dashesInGroup: 1,
          inGroupBreakLength: 50,
          endLength: 0,
          segmentLength: 400,
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
        code: '',
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
        code: '',
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

export {
  ocadElementsToXmapPointSymbol,
  ocadElementToXmapElement,
  negateXmapPointElementYs,
}

/**
 * Mirror `normalisePointElementsYUp` from the OMap reader: negate `y`
 * on every `object.coords[i]` in a nested xmap-shape point-symbol
 * element tree. Called on the write path when passing xmap-shape
 * elements straight through — the reader stored them as y-UP (canonical)
 * so we flip back to y-DOWN for XMap's element XML convention.
 *
 * Returns a shallow-cloned symbol (child arrays are new; leaf primitives
 * are shared). We clone rather than mutate because `rewriteSymbolColors`
 * has already returned a wrapper that the caller may reuse elsewhere.
 */
function negateXmapPointElementYs(symbol: OmapSymbol): OmapSymbol {
  const ps = symbol?.pointSymbol
  if (!ps?.elements?.length) return symbol
  const clonedElements = ps.elements.map(child => {
    const c = child as { symbol?: OmapSymbol; object?: OmapObject }
    if (!c?.symbol || !c?.object) return child
    return {
      symbol: negateXmapPointElementYs(c.symbol),
      object: negateObjectCoordsY(c.object),
    }
  })
  return {
    ...symbol,
    pointSymbol: {
      ...ps,
      elements: clonedElements,
    },
  }
}

function negateObjectCoordsY(object: OmapObject): OmapObject {
  const coords = object?.coords as unknown[] | undefined
  if (!Array.isArray(coords) || coords.length === 0) return object
  const flipped = coords.map(c => {
    if (Array.isArray(c)) {
      const arr = [...c] as unknown[]
      if (typeof arr[1] === 'number') arr[1] = -(arr[1] as number)
      return arr
    }
    const co = c as { y?: number }
    return typeof co.y === 'number' ? { ...co, y: -co.y } : c
  })
  return {
    ...object,
    coords: flipped as OmapObject['coords'],
  }
}
