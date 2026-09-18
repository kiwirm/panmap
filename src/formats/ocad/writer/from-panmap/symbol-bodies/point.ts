import type { MapSymbol, RenderLayer } from '../../../../../panmap/model.js'
import {
  XFLAG_FIRST_BEZIER,
  XFLAG_SECOND_BEZIER,
  YFLAG_DASH_POINT,
} from '../../../../../panmap/coord.js'
import {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} from '../../../native/symbol-element-types.js'
import type {
  ColorNumber,
  OcadAnchor,
  OcadElement,
  XmapAreaSymbolLike,
  XmapCoordInput,
  XmapElementInput,
  XmapLineSymbolLike,
  XmapPointSymbolLike,
} from './shared.js'
import { normUnits } from './shared.js'

export function pointBody(
  symbol: MapSymbol,
  colorNumber: ColorNumber,
  flipY: boolean,
) {
  return { elements: pointElementsFor(symbol.layers ?? [], colorNumber, flipY) }
}

/**
 * Translate Panmap point render-layers into OCAD point-symbol
 * elements. Element types come from `symbol-element-types.ts`:
 *   1 Line, 2 Area, 3 Circle, 4 Dot.
 *
 * `diameter` and `lineWidth` are in OCAD's 0.01 mm units (same as
 * Panmap). Point elements always position themselves relative to
 * the symbol origin (0, 0), so we don't emit real coords for
 * fill/stroke primitives — just a single `(0, 0)` anchor.
 */
export function pointElementsFor(
  layers: RenderLayer[],
  colorNumber: ColorNumber,
  flipY: boolean,
): unknown[] {
  const out: unknown[] = []
  for (const layer of layers) {
    switch (layer.type) {
      case 'point-fill': {
        const r = Number(layer.radius)
        if (!(r > 0)) break
        const cid = layer.colorId
        if (typeof cid === 'number' && cid < 0) break
        // Round AFTER multiplying so a half-integer model radius (e.g.
        // xmap inner_radius=375 → model 37.5) lands on the correct
        // whole-integer OCD diameter (75, not 76 = round(37.5)*2).
        out.push(dotElement(colorNumber(cid), normUnits(r * 2)))
        break
      }
      case 'point-stroke': {
        const r = Number(layer.radius)
        const w = Number(layer.width)
        if (!(r > 0) || !(w > 0)) break
        const cid = layer.colorId
        if (typeof cid === 'number' && cid < 0) break
        // OCAD Circle `diameter` is the OUTER diameter (2*radius +
        // lineWidth). Emitting 2*radius produced a ring one stroke-width
        // too small — e.g. Prominent large tree (417): xmap
        // inner_radius=350 + outer_width=250 should encode as diameter=95,
        // not 70. Matches Mapper's own xmap→ocd conversion.
        out.push(circleElement(colorNumber(cid), normUnits(r * 2 + w), normUnits(w)))
        break
      }
      case 'point-elements': {
        const elements = layer.elements ?? []
        for (const el of elements) {
          // OCAD-sourced elements already have the target shape
          // (`type` as a numeric OCAD element code, `numberCoords`,
          // etc.). Xmap-sourced elements carry a nested
          // `symbol.{point,line,area}Symbol` shape and need the
          // xmap→OCAD translation. Elements coming out of gitmap are
          // OCD-shape too but their `color` field is a string colorId
          // (e.g. "color_brown_100_line_symbols_16") — translate to
          // OCD's numeric slot via `colorNumber` so the OCD file
          // encodes the correct palette slot instead of defaulting
          // to slot 0 (black).
          if (isOcadShapedElement(el)) {
            out.push(normaliseOcadElementColor(el, colorNumber))
          } else out.push(...pointElementFromXmap(el, colorNumber, flipY))
        }
        break
      }
    }
  }
  return out
}

/** OCD-shape elements from gitmap carry `color` as a string colorId
 *  (e.g. "color_brown_100_line_symbols_16"). Rewrite to the OCD palette
 *  slot number so the file encodes the intended color instead of
 *  defaulting to slot 0 (black). Pass through OCAD-sourced numeric
 *  colors unchanged. */
function normaliseOcadElementColor(
  el: unknown,
  colorNumber: ColorNumber,
): OcadElement {
  const e = el as { color?: unknown }
  const c = e.color
  if (typeof c === 'number') return el as OcadElement
  return { ...(el as object), color: colorNumber(c) } as OcadElement
}

export function dotElement(color: number, diameter: number): OcadElement {
  return {
    type: DotElementType,
    flags: 0,
    color: Math.max(0, color),
    lineWidth: 0,
    diameter,
    numberCoords: 1,
    coords: [{ 0: 0, 1: 0, xFlags: 0, yFlags: 0 }],
  }
}

export function circleElement(
  color: number,
  diameter: number,
  lineWidth: number,
): OcadElement {
  return {
    type: CircleElementType,
    flags: 0,
    color: Math.max(0, color),
    lineWidth,
    diameter,
    numberCoords: 1,
    coords: [{ 0: 0, 1: 0, xFlags: 0, yFlags: 0 }],
  }
}

/**
 * Best-effort translation of a nested xmap point element into OCAD
 * elements. xmap element shape:
 *   { symbol: { type, pointSymbol?, lineSymbol?, areaSymbol? }, coords[] }
 */
