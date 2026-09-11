import lineOffset from '@turf/line-offset'
import TdPoly from '../../formats/ocad/reader/decode/td-poly.js'
import { isFirstHolePoint, type FlaggedCoord } from '../../panmap/coord.js'
import type { MapObject } from '../../panmap/model.js'
import type {
  LineSymbolsLayer,
  LineElementsLayer,
  DoubleLineLayer,
  RenderElement,
  DecorationSymbol,
} from '../../panmap/render-layers.js'
import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import {
  coordsToPath,
  buildPathSampler,
  pointAndAngleAtSampler,
  lineAngleStartSampler,
  lineAngleEndSampler,
  type Transform,
  type PathSampler,
} from './path.js'
import {
  getColor,
  orderFor,
  getElementColorOrder,
  type ColorLookup,
} from './colors.js'
import { ocadPointElementToSvg, xmapPointSymbolToSvg } from './point-symbols.js'

function lineSymbolsLayerToSvg(
  object: MapObject,
  layer: LineSymbolsLayer,
  colors: ColorLookup,
  transform: Transform,
) {
  const line = layer.lineSymbol
  const coords = (object.coordinates as FlaggedCoord[]) || []
  if (!line || coords.length < 2) return null

  const sampler = buildPathSampler(coords)
  const total = sampler.total
  if (total <= 0) return null

  // Emit each sub-symbol placement as separate {order, node} entries so
  // the top-level sort places each primitive at its own colour's
  // priority. Previously all placements were joined into one string
  // rendered at the containing line-symbols layer's order, which
  // meant a mid-symbol's green ring painted at the same depth as its
  // white halo — sub-symbol z-order collapsed to insertion order.
  const rendered: Array<{ order: number; node: string }> = []
  const addSymbol = (
    symbol: DecorationSymbol | undefined,
    distance: number,
    rotatable = true,
  ) => {
    if (!symbol) return
    const point = pointAndAngleAtSampler(
      sampler,
      Math.max(0, Math.min(total, distance)),
    )
    const primitives = xmapPointSymbolToSvg(
      symbol,
      point[0],
      point[1],
      colors,
      transform,
      rotatable && symbol.pointSymbol?.rotatable ? point.angle : 0,
    )
    for (const { colorId, node } of primitives) {
      rendered.push({
        order: orderFor(colorId, layer, colors),
        node,
      })
    }
  }

  // Even distribution — matches Mapper's `LineSymbol::createRenderables`
  // and OCAD's own placement. Compute a nominal symbol count from the
  // usable length ÷ step, honour `showAtLeastOneSymbol` and
  // `minimumMidSymbolCount`, then space them so the START-to-first and
  // last-to-END gaps are equal ((i + 0.5) × spacing). The previous
  // "for d = step; d < total; d += step" formulation drifted off centre
  // and dropped the last symbol whenever the line length wasn't a
  // clean multiple of the step.
  const placeAlong = (
    symbol: DecorationSymbol | undefined,
    step: number,
    startOffset: number,
    endOffset: number,
    minCount: number,
    atLeastOne: boolean,
  ) => {
    if (!symbol) return
    const usable = Math.max(0, total - startOffset - endOffset)
    if (step <= 0) {
      if (atLeastOne) addSymbol(symbol, total / 2)
      return
    }
    let count = Math.round(usable / step)
    if (count < minCount) count = minCount
    if (count < 1 && atLeastOne) count = 1
    if (count < 1) return
    const spacing = usable / count
    for (let i = 0; i < count; i++) {
      addSymbol(symbol, startOffset + (i + 0.5) * spacing)
    }
  }

  if (line.midSymbol) {
    placeAlong(
      line.midSymbol as DecorationSymbol,
      line.midSymbolDistance || line.segmentLength || 0,
      0,
      0,
      line.minimumMidSymbolCount || 0,
      line.showAtLeastOneSymbol !== false,
    )
  }

  if (line.dashSymbol) {
    placeAlong(
      line.dashSymbol as DecorationSymbol,
      line.segmentLength || (line.dashLength || 0) + (line.breakLength || 0),
      Math.max(line.startOffset || 0, 0),
      Math.max(line.endOffset || 0, 0),
      0,
      !!line.showAtLeastOneSymbol,
    )
  }

  if (line.startSymbol) {
    const startSymbol = line.startSymbol as DecorationSymbol
    const angle = lineAngleStartSampler(sampler)
    const start = transform(coords[0])
    const primitives = xmapPointSymbolToSvg(
      startSymbol,
      start[0],
      start[1],
      colors,
      coord => coord,
      startSymbol.pointSymbol?.rotatable ? angle : 0,
    )
    for (const { colorId, node } of primitives) {
      rendered.push({
        order: orderFor(colorId, layer, colors),
        node,
      })
    }
  }

  if (line.endSymbol) {
    const endSymbol = line.endSymbol as DecorationSymbol
    const angle = lineAngleEndSampler(sampler)
    const end = transform(coords[coords.length - 1])
    const primitives = xmapPointSymbolToSvg(
      endSymbol,
      end[0],
      end[1],
      colors,
      coord => coord,
      endSymbol.pointSymbol?.rotatable ? angle : 0,
    )
    for (const { colorId, node } of primitives) {
      rendered.push({
        order: orderFor(colorId, layer, colors),
        node,
      })
    }
  }

  return rendered
}

