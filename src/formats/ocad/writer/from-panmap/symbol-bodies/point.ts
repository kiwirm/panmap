import type { MapSymbol, RenderLayer } from '../../../../../map/model.js'
import {
  XFLAG_FIRST_BEZIER, XFLAG_SECOND_BEZIER, YFLAG_DASH_POINT,
} from '../../../../../map/coord.js'
import {
  LineElementType, AreaElementType,
  CircleElementType, DotElementType,
} from '../../../native/symbol-element-types.js'
import type {
  ColorNumber, OcadAnchor, OcadElement,
  XmapAreaSymbolLike, XmapCoordInput, XmapElementInput,
  XmapLineSymbolLike, XmapPointSymbolLike,
} from './shared.js'
import { normUnits } from './shared.js'

export function pointBody(
  symbol: MapSymbol,
  colorNumber: ColorNumber,
  flipY: boolean,
) {
  return { elements: pointElementsFor(symbol.renderLayers ?? [], colorNumber, flipY) }
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
        const radius = normUnits(layer.radius)
        if (radius <= 0) break
        const cid = layer.colorId
        if (typeof cid === 'number' && cid < 0) break
        out.push(dotElement(colorNumber(cid), radius * 2))
        break
      }
      case 'point-stroke': {
        const radius = normUnits(layer.radius)
        const width = normUnits(layer.width)
        if (radius <= 0 || width <= 0) break
        const cid = layer.colorId
        if (typeof cid === 'number' && cid < 0) break
        out.push(circleElement(colorNumber(cid), radius * 2, width))
        break
      }
      case 'point-elements': {
        const elements = layer.elements ?? []
        for (const el of elements) {
          // OCAD-sourced elements already have the target shape
          // (`type` as a numeric OCAD element code, `numberCoords`,
          // etc.); pass them through unchanged. Xmap-sourced elements
          // carry a nested `symbol.{point,line,area}Symbol` shape and
          // need the xmap→OCAD translation.
          if (isOcadShapedElement(el)) out.push(el as OcadElement)
          else out.push(...pointElementFromXmap(el, colorNumber, flipY))
        }
        break
      }
    }
  }
  return out
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

export function circleElement(color: number, diameter: number, lineWidth: number): OcadElement {
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
  return typeof r.type === 'number'
    && (r.numberCoords !== undefined || 'lineWidth' in r || 'diameter' in r)
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
 * See `map/coord.ts:normaliseOmapFlags` — this mirrors that mapping
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
    return { 0: Number(x) | 0, 1: (Number(y) * yScale) | 0, xFlags, yFlags }
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
      type: DotElementType, flags: 0, color: innerSlot,
      lineWidth: 0, diameter: normUnits(innerRaw * 2),
      numberCoords: 1, coords: [anchor],
    })
  }
  const outer = normUnits(ps.outerWidth)
  const outerSlot = colorNumber(ps.outerColor)
  if (outer > 0 && outerSlot > 0) {
    out.push({
      type: CircleElementType, flags: 0, color: outerSlot,
      lineWidth: outer, diameter: normUnits(innerRaw * 2 + outer),
      numberCoords: 1, coords: [anchor],
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
