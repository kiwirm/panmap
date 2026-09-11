import {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} from '../../formats/ocad/native/symbol-element-types.js'
import type { MapObject } from '../../panmap/model.js'
import type {
  RenderLayer,
  RenderElement,
  PointSymbolSpec,
  DecorationSymbol,
} from '../../panmap/render-layers.js'
import type { FlaggedCoord } from '../../panmap/coord.js'
import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import { coordsToPath, type Transform } from './path.js'
import { dashToSvg } from './style.js'
import {
  getColor,
  isValidColorId,
  opacityAttr,
  orderFor,
  type ColorLookup,
} from './colors.js'

/** One emitted SVG primitive tagged with the colour it paints in. */
type SvgPrimitive = { colorId: number | string | undefined; node: string }

function pointLayerToSvg(
  object: MapObject,
  layer: RenderLayer,
  colors: ColorLookup,
  transform: Transform,
) {
  const rawCoord = (object.coordinates as FlaggedCoord[] | undefined)?.[0]
  const coord = rawCoord && transform(rawCoord)
  if (!rawCoord || !coord) return null

  if (layer.type === 'point-fill') {
    if (!isValidColorId(layer.colorId ?? layer.color)) return null
    return `<circle cx="${coord[0]}" cy="${coord[1]}" r="${
      layer.radius || 0
    }" fill="${escapeAttr(getColor(layer, colors))}"${opacityAttr(layer)} />`
  }

  if (layer.type === 'point-stroke') {
    if (!isValidColorId(layer.colorId ?? layer.color)) return null
    return `<circle cx="${coord[0]}" cy="${coord[1]}" r="${
      layer.radius || 0
    }" fill="none" stroke="${escapeAttr(
      getColor(layer, colors),
    )}" stroke-width="${layer.width || 0}"${opacityAttr(layer)} />`
  }

  if (layer.type === 'point-elements') {
    // Flatten each source element to its emitted primitives, then
    // tag each primitive with its OWN colour's render order so the
    // top-level SVG sort paints them in Mapper's colour-priority
    // order (not the source-order of elements within the symbol).
    // Object rotation is radians in the source-format's y-up frame;
    // negate for the y-down coord space we render into (see textLayerToSvg).
    return ((layer.elements as RenderElement[]) || []).flatMap(element =>
      pointElementToSvg(
        element,
        rawCoord,
        colors,
        transform,
        -(object.rotation || 0),
      ).map(({ colorId, node }) => ({
        order: orderFor(colorId, layer, colors),
        node,
      })),
    )
  }

  return null
}

// Render an xmap point-symbol's inner disc + outer ring as {colorId, node}
// primitives centred at (cx, cy). Shared by the top-level point renderer and
// nested point elements so the outer-ring geometry stays consistent.
//
// Mapper draws the outer ring OUTWARD from `innerRadius`: inner edge at
// `innerRadius`, outer edge at `innerRadius + outerWidth`. An SVG stroke is
// centred on its path, so centre it at `innerRadius + outerWidth / 2` —
// centring on `innerRadius` lets a fat ring reach inward and overpaint the
// inner fill (e.g. 418 with r=10, w=30 hid the r=10 white centre).
function pointSymbolCircles(
  pointSymbol: PointSymbolSpec,
  cx: number,
  cy: number,
  colors: ColorLookup,
): SvgPrimitive[] {
  const out: SvgPrimitive[] = []
  if (isValidColorId(pointSymbol.innerColor) && pointSymbol.innerRadius > 0) {
    out.push({
      colorId: pointSymbol.innerColor,
      node: `<circle cx="${cx}" cy="${cy}" r="${pointSymbol.innerRadius}" fill="${escapeAttr(
        getColor({ colorId: pointSymbol.innerColor }, colors),
      )}" />`,
    })
  }
  if (
    isValidColorId(pointSymbol.outerColor) &&
    pointSymbol.outerWidth > 0 &&
    pointSymbol.innerRadius > 0
  ) {
    out.push({
      colorId: pointSymbol.outerColor,
      node: `<circle cx="${cx}" cy="${cy}" r="${pointSymbol.innerRadius + pointSymbol.outerWidth / 2}" fill="none" stroke="${escapeAttr(
        getColor({ colorId: pointSymbol.outerColor }, colors),
      )}" stroke-width="${pointSymbol.outerWidth}" />`,
    })
  }
  return out
}

// Emit one xmap point symbol placement (used by line-symbol mid/dash/
// start/end placements) as a list of {colorId, node} primitives — same
// shape as pointElementToSvg — so callers can hand them to the top-level
// SVG sort at each primitive's own colour priority instead of forcing
// the whole group into one order. Rotation is baked into element coords
// rather than wrapping in an SVG group.
function xmapPointSymbolToSvg(
  symbol: DecorationSymbol,
  x: number,
  y: number,
  colors: ColorLookup,
  transform: Transform = coord => coord,
  rotation = 0,
): SvgPrimitive[] {
  const anchor = transform([x, y])
  const out: SvgPrimitive[] = []
  const pointSymbol = symbol.pointSymbol
  if (!pointSymbol) return out

  out.push(...pointSymbolCircles(pointSymbol, anchor[0], anchor[1], colors))
  for (const element of pointSymbol.elements || []) {
    out.push(...pointElementToSvg(element, [x, y], colors, transform, rotation))
  }
  return out
}