function lineElementsLayerToSvg(
  object: MapObject,
  layer: LineElementsLayer,
  colors: ColorLookup,
  transform: Transform,
) {
  const coords = (object.coordinates as FlaggedCoord[]) || []
  if (coords.length < 2) return null

  const rendered: Array<{ order: number; node: string }> = []
  const addElements = (
    elements: RenderElement[] | undefined,
    anchor: ArrayLike<number>,
    angle: number,
  ) => {
    if (!Array.isArray(elements)) return
    elements.forEach(element => {
      const svg = ocadPointElementToSvg(
        element,
        anchor,
        colors,
        transform,
        angle,
      )
      if (svg) {
        rendered.push({
          order: getElementColorOrder(element, colors),
          node: svg,
        })
      }
    })
  }

  if (
    Array.isArray(layer.primSymElements) &&
    layer.primSymElements.length > 0 &&
    (layer.mainLength as number) > 0
  ) {
    const sampler = buildPathSampler(coords)
    primaryLineElementPositions(sampler, layer).forEach(position => {
      const point = pointAndAngleAtSampler(sampler, position)
      addElements(layer.primSymElements, [point[0], point[1]], point.angle)
    })
  }

  if (
    Array.isArray(layer.cornerSymElements) &&
    layer.cornerSymElements.length
  ) {
    for (let i = 1; i < coords.length - 1; i++) {
      const c0 = coords[i - 1]
      const c1 = coords[i]
      addElements(
        layer.cornerSymElements,
        c1,
        Math.atan2(c1[1] - c0[1], c1[0] - c0[0]),
      )
    }
  }

  if (Array.isArray(layer.startSymElements) && layer.startSymElements.length) {
    const c0 = coords[0]
    const c1 = coords[1]
    addElements(
      layer.startSymElements,
      c0,
      Math.atan2(c1[1] - c0[1], c1[0] - c0[0]),
    )
  }

  if (Array.isArray(layer.endSymElements) && layer.endSymElements.length) {
    const c0 = coords[coords.length - 2]
    const c1 = coords[coords.length - 1]
    addElements(
      layer.endSymElements,
      c1,
      Math.atan2(c1[1] - c0[1], c1[0] - c0[0]),
    )
  }

  return rendered
}

