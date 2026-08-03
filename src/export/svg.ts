import { DOMParser, type Element as DOMElement } from '@xmldom/xmldom'
import type PanMap from '../map/model.js'
import lineOffset from '@turf/line-offset'
import TdPoly from '../formats/ocad/internal/td-poly.js'
import {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} from '../formats/ocad/internal/symbol-element-types.js'
import { isFirstHolePoint, LINE_ELEMENT_LAYER_KEYS } from '../map/coord.js'
import { escapeXmlAttr as attrEscape, escapeXmlText as textEscape } from '../util/xml.js'
import {
  coordsToPath,
  pathLength,
  pointAndAngleAt,
  lineAngleStart,
  lineAngleEnd,
} from './svg/path.js'
import { dashToSvg, lineJoinToSvg, lineCapToSvg } from './svg/style.js'

const supportedLayerTypes = new Set([
  'stroke',
  'fill',
  'hatch-fill',
  'structure-fill',
  'line-elements',
  'double-line',
  'border-symbol',
  'line-symbols',
  'point-pattern-fill',
  'point-fill',
  'point-stroke',
  'point-elements',
  'text',
])

export interface MapToSvgOptions {
  coordinateTransform?: (coord: number[]) => number[]
  backgroundColor?: string
  fromColor?: number
  toColor?: number
  document?: unknown
  // Override the SVG viewBox / width / height. Useful when rendering
  // a diff and overlaying it on the full "after" render — without
  // this override the diff's viewBox shrinks to just the changed
  // region, breaking alignment.
  bounds?: [number, number, number, number]
}

export interface UnsupportedRenderReason {
  symbolId: number | string
  objectId: number | string
  reason: string
  count: number
}

export interface MapSvgRenderSupport {
  direct: boolean
  objectCount: number
  supportedObjectCount: number
  unsupportedObjectCount: number
  unsupported: UnsupportedRenderReason[]
}

/**
 * Render a `PanMap` object to SVG.
 *
 * Simple symbols are rendered directly from source-independent `renderLayers`.
 * More complex normalized maps are handled by shared SVG renderers that can use
 * retained source metadata while the render-layer model grows.
 */
function mapToSvg(map: PanMap, options: MapToSvgOptions = {}): DOMElement {
  if (getMapSvgRenderSupport(map).direct) {
    return renderDirectly(map, {
      ...options,
      coordinateTransform:
        options.coordinateTransform || getVisualCoordinateTransform(map) || undefined,
    })
  }

  throw new Error(
    `Can not render map from source format "${map.sourceFormat}" directly to SVG yet.`
  )
}

function getVisualCoordinateTransform(map) {
  if (map.sourceFormat === 'ocad') return coord => [coord[0], -coord[1]]

  if (map.sourceFormat !== 'diff') return null

  const sourceFile = map.sourceFile || {}
  if (
    sourceFile.before &&
    sourceFile.after &&
    sourceFile.before.sourceFormat === 'ocad' &&
    sourceFile.after.sourceFormat === 'ocad'
  ) {
    return coord => [coord[0], -coord[1]]
  }

  return null
}

/**
 * Reports whether a map can be rendered directly from PanMap render layers.
 */
function getMapSvgRenderSupport(map: PanMap): MapSvgRenderSupport {
  const symbols = getSymbolsById(map)
  const unsupportedByKey: Record<string, UnsupportedRenderReason> = {}
  let supportedObjectCount = 0

  map.objects.forEach(object => {
    const symbol = symbols[object.symbolId]
    const reasons = getUnsupportedReasons(object, symbol)
    if (reasons.length === 0) {
      supportedObjectCount++
      return
    }

    reasons.forEach(reason => {
      const key = `${object.symbolId}:${reason}`
      if (!unsupportedByKey[key]) {
        unsupportedByKey[key] = {
          symbolId: object.symbolId,
          objectId: object.id,
          reason,
          count: 0,
        }
      }
      unsupportedByKey[key].count++
    })
  })

  const unsupported = Object.values(unsupportedByKey)

  return {
    direct: unsupported.length === 0,
    objectCount: map.objects.length,
    supportedObjectCount,
    unsupportedObjectCount: map.objects.length - supportedObjectCount,
    unsupported,
  }
}

