import lineOffset from '@turf/line-offset'
import TdPoly from '../../formats/ocad/reader/decode/td-poly.js'
import {
  splitRingsAtHolePoints,
  type FlaggedCoord,
} from '../../panmap/coord.js'
import type { MapObject } from '../../panmap/model.js'
import type {
  LineElementsLayer,
  DoubleLineLayer,
  RenderElement,
} from '../../panmap/render-layers.js'
import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import {
  coordsToPath,
  buildPathSampler,
  pointAndAngleAtSampler,
  type Transform,
  type PathSampler,
} from './path.js'
import { getColor, getElementColorOrder, type ColorLookup } from './colors.js'
import { ocadPointElementToSvg } from './point-symbols.js'

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
    (layer.spacing as number) > 0
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
  const spacing = Math.max((layer.spacing as number) || 0, 1)
  if (total <= 0) return []

  const startOffset = Math.max((layer.endOffset as number) || 0, 0)
  const endOffset = Math.max((layer.endOffset as number) || 0, 0)
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
  return splitRingsAtHolePoints(coordinates)
    .filter(seg => seg.length > 1)
    .map(seg => offsetLineString(seg, offset))
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

export { lineElementsLayerToSvg, doubleLineLayerToSvg }