function isOcadShapedElement(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const r = el as Record<string, unknown>
  return (
    typeof r.type === 'number' &&
    (r.numberCoords !== undefined || 'lineWidth' in r || 'diameter' in r)
  )
}

export function pointElementFromXmap(
  el: unknown,
  colorNumber: ColorNumber,
  flipY: boolean,
): OcadElement[] {
  if (!el || typeof el !== 'object') return []
  const e = el as XmapElementInput
  const symbol = e.symbol
  if (!symbol) return []
  const coords = translateXmapCoords(e.object?.coords ?? [], flipY)

  if (symbol.pointSymbol) {
    const anchor = coords[0] ?? { 0: 0, 1: 0, xFlags: 0, yFlags: 0 }
    return pointSymbolToElements(symbol.pointSymbol, anchor, colorNumber, flipY)
  }
  if (symbol.lineSymbol && coords.length >= 2) {
    return [lineSymbolToElement(symbol.lineSymbol, coords, colorNumber)]
  }
  if (symbol.areaSymbol && coords.length >= 3) {
    return [areaSymbolToElement(symbol.areaSymbol, coords, colorNumber)]
  }
  return []
}

/**
 * Translate xmap-shape coords (`{x, y, flags}` objects or `[x, y]`
 * tuples) into the OCAD anchor shape used by icon elements.
 * See `formats/omap/codecs/omap-flags.ts:normaliseOmapFlags` — this mirrors that mapping
 * for main-body coords.
 */
export function translateXmapCoords(
  rawCoords: XmapCoordInput[],
  flipY: boolean,
): OcadAnchor[] {
  const yScale = flipY ? -1 : 1
  const readFlags = (c: XmapCoordInput | undefined): number =>
    c && !Array.isArray(c) ? Number(c.flags ?? 0) : 0
  return rawCoords.map((c, i) => {
    let xFlags = 0
    let yFlags = 0
    if (readFlags(rawCoords[i - 1]) & 0x01) xFlags |= XFLAG_FIRST_BEZIER
    if (readFlags(rawCoords[i - 2]) & 0x01) xFlags |= XFLAG_SECOND_BEZIER
    if (readFlags(c) & 0x02) yFlags |= YFLAG_DASH_POINT
    const x = Array.isArray(c) ? c[0] : (c.x ?? 0)
    const y = Array.isArray(c) ? c[1] : (c.y ?? 0)
    // Round to nearest integer rather than truncating (`| 0`) — Mapper
    // rounds half-integer element coords (xmap x=166 → 16.6) to the
    // nearest OCD integer (17), so truncation shifts every rounded
    // coord one unit toward zero on knolls/depressions etc.
    return {
      0: Math.round(Number(x)),
      1: Math.round(Number(y) * yScale),
      xFlags,
      yFlags,
    }
  })
}

export function pointSymbolToElements(
  ps: XmapPointSymbolLike,
  anchor: OcadAnchor,
  colorNumber: ColorNumber,
  flipY: boolean,
): OcadElement[] {
  const out: OcadElement[] = []
  const innerRaw = Number(ps.innerRadius) || 0
  const inner = normUnits(ps.innerRadius)
  const innerSlot = colorNumber(ps.innerColor)
  if (inner > 0 && innerSlot > 0) {
    out.push({
      type: DotElementType,
      flags: 0,
      color: innerSlot,
      lineWidth: 0,
      diameter: normUnits(innerRaw * 2),
      numberCoords: 1,
      coords: [anchor],
    })
  }
  const outer = normUnits(ps.outerWidth)
  const outerSlot = colorNumber(ps.outerColor)
  if (outer > 0 && outerSlot > 0) {
    // Diameter is the OUTER diameter: 2*innerRadius + outerWidth. Keep
    // the raw units on both sides of the addition before running through
    // `normUnits` once — the previous form mixed raw and already-divided
    // values (`innerRaw*2 + outer` where `outer = normUnits(outerWidth)`)
    // and rounded off by ~1 at every scale.
    out.push({
      type: CircleElementType,
      flags: 0,
      color: outerSlot,
      lineWidth: outer,
      diameter: normUnits(innerRaw * 2 + Number(ps.outerWidth)),
      numberCoords: 1,
      coords: [anchor],
    })
  }
  for (const sub of ps.elements ?? []) {
    out.push(...pointElementFromXmap(sub, colorNumber, flipY))
  }
  return out
}

export function lineSymbolToElement(
  ls: XmapLineSymbolLike,
  coords: OcadAnchor[],
  colorNumber: ColorNumber,
): OcadElement {
  let flags = 0
  if (ls.capStyle === 1) flags |= 0x01
  if (ls.joinStyle === 1) flags |= 0x04
  return {
    type: LineElementType,
    flags,
    color: Math.max(0, colorNumber(ls.color)),
    lineWidth: normUnits(ls.lineWidth),
    diameter: 0,
    numberCoords: coords.length,
    coords,
  }
}

export function areaSymbolToElement(
  as: XmapAreaSymbolLike,
  coords: OcadAnchor[],
  colorNumber: ColorNumber,
): OcadElement {
  return {
    type: AreaElementType,
    flags: 0,
    color: Math.max(0, colorNumber(as.innerColor)),
    lineWidth: 0,
    diameter: 0,
    numberCoords: coords.length,
    coords,
  }
}