function getUnsupportedReasons(object, symbol) {
  const reasons: string[] = []

  if (!symbol) return ['missing symbol']
  if (symbol.hidden || object.hidden) return []

  const layers = symbol.renderLayers || []
  if (layers.length === 0) reasons.push('no render layers')

  layers.forEach(layer => {
    if (!supportedLayerTypes.has(layer.type)) {
      reasons.push(`unsupported layer ${layer.type}`)
    }
    if (!canRenderObjectLayer(object, layer)) {
      reasons.push(`layer ${layer.type} does not render object type ${object.type}`)
    }
  })

  return Array.from(new Set(reasons))
}

function canRenderObjectLayer(object, layer) {
  switch (object.type) {
    case 'line':
      return (
        layer.type === 'stroke' ||
        layer.type === 'line-elements' ||
        layer.type === 'double-line' ||
        layer.type === 'line-symbols'
      )
    case 'area':
      return (
        layer.type === 'fill' ||
        layer.type === 'stroke' ||
        layer.type === 'hatch-fill' ||
        layer.type === 'structure-fill' ||
        layer.type === 'border-symbol' ||
        layer.type === 'point-pattern-fill'
      )
    case 'point':
      return (
        layer.type === 'point-fill' ||
        layer.type === 'point-stroke' ||
        layer.type === 'point-elements'
      )
    case 'text':
    case 'line-text':
      return layer.type === 'text'
    default:
      return false
  }
}