// Returns an array of {colorId, node} entries — one per emitted SVG
// primitive. The caller expands these into per-color-ordered nodes so
// composite point elements (ISOM 417 tree = green ring + white
// cutout, 419 special veg = green X + white halo, etc.) paint in
// COLOR order instead of source order. Concatenating them into a
// single string here would force all sub-primitives to share the
// containing layer's render order, and Mapper's own convention is that
// each colour draws at its own priority level.
function pointElementToSvg(
  element: RenderElement,
  anchor: ArrayLike<number>,
  colors: ColorLookup,
  transform: Transform = coord => coord,
  angle = 0,
): SvgPrimitive[] {
  if (element.coords) {
    // OCAD-style element (already flat, single colour).
    const node = ocadPointElementToSvg(
      element,
      anchor,
      colors,
      transform,
      angle,
    )
    return node ? [{ colorId: element.color, node }] : []
  }
  if (!element.object || !element.symbol) return []

  // Apply the containing symbol's rotation (radians) to the element's
  // local coords, then translate into map space via the transformed
  // anchor. Without this, mid/dash/start/end symbols on rotated line
  // objects render axis-aligned instead of following the line angle.
  const transformedAnchor = transform(anchor)
  const coords = (element.object.coords || []).map(coord =>
    addRotatedCoord(transformedAnchor, [coord.x, coord.y], angle),
  )
  if (coords.length === 0) return []

  if (element.symbol.areaSymbol) {
    const fillColorId = element.symbol.areaSymbol.innerColor
    const strokeColorId =
      element.symbol.lineSymbol && element.symbol.lineSymbol.color
    const strokeWidth =
      element.symbol.lineSymbol && element.symbol.lineSymbol.lineWidth
    const out: SvgPrimitive[] = []
    if (isValidColorId(fillColorId)) {
      out.push({
        colorId: fillColorId,
        node: `<path d="${coordsToPath(coords)} Z" fill="${escapeAttr(
          getColor({ colorId: fillColorId }, colors),
        )}" fill-rule="evenodd" />`,
      })
    }
    if (isValidColorId(strokeColorId) && (strokeWidth as number) > 0) {
      out.push({
        colorId: strokeColorId,
        node: `<path d="${coordsToPath(coords)} Z" fill="none" stroke="${escapeAttr(
          getColor({ colorId: strokeColorId }, colors),
        )}" stroke-width="${strokeWidth}" fill-rule="evenodd" />`,
      })
    }
    return out
  }

  if (element.symbol.lineSymbol) {
    const strokeColorId = element.symbol.lineSymbol.color
    const strokeWidth = element.symbol.lineSymbol.lineWidth
    if (!isValidColorId(strokeColorId) || (strokeWidth as number) <= 0)
      return []
    return [
      {
        colorId: strokeColorId,
        node: `<path d="${coordsToPath(coords)}" stroke="${escapeAttr(
          getColor({ colorId: strokeColorId }, colors),
        )}" stroke-width="${strokeWidth}" fill="none" />`,
      },
    ]
  }

  if (element.symbol.pointSymbol) {
    const nestedCoord = coords[0]
    return pointSymbolCircles(
      element.symbol.pointSymbol,
      nestedCoord[0],
      nestedCoord[1],
      colors,
    )
  }

  return []
}

function ocadPointElementToSvg(
  element: RenderElement,
  anchor: ArrayLike<number>,
  colors: ColorLookup,
  transform: Transform,
  angle = 0,
): string | null {
  const coords = (element.coords || []).map(coord =>
    transform(addRotatedCoord(anchor, coord, angle)),
  )

  switch (element.type) {
    case LineElementType:
      if (!element.lineWidth) return null
      return `<path d="${coordsToPath(coords)}" stroke="${escapeAttr(
        getColor({ colorId: element.color }, colors),
      )}" stroke-width="${element.lineWidth}" fill="none" stroke-linejoin="bevel" stroke-linecap="butt"${
        dashToSvg(element) ? ` stroke-dasharray="${dashToSvg(element)}"` : ''
      } />`
    case AreaElementType:
      return `<path d="${coordsToPath(coords)} Z" fill="${escapeAttr(
        getColor({ colorId: element.color }, colors),
      )}" fill-rule="evenodd" />`
    case CircleElementType:
    case DotElementType: {
      const coord = transform(anchor)
      const stroke =
        element.type === CircleElementType
          ? ` fill="none" stroke="${escapeAttr(
              getColor({ colorId: element.color }, colors),
            )}" stroke-width="${element.lineWidth || 0}"`
          : ` fill="${escapeAttr(getColor({ colorId: element.color }, colors))}"`
      return `<circle cx="${coord[0]}" cy="${coord[1]}" r="${
        (element.diameter || 0) / 2
      }"${stroke} />`
    }
    default:
      return null
  }
}

function addRotatedCoord(
  anchor: ArrayLike<number>,
  coord: ArrayLike<number>,
  angle: number,
): number[] {
  if (!angle) return [coord[0] + anchor[0], coord[1] + anchor[1]]

  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    anchor[0] + coord[0] * cos - coord[1] * sin,
    anchor[1] + coord[0] * sin + coord[1] * cos,
  ]
}

export { pointLayerToSvg, xmapPointSymbolToSvg, ocadPointElementToSvg }