function primaryLineElementPositions(
  sampler: PathSampler,
  layer: LineElementsLayer,
): number[] {
  const total = sampler.total
  const spacing = Math.max(layer.mainLength || 0, 1)
  if (total <= 0) return []

  const startOffset = Math.max(layer.endLength || 0, 0)
  const endOffset = Math.max(layer.endLength || 0, 0)
  const start = Math.min(startOffset, total / 2)
  const end = Math.max(start, total - endOffset)

  if (end <= start || total < spacing * 0.75) {
    return [total / 2]
  }

  const available = end - start
  const count =
    startOffset || endOffset
      ? Math.max(1, Math.round(available / spacing) + 1)
      : Math.max(2, Math.round(total / spacing) + 1)

  if (count === 1) return [(start + end) / 2]

  const first = startOffset || endOffset ? start : 0
  const last = startOffset || endOffset ? end : total
  const interval = (last - first) / (count - 1)

  return Array.from({ length: count }, (_, index) => first + interval * index)
}

function doubleLineLayerToSvg(
  object: MapObject,
  layer: DoubleLineLayer,
  colors: ColorLookup,
  transform: Transform,
) {
  const coords = (object.coordinates as FlaggedCoord[]) || []
  if (coords.length < 2) return null

  if (layer.mode === 2) {
    const width =
      (layer.leftWidth || 0) +
      (layer.centerWidth || 0) +
      (layer.rightWidth || 0)
    if (width <= 0) return null
    return `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
      getColor({ colorId: layer.fillColorId }, colors),
    )}" stroke-width="${width}" fill="none" />`
  }

  if (layer.mode !== 1) return null

  if ((layer.flags as number) & 1) {
    const outerWidth =
      (layer.leftWidth || 0) +
      (layer.centerWidth || 0) +
      (layer.rightWidth || 0)
    return [
      outerWidth > 0 &&
        `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
          getColor({ colorId: layer.leftColorId }, colors),
        )}" stroke-width="${outerWidth}" fill="none" />`,
      (layer.centerWidth as number) > 0 &&
        `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
          getColor({ colorId: layer.fillColorId }, colors),
        )}" stroke-width="${layer.centerWidth}" fill="none" />`,
    ]
      .filter(Boolean)
      .join('')
  }

  return [
    ...offsetLineCoordinates(
      coords,
      -(layer.centerWidth || 0) / 2 - (layer.leftWidth || 0) / 2,
    ).map(lineCoords =>
      linePathToSvg(
        lineCoords,
        layer.leftWidth,
        layer.leftColorId,
        colors,
        transform,
      ),
    ),
    ...offsetLineCoordinates(
      coords,
      (layer.centerWidth || 0) / 2 + (layer.rightWidth || 0) / 2,
    ).map(lineCoords =>
      linePathToSvg(
        lineCoords,
        layer.rightWidth,
        layer.rightColorId,
        colors,
        transform,
      ),
    ),
  ]
    .filter(Boolean)
    .join('')
}

function linePathToSvg(
  coords: number[][],
  width: number | undefined,
  colorId: number | string | undefined,
  colors: ColorLookup,
  transform: Transform,
): string | null {
  if (!width || width <= 0) return null
  return `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
    getColor({ colorId }, colors),
  )}" stroke-width="${width}" fill="none" stroke-linejoin="bevel" stroke-linecap="butt" />`
}

function offsetLineCoordinates(
  coordinates: FlaggedCoord[],
  offset: number,
): number[][][] {
  const result: number[][][] = []
  let current: FlaggedCoord[] = []

  for (const coord of coordinates) {
    if (!isFirstHolePoint(coord)) {
      current.push(coord)
    } else {
      if (current.length > 1) result.push(offsetLineString(current, offset))
      current = [coord]
    }
  }

  if (current.length > 1) result.push(offsetLineString(current, offset))

  return result
}

function offsetLineString(
  coordinates: FlaggedCoord[],
  offset: number,
): TdPoly[] {
  return lineOffset(
    {
      type: 'LineString',
      coordinates: coordinates as unknown as number[][],
    },
    offset,
    { units: 'degrees' },
  ).geometry.coordinates.map(
    (coord, index) =>
      new TdPoly(
        coord[0],
        coord[1],
        coordinates[index].xFlags,
        coordinates[index].yFlags,
      ),
  )
}

export { lineElementsLayerToSvg, doubleLineLayerToSvg, lineSymbolsLayerToSvg }