function renderDirectly(map: PanMap, options: MapToSvgOptions = {}): DOMElement {
  const transformCoord = options.coordinateTransform || (coord => coord)
  const bounds = options.bounds || map.getBounds(transformCoord)
  const width = bounds[2] - bounds[0] || 100
  const height = bounds[3] - bounds[1] || 100
  const symbols = getSymbolsById(map)
  const colors = getColorsById(map)
  const nodes: Array<{ sequence: number; order: number; node: string }> = []
  const defs: string[] = []
  let patternId = 0
  let sequence = 0

  map.objects.forEach(object => {
    const symbol = symbols[object.symbolId]
    if (!symbol || symbol.hidden || object.hidden) return
    const layers = symbol.renderLayers || []
    layers.forEach(layer => {
      const rendered = objectLayerToSvg(
        object,
        layer,
        colors,
        defs,
        patternId++,
        transformCoord,
        symbols
      )
      renderedLayerEntries(rendered, layer, colors).forEach(entry => {
        nodes.push({
          ...entry,
          sequence: sequence++,
        })
      })
    })
  })

  const renderedNodes = nodes
    .filter(
      node =>
        (options.fromColor == null || node.order >= options.fromColor) &&
        (options.toColor == null || node.order <= options.toColor)
    )
    .sort((a, b) => b.order - a.order || a.sequence - b.sequence)
  const background = options.backgroundColor
    ? `<rect x="${bounds[0]}" y="${bounds[1]}" width="${width}" height="${height}" fill="${escapeAttr(
        options.backgroundColor
      )}" />`
    : ''

  // Cap the outer svg's CSS width/height to a browser-friendly size
  // while keeping the viewBox in native map units. Browsers (Chrome
  // in particular) apply non-proportional caps to the intrinsic size
  // of very large SVGs used as `<img>` — a raw `width="28623"` came
  // back as a 9545×9567 near-square natural size, wrecking downstream
  // fit-to-view math. Capping the long side to `MAX_INTRINSIC_DIM`
  // keeps aspect ratio intact and gives predictable natural sizes.
  const MAX_INTRINSIC_DIM = 2000
  const displayScale = Math.min(1, MAX_INTRINSIC_DIM / Math.max(width, height))
  const displayWidth = Math.round(width * displayScale)
  const displayHeight = Math.round(height * displayScale)
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" fill="transparent" viewBox="${bounds[0]} ${bounds[1]} ${width} ${height}" width="${displayWidth}" height="${displayHeight}"><defs>${defs.join('')}</defs><g>${background}${renderedNodes
    .map(({ node }) => node)
    .join('')}</g></svg>`
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  if (!parsed) throw new Error('SVG parse produced no document element')
  return parsed
}

function objectLayerToSvg(
  object,
  layer,
  colors,
  defs,
  patternIndex,
  transform,
  symbols = {}
) {
  switch (object.type) {
    case 'line': {
      if (layer.type === 'line-elements') {
        return lineElementsLayerToSvg(object, layer, colors, transform)
      }
      if (layer.type === 'double-line') {
        return doubleLineLayerToSvg(object, layer, colors, transform)
      }
      if (layer.type === 'line-symbols') {
        return lineSymbolsLayerToSvg(object, layer, colors, transform)
      }
      if (layer.type !== 'stroke') return null
      const dashArray = dashToSvg(layer.dash)
      return `<path d="${coordsToPath(object.coordinates, transform)}" stroke="${escapeAttr(
        getColor(layer, colors)
      )}" stroke-width="${layer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
        layer.lineStyle
      )}" stroke-linecap="${lineCapToSvg(layer.lineStyle)}"${opacityAttr(layer)}${
        dashArray ? ` stroke-dasharray="${dashArray}"` : ''
      } />`
    }
    case 'area':
      if (layer.type === 'stroke') {
        const dashArray = dashToSvg(layer.dash)
        return `<path d="${coordsToPath(object.coordinates, transform)} Z" stroke="${escapeAttr(
          getColor(layer, colors)
        )}" stroke-width="${layer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
          layer.lineStyle
        )}" stroke-linecap="${lineCapToSvg(layer.lineStyle)}"${
          dashArray ? ` stroke-dasharray="${dashArray}"` : ''
        }${opacityAttr(layer)} />`
      }
      if (layer.type === 'hatch-fill') {
        const id = `map-hatch-${patternIndex}`
        defs.push(hatchPatternToSvg(id, layer, colors))
        return `<path d="${coordsToPath(object.coordinates, transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(layer)} />`
      }
      if (layer.type === 'structure-fill') {
        const id = `map-structure-${patternIndex}`
        defs.push(structurePatternToSvg(id, layer, colors))
        return `<path d="${coordsToPath(object.coordinates, transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(layer)} />`
      }
      if (layer.type === 'point-pattern-fill') {
        const id = `map-point-pattern-${patternIndex}`
        defs.push(pointPatternToSvg(id, layer, colors))
        return `<path d="${coordsToPath(object.coordinates, transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(layer)} />`
      }
      if (layer.type === 'border-symbol') {
        const borderSymbol = symbols[layer.symbolId]
        if (!borderSymbol) return null
        const lineObject = { ...object, type: 'line' }
        return (borderSymbol.renderLayers || [])
          .map(borderLayer =>
            objectLayerToSvg(
              lineObject,
              borderLayer,
              colors,
              defs,
              patternIndex,
              transform,
              symbols
            )
          )
          .filter(Boolean)
          .join('')
      }
      if (layer.type !== 'fill') return null
      return `<path d="${coordsToPath(object.coordinates, transform)} Z" fill="${escapeAttr(
        getColor(layer, colors)
      )}" fill-rule="evenodd"${opacityAttr(layer)} />`
    case 'point':
      return pointLayerToSvg(object, layer, colors, transform)
    case 'text':
    case 'line-text':
      if (layer.type !== 'text') return null
      return textLayerToSvg(object, layer, colors, transform)
    default:
      return null
  }
}

function renderedLayerEntries(rendered, layer, colors) {
  if (!rendered) return []
  if (Array.isArray(rendered)) {
    return rendered
      .filter(entry => entry && entry.node)
      .map(entry => ({
        order:
          entry.order !== undefined ? entry.order : getColorOrder(layer, colors),
        node: entry.node,
      }))
  }
  return [
    {
      order: getColorOrder(layer, colors),
      node: rendered,
    },
  ]
}

function hatchPatternToSvg(id, layer, colors) {
  const spacing = Math.max(layer.spacing || 1, 1)
  const lineWidth = Math.max(layer.lineWidth || 1, 1)
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" patternTransform="rotate(${
    layer.angle || 0
  })" width="10" height="${spacing}"><rect x="0" y="0" width="10" height="${lineWidth}" fill="${escapeAttr(
    getColor(layer, colors)
  )}" /></pattern>`
}

function structurePatternToSvg(id, layer, colors) {
  const width = Math.max(layer.width || layer.symbolWidth || 1, 1)
  const height = Math.max(layer.height || layer.symbolHeight || 1, 1)
  const symbolWidth = Math.max(layer.symbolWidth || width, 1)
  const symbolHeight = Math.max(layer.symbolHeight || height, 1)
  const anchors = [[symbolWidth * 0.5, -symbolHeight * 0.5]]

  if (layer.mode === 2) {
    anchors.push([symbolWidth, -symbolHeight * 1.5])
    anchors.push([0, -symbolHeight * 1.5])
  }

  const content = anchors
    .flatMap(anchor =>
      (layer.elements || []).map(element =>
        ocadPointElementToSvg(element, anchor, colors, coord => coord)
      )
    )
    .filter(Boolean)
    .join('\n')

  return `<pattern id="${id}" patternUnits="userSpaceOnUse" patternTransform="rotate(${
    layer.angle || 0
  })" width="${width}" height="${height}">${content}</pattern>`
}

function pointPatternToSvg(id, layer, colors) {
  const width = Math.max(layer.width || 1, 1)
  const height = Math.max(layer.height || width, 1)
  const pattern = layer.pattern || {}
  const content = pattern.symbol
    ? xmapPointSymbolToSvg(pattern.symbol, width / 2, height / 2, colors)
    : ''
  const translateX = pattern.offsetAlongLine || 0
  const translateY = pattern.lineOffset || 0
  const transforms = [
    translateX || translateY ? `translate(${translateX} ${translateY})` : '',
    layer.angle ? `rotate(${layer.angle})` : '',
  ].filter(Boolean)

  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${width}" height="${height}"${
    transforms.length ? ` patternTransform="${transforms.join(' ')}"` : ''
  }>${content}</pattern>`
}

function pointLayerToSvg(object, layer, colors, transform) {
  const rawCoord = object.coordinates[0]
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
      getColor(layer, colors)
    )}" stroke-width="${layer.width || 0}"${opacityAttr(layer)} />`
  }

  if (layer.type === 'point-elements') {
    return (layer.elements || [])
      .map(element => ({
        order: getElementColorOrder(element, colors),
        node: pointElementToSvg(
          element,
          rawCoord,
          colors,
          transform,
          object.rotation || 0
        ),
      }))
      .filter(entry => entry.node)
  }

  return null
}

function lineSymbolsLayerToSvg(object, layer, colors, transform) {
  const line = layer.lineSymbol
  const coords = object.coordinates || []
  if (!line || coords.length < 2) return null

  const total = pathLength(coords)
  if (total <= 0) return null

  const rendered: string[] = []
  const addSymbol = (symbol, distance, rotatable = true) => {
    if (!symbol) return
    const point = pointAndAngleAt(coords, Math.max(0, Math.min(total, distance)))
    const svg = xmapPointSymbolToSvg(
      symbol,
      point[0],
      point[1],
      colors,
      transform,
      rotatable && symbol.pointSymbol?.rotatable ? point.angle : 0
    )
    if (svg) rendered.push(svg)
  }

  if (line.midSymbol) {
    const step = line.midSymbolDistance || line.segmentLength || 0
    if (step > 0) {
      for (let distance = step; distance < total; distance += step) {
        addSymbol(line.midSymbol, distance)
      }
    } else {
      addSymbol(line.midSymbol, total / 2)
    }
  }

  if (line.dashSymbol) {
    const step =
      line.segmentLength || (line.dashLength || 0) + (line.breakLength || 0)
    const start = Math.max(line.startOffset || 0, 0)
    const end = Math.max(total - Math.max(line.endOffset || 0, 0), 0)
    if (step > 0) {
      for (let distance = start; distance <= end; distance += step) {
        addSymbol(line.dashSymbol, distance)
      }
    } else if (line.showAtLeastOneSymbol) {
      addSymbol(line.dashSymbol, total / 2)
    }
  }

  if (line.startSymbol) {
    const angle = lineAngleStart(coords)
    const start = transform(coords[0])
    const svg = xmapPointSymbolToSvg(
      line.startSymbol,
      start[0],
      start[1],
      colors,
      coord => coord,
      line.startSymbol.pointSymbol?.rotatable ? angle : 0
    )
    if (svg) rendered.push(svg)
  }

  if (line.endSymbol) {
    const angle = lineAngleEnd(coords)
    const end = transform(coords[coords.length - 1])
    const svg = xmapPointSymbolToSvg(
      line.endSymbol,
      end[0],
      end[1],
      colors,
      coord => coord,
      line.endSymbol.pointSymbol?.rotatable ? angle : 0
    )
    if (svg) rendered.push(svg)
  }

  return rendered.join('')
}

function xmapPointSymbolToSvg(
  symbol,
  x,
  y,
  colors,
  transform = coord => coord,
  rotation = 0
) {
  const anchor = transform([x, y])
  const parts: string[] = []
  const pointSymbol = symbol.pointSymbol

  if (pointSymbol) {
    if (
      isValidColorId(pointSymbol.innerColor) &&
      pointSymbol.innerRadius > 0
    ) {
      parts.push(
        `<circle cx="${anchor[0]}" cy="${anchor[1]}" r="${pointSymbol.innerRadius}" fill="${escapeAttr(
          getColor({ colorId: pointSymbol.innerColor }, colors)
        )}" />`
      )
    }
    if (
      isValidColorId(pointSymbol.outerColor) &&
      pointSymbol.outerWidth > 0 &&
      pointSymbol.innerRadius > 0
    ) {
      parts.push(
        `<circle cx="${anchor[0]}" cy="${anchor[1]}" r="${pointSymbol.innerRadius}" fill="none" stroke="${escapeAttr(
          getColor({ colorId: pointSymbol.outerColor }, colors)
        )}" stroke-width="${pointSymbol.outerWidth}" />`
      )
    }
    ;(pointSymbol.elements || []).forEach(element => {
      const svg = pointElementToSvg(element, [x, y], colors, transform)
      if (svg) parts.push(svg)
    })
  }

  const content = parts.join('')
  if (!content || !rotation) return content
  return `<g transform="rotate(${(rotation * 180) / Math.PI} ${anchor[0]} ${anchor[1]})">${content}</g>`
}

function lineElementsLayerToSvg(object, layer, colors, transform) {
  const coords = object.coordinates || []
  if (coords.length < 2) return null

  const rendered: Array<{ order: number; node: string }> = []
  const addElements = (elements, anchor, angle) => {
    if (!Array.isArray(elements)) return
    elements.forEach(element => {
      const svg = ocadPointElementToSvg(element, anchor, colors, transform, angle)
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
    layer.mainLength > 0
  ) {
    primaryLineElementPositions(coords, layer).forEach(position => {
      const point = pointAndAngleAt(coords, position)
      addElements(layer.primSymElements, [point[0], point[1]], point.angle)
    })
  }

  if (Array.isArray(layer.cornerSymElements) && layer.cornerSymElements.length) {
    for (let i = 1; i < coords.length - 1; i++) {
      const c0 = coords[i - 1]
      const c1 = coords[i]
      addElements(
        layer.cornerSymElements,
        c1,
        Math.atan2(c1[1] - c0[1], c1[0] - c0[0])
      )
    }
  }

  if (Array.isArray(layer.startSymElements) && layer.startSymElements.length) {
    const c0 = coords[0]
    const c1 = coords[1]
    addElements(
      layer.startSymElements,
      c0,
      Math.atan2(c1[1] - c0[1], c1[0] - c0[0])
    )
  }

  if (Array.isArray(layer.endSymElements) && layer.endSymElements.length) {
    const c0 = coords[coords.length - 2]
    const c1 = coords[coords.length - 1]
    addElements(
      layer.endSymElements,
      c1,
      Math.atan2(c1[1] - c0[1], c1[0] - c0[0])
    )
  }

  return rendered
}

function getElementColorOrder(element, colors) {
  return colors[element.color] ? colors[element.color].renderOrder : 0
}

function primaryLineElementPositions(coords, layer) {
  const total = pathLength(coords)
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

function doubleLineLayerToSvg(object, layer, colors, transform) {
  const coords = object.coordinates || []
  if (coords.length < 2) return null

  if (layer.mode === 2) {
    const width =
      (layer.leftWidth || 0) + (layer.centerWidth || 0) + (layer.rightWidth || 0)
    if (width <= 0) return null
    return `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
      getColor({ colorId: layer.fillColorId }, colors)
    )}" stroke-width="${width}" fill="none" />`
  }

  if (layer.mode !== 1) return null

  if (layer.flags & 1) {
    const outerWidth =
      (layer.leftWidth || 0) + (layer.centerWidth || 0) + (layer.rightWidth || 0)
    return [
      outerWidth > 0 &&
        `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
          getColor({ colorId: layer.leftColorId }, colors)
        )}" stroke-width="${outerWidth}" fill="none" />`,
      layer.centerWidth > 0 &&
        `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
          getColor({ colorId: layer.fillColorId }, colors)
        )}" stroke-width="${layer.centerWidth}" fill="none" />`,
    ]
      .filter(Boolean)
      .join('')
  }

  return [
    ...offsetLineCoordinates(
      coords,
      -(layer.centerWidth || 0) / 2 - (layer.leftWidth || 0) / 2
    ).map(lineCoords =>
      linePathToSvg(lineCoords, layer.leftWidth, layer.leftColorId, colors, transform)
    ),
    ...offsetLineCoordinates(
      coords,
      (layer.centerWidth || 0) / 2 + (layer.rightWidth || 0) / 2
    ).map(lineCoords =>
      linePathToSvg(lineCoords, layer.rightWidth, layer.rightColorId, colors, transform)
    ),
  ]
    .filter(Boolean)
    .join('')
}

function linePathToSvg(coords, width, colorId, colors, transform) {
  if (!width || width <= 0) return null
  return `<path d="${coordsToPath(coords, transform)}" stroke="${escapeAttr(
    getColor({ colorId }, colors)
  )}" stroke-width="${width}" fill="none" stroke-linejoin="bevel" stroke-linecap="butt" />`
}

function offsetLineCoordinates(coordinates, offset) {
  const result: number[][][] = []
  let current: unknown[] = []

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

function offsetLineString(coordinates, offset) {
  return lineOffset(
    {
      type: 'LineString',
      coordinates,
    },
    offset,
    { units: 'degrees' }
  ).geometry.coordinates.map(
    (coord, index) =>
      new TdPoly(
        coord[0],
        coord[1],
        coordinates[index].xFlags,
        coordinates[index].yFlags
      )
  )
}

function pointElementToSvg(
  element,
  anchor,
  colors,
  transform = coord => coord,
  angle = 0
) {
  if (element.coords) {
    return ocadPointElementToSvg(element, anchor, colors, transform, angle)
  }
  if (!element.object || !element.symbol) return null

  const coords = (element.object.coords || []).map(coord => [
    coord.x + transform(anchor)[0],
    coord.y + transform(anchor)[1],
  ])
  if (coords.length === 0) return null

  if (element.symbol.areaSymbol) {
    const fillColorId = element.symbol.areaSymbol.innerColor
    const strokeColorId =
      element.symbol.lineSymbol && element.symbol.lineSymbol.color
    const strokeWidth =
      element.symbol.lineSymbol && element.symbol.lineSymbol.lineWidth
    const fill = isValidColorId(fillColorId)
      ? ` fill="${escapeAttr(getColor({ colorId: fillColorId }, colors))}"`
      : ' fill="none"'
    const stroke =
      isValidColorId(strokeColorId) && strokeWidth > 0
        ? ` stroke="${escapeAttr(
            getColor({ colorId: strokeColorId }, colors)
          )}" stroke-width="${strokeWidth}"`
        : ''
    return `<path d="${coordsToPath(coords)} Z"${fill}${stroke} fill-rule="evenodd" />`
  }

  if (element.symbol.lineSymbol) {
    const strokeColorId = element.symbol.lineSymbol.color
    const strokeWidth = element.symbol.lineSymbol.lineWidth
    if (!isValidColorId(strokeColorId) || strokeWidth <= 0) return null
    return `<path d="${coordsToPath(coords)}" stroke="${escapeAttr(
      getColor({ colorId: strokeColorId }, colors)
    )}" stroke-width="${strokeWidth}" fill="none" />`
  }

  if (element.symbol.pointSymbol) {
    const nestedCoord = coords[0]
    const pointSymbol = element.symbol.pointSymbol
    return [
      isValidColorId(pointSymbol.innerColor) &&
        pointSymbol.innerRadius > 0 &&
        `<circle cx="${nestedCoord[0]}" cy="${nestedCoord[1]}" r="${pointSymbol.innerRadius}" fill="${escapeAttr(
          getColor({ colorId: pointSymbol.innerColor }, colors)
        )}" />`,
      isValidColorId(pointSymbol.outerColor) &&
        pointSymbol.outerWidth > 0 &&
        pointSymbol.innerRadius > 0 &&
        `<circle cx="${nestedCoord[0]}" cy="${nestedCoord[1]}" r="${pointSymbol.innerRadius}" fill="none" stroke="${escapeAttr(
          getColor({ colorId: pointSymbol.outerColor }, colors)
        )}" stroke-width="${pointSymbol.outerWidth}" />`,
    ]
      .filter(Boolean)
      .join('')
  }

  return null
}

function ocadPointElementToSvg(element, anchor, colors, transform, angle = 0) {
  const coords = (element.coords || []).map(coord =>
    transform(addRotatedCoord(anchor, coord, angle))
  )

  switch (element.type) {
    case LineElementType:
      if (!element.lineWidth) return null
      return `<path d="${coordsToPath(coords)}" stroke="${escapeAttr(
        getColor({ colorId: element.color }, colors)
      )}" stroke-width="${element.lineWidth}" fill="none" stroke-linejoin="bevel" stroke-linecap="butt"${dashToSvg(
        element
      ) ? ` stroke-dasharray="${dashToSvg(element)}"` : ''} />`
    case AreaElementType:
      return `<path d="${coordsToPath(coords)} Z" fill="${escapeAttr(
        getColor({ colorId: element.color }, colors)
      )}" fill-rule="evenodd" />`
    case CircleElementType:
    case DotElementType: {
      const coord = transform(anchor)
      const stroke =
        element.type === CircleElementType
          ? ` fill="none" stroke="${escapeAttr(
              getColor({ colorId: element.color }, colors)
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

function addRotatedCoord(anchor, coord, angle) {
  if (!angle) return [coord[0] + anchor[0], coord[1] + anchor[1]]

  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    anchor[0] + coord[0] * cos - coord[1] * sin,
    anchor[1] + coord[0] * sin + coord[1] * cos,
  ]
}

function textLayerToSvg(object, layer, colors, transform) {
  const coord = object.coordinates[0] && transform(object.coordinates[0])
  if (!coord || !object.text) return null

  return `<text x="${coord[0]}" y="${coord[1]}" fill="${escapeAttr(
    getColor(layer, colors)
  )}" font-family="${escapeAttr(layer.fontFamily || 'Arial')}" font-size="${
    layer.fontSize || 12
  }"${opacityAttr(layer)}>${escapeText(object.text)}</text>`
}

function opacityAttr(layer) {
  return layer.opacity === undefined ? '' : ` opacity="${layer.opacity}"`
}

function getSymbolsById(map) {
  return map.symbols.reduce((symbols, symbol) => {
    symbols[symbol.id] = symbol
    return symbols
  }, {})
}

function getColorsById(map) {
  return map.colors.reduce((colors, color) => {
    if (color) colors[color.id] = color
    return colors
  }, {})
}

function getColor(layer, colors) {
  return colors[layer.colorId] ? colors[layer.colorId].rgb : 'rgb(0, 0, 0)'
}

/**
 * A color id can be either a numeric OCAD-style id (>= 0 means "set")
 * or a PanMap string id from a gitmap-remapped Map. Rejects
 * null / undefined / negative numbers ("no color"); accepts any
 * non-empty string.
 */
function isValidColorId(id: unknown): boolean {
  if (id === null || id === undefined) return false
  if (typeof id === 'number') return id >= 0
  if (typeof id === 'string') return id.length > 0
  return false
}

function getColorOrder(layer, colors) {
  if (colors[layer.colorId]) return colors[layer.colorId].renderOrder

  const colorIds: unknown[] = []
  if (Array.isArray(layer.elements)) {
    layer.elements.forEach(element => colorIds.push(element.color))
  }
  LINE_ELEMENT_LAYER_KEYS.forEach(key => {
    if (key === 'secSymElements') return
    if (Array.isArray(layer[key])) {
      layer[key].forEach(element => colorIds.push(element.color))
    }
  })

  const orders = colorIds
    .map(colorId => {
      const key = colorId as string | number
      return colors[key] ? colors[key].renderOrder : null
    })
    .filter(order => order !== null)

  return orders.length ? Math.max(...orders) : 0
}

const escapeText = textEscape
const escapeAttr = attrEscape

export { getMapSvgRenderSupport }
export default mapToSvg
