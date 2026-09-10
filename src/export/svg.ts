import { DOMParser, type Element as DOMElement } from '@xmldom/xmldom'
import type Panmap from '../map/model.js'
import lineOffset from '@turf/line-offset'
import TdPoly from '../formats/ocad/read/td-poly.js'
import {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} from '../formats/ocad/read/symbol-element-types.js'
import { isFirstHolePoint, LINE_ELEMENT_LAYER_KEYS } from '../map/coord.js'
import { needsYFlip } from '../formats/codecs/index.js'
import { escapeXmlAttr as attrEscape, escapeXmlText as textEscape } from '../util/xml.js'
import {
  coordsToPath,
  buildPathSampler,
  pointAndAngleAtSampler,
  lineAngleStartSampler,
  lineAngleEndSampler,
} from './svg/path.js'
import { dashToSvg, lineJoinToSvg, lineCapToSvg } from './svg/style.js'
import { cmykFractionToRgb } from '../cmyk-to-rgb.js'

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
 * Render a `Panmap` object to SVG.
 *
 * Simple symbols are rendered directly from source-independent `renderLayers`.
 * More complex normalized maps are handled by shared SVG renderers that can use
 * retained source metadata while the render-layer model grows.
 */
function mapToSvg(map: Panmap, options: MapToSvgOptions = {}): DOMElement {
  // `renderDirectly` already tolerates individual unsupported objects
  // (missing symbols, layers whose type doesn't fit the object, etc. —
  // it just skips them). Gating the whole render on
  // `getMapSvgRenderSupport(map).direct` used to hard-error a map with
  // even one orphaned object — e.g. maerewhenua carrying 8k lines
  // pointed at symbol `-3` (Mapper's "undefined" sentinel for objects
  // whose symbol was deleted). Callers who want the pre-flight report
  // can still call `getMapSvgRenderSupport` directly.
  return renderDirectly(map, {
    ...options,
    coordinateTransform:
      options.coordinateTransform || getVisualCoordinateTransform(map) || undefined,
  })
}

function getVisualCoordinateTransform(map) {
  if (needsYFlip(map.sourceFormat, 'svg')) return coord => [coord[0], -coord[1]]

  if (map.sourceFormat !== 'diff') return null

  const sourceFile = map.sourceFile || {}
  if (
    sourceFile.before &&
    sourceFile.after &&
    needsYFlip(sourceFile.before.sourceFormat, 'svg') &&
    needsYFlip(sourceFile.after.sourceFormat, 'svg')
  ) {
    return coord => [coord[0], -coord[1]]
  }

  return null
}

/**
 * Reports whether a map can be rendered directly from Panmap render layers.
 */
function getMapSvgRenderSupport(map: Panmap): MapSvgRenderSupport {
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

function renderDirectly(map: Panmap, options: MapToSvgOptions = {}): DOMElement {
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
      // colorId = -1 (or otherwise unresolvable) marks the layer as
      // deliberately invisible — a composition slot for borders / line-
      // symbols to hang off. Rendering it as a black stroke turned
      // symbol 309 (narrow marsh) into a fat black line.
      const hasMainColor = isValidColorId(layer.colorId)
      const dashArray = dashToSvg(layer.dash)
      const d = coordsToPath(object.coordinates, transform)
      const mainNode = hasMainColor ? `<path d="${d}" stroke="${escapeAttr(
        getColor(layer, colors)
      )}" stroke-width="${layer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
        layer
      )}" stroke-linecap="${lineCapToSvg(layer)}"${opacityAttr(layer)}${
        dashArray ? ` stroke-dasharray="${dashArray}"` : ''
      } />` : null

      // Borders: parallel offsets on each side of the main stroke.
      // Mapper stores each border's `width` (its own thickness) and
      // `shift` (gap from the main line's edge). Emit ONE stroke per
      // border at width `mainWidth + 2*(shift + bw)` in the border's
      // colour; the main draws over the centre by paint priority,
      // leaving just the outer fringe visible.
      //
      // If the main-line is invisible (colorId=-1, composite line
      // symbols like ISOM 511.1 power line) the wider-stroke trick has
      // nothing to cover it up and the border reads as one fat solid
      // stroke. Proper rendering would emit two parallel-offset rails
      // — but the offset helper doesn't understand bezier control
      // coords yet, so it scribbles on curves. Skip borders for
      // composite lines until that helper grows bezier support.
      const borders = Array.isArray(layer.borders) && hasMainColor
        ? layer.borders
        : []
      if (!borders.length) return mainNode
      const bordersOut: Array<{order: number; node: string}> = (borders as unknown[])
        .map((b: any) => {
          if (!b || !isValidColorId(b.color) || !(b.width > 0)) return null
          const mainW = Number(layer.width) || 0
          const shift = Number(b.shift) || 0
          const bw = Number(b.width) || 0
          const outerWidth = mainW + 2 * shift + 2 * bw
          const bDash = b.dashed && b.dashLength > 0
            ? `${b.dashLength} ${b.breakLength || b.dashLength}` : null
          return {
            order: orderFor(b.color, layer, colors),
            node: `<path d="${d}" stroke="${escapeAttr(
              getColor({ colorId: b.color }, colors)
            )}" stroke-width="${outerWidth}" fill="none" stroke-linejoin="${lineJoinToSvg(
              layer
            )}" stroke-linecap="${lineCapToSvg(layer)}"${
              bDash ? ` stroke-dasharray="${bDash}"` : ''
            } />`,
          }
        })
        .filter(Boolean) as Array<{order: number; node: string}>
      return mainNode
        ? [...bordersOut, { order: getColorOrder(layer, colors), node: mainNode }]
        : bordersOut
    }
    case 'area':
      if (layer.type === 'stroke') {
        if (!isValidColorId(layer.colorId)) return null
        const dashArray = dashToSvg(layer.dash)
        return `<path d="${coordsToPath(object.coordinates, transform)} Z" stroke="${escapeAttr(
          getColor(layer, colors)
        )}" stroke-width="${layer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
          layer
        )}" stroke-linecap="${lineCapToSvg(layer)}"${
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
    // Flatten each source element to its emitted primitives, then
    // tag each primitive with its OWN colour's render order so the
    // top-level SVG sort paints them in Mapper's colour-priority
    // order (not the source-order of elements within the symbol).
    // Object rotation is radians in the source-format's y-up frame;
    // negate for the y-down coord space we render into (see textLayerToSvg).
    return (layer.elements || []).flatMap(element =>
      pointElementToSvg(element, rawCoord, colors, transform, -(object.rotation || 0))
        .map(({ colorId, node }) => ({
          order: orderFor(colorId, layer, colors),
          node,
        }))
    )
  }

  return null
}

function lineSymbolsLayerToSvg(object, layer, colors, transform) {
  const line = layer.lineSymbol
  const coords = object.coordinates || []
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
  const addSymbol = (symbol, distance, rotatable = true) => {
    if (!symbol) return
    const point = pointAndAngleAtSampler(sampler, Math.max(0, Math.min(total, distance)))
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
    symbol: unknown,
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
      line.midSymbol,
      line.midSymbolDistance || line.segmentLength || 0,
      0,
      0,
      line.minimumMidSymbolCount || 0,
      line.showAtLeastOneSymbol !== false,
    )
  }

  if (line.dashSymbol) {
    placeAlong(
      line.dashSymbol,
      line.segmentLength || (line.dashLength || 0) + (line.breakLength || 0),
      Math.max(line.startOffset || 0, 0),
      Math.max(line.endOffset || 0, 0),
      0,
      !!line.showAtLeastOneSymbol,
    )
  }

  if (line.startSymbol) {
    const angle = lineAngleStartSampler(sampler)
    const start = transform(coords[0])
    const primitives = xmapPointSymbolToSvg(
      line.startSymbol,
      start[0],
      start[1],
      colors,
      coord => coord,
      line.startSymbol.pointSymbol?.rotatable ? angle : 0,
    )
    for (const { colorId, node } of primitives) {
      rendered.push({
        order: orderFor(colorId, layer, colors),
        node,
      })
    }
  }

  if (line.endSymbol) {
    const angle = lineAngleEndSampler(sampler)
    const end = transform(coords[coords.length - 1])
    const primitives = xmapPointSymbolToSvg(
      line.endSymbol,
      end[0],
      end[1],
      colors,
      coord => coord,
      line.endSymbol.pointSymbol?.rotatable ? angle : 0,
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

// Emit one xmap point symbol placement (used by line-symbol mid/dash/
// start/end placements) as a list of {colorId, node} primitives — same
// shape as pointElementToSvg — so callers can hand them to the top-level
// SVG sort at each primitive's own colour priority instead of forcing
// the whole group into one order. Rotation is baked into element coords
// rather than wrapping in an SVG group.
function xmapPointSymbolToSvg(
  symbol,
  x,
  y,
  colors,
  transform = coord => coord,
  rotation = 0,
): Array<{ colorId: any; node: string }> {
  const anchor = transform([x, y])
  const out: Array<{ colorId: any; node: string }> = []
  const pointSymbol = symbol.pointSymbol
  if (!pointSymbol) return out

  if (isValidColorId(pointSymbol.innerColor) && pointSymbol.innerRadius > 0) {
    out.push({
      colorId: pointSymbol.innerColor,
      node: `<circle cx="${anchor[0]}" cy="${anchor[1]}" r="${pointSymbol.innerRadius}" fill="${escapeAttr(
        getColor({ colorId: pointSymbol.innerColor }, colors),
      )}" />`,
    })
  }
  if (
    isValidColorId(pointSymbol.outerColor) &&
    pointSymbol.outerWidth > 0 &&
    pointSymbol.innerRadius > 0
  ) {
    // Mapper draws the outer ring OUTWARD from `innerRadius`: its inner
    // edge sits at `innerRadius` and its outer edge at
    // `innerRadius + outerWidth`. An SVG stroke is centred on its path
    // radius, so centre the stroke at `innerRadius + outerWidth/2` to
    // match. Centring on `innerRadius` (previous) let a fat ring reach
    // inward and overpaint the inner fill (e.g. 418 with r=10, w=30
    // hid the r=10 white centre).
    out.push({
      colorId: pointSymbol.outerColor,
      node: `<circle cx="${anchor[0]}" cy="${anchor[1]}" r="${pointSymbol.innerRadius + pointSymbol.outerWidth / 2}" fill="none" stroke="${escapeAttr(
        getColor({ colorId: pointSymbol.outerColor }, colors),
      )}" stroke-width="${pointSymbol.outerWidth}" />`,
    })
  }
  for (const element of pointSymbol.elements || []) {
    out.push(...pointElementToSvg(element, [x, y], colors, transform, rotation))
  }
  return out
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
    const sampler = buildPathSampler(coords)
    primaryLineElementPositions(sampler, layer).forEach(position => {
      const point = pointAndAngleAtSampler(sampler, position)
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

function primaryLineElementPositions(sampler, layer) {
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

// Returns an array of {colorId, node} entries — one per emitted SVG
// primitive. The caller expands these into per-color-ordered nodes so
// composite point elements (ISOM 417 tree = green ring + white
// cutout, 419 special veg = green X + white halo, etc.) paint in
// COLOR order instead of source order. Concatenating them into a
// single string here would force all sub-primitives to share the
// containing layer's render order, and Mapper's own convention is that
// each colour draws at its own priority level.
function pointElementToSvg(
  element,
  anchor,
  colors,
  transform = coord => coord,
  angle = 0
): Array<{ colorId: any; node: string }> {
  if (element.coords) {
    // OCAD-style element (already flat, single colour).
    const node = ocadPointElementToSvg(element, anchor, colors, transform, angle)
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
    const out: Array<{ colorId: any; node: string }> = []
    if (isValidColorId(fillColorId)) {
      out.push({
        colorId: fillColorId,
        node: `<path d="${coordsToPath(coords)} Z" fill="${escapeAttr(
          getColor({ colorId: fillColorId }, colors),
        )}" fill-rule="evenodd" />`,
      })
    }
    if (isValidColorId(strokeColorId) && strokeWidth > 0) {
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
    if (!isValidColorId(strokeColorId) || strokeWidth <= 0) return []
    return [{
      colorId: strokeColorId,
      node: `<path d="${coordsToPath(coords)}" stroke="${escapeAttr(
        getColor({ colorId: strokeColorId }, colors),
      )}" stroke-width="${strokeWidth}" fill="none" />`,
    }]
  }

  if (element.symbol.pointSymbol) {
    const nestedCoord = coords[0]
    const pointSymbol = element.symbol.pointSymbol
    const out: Array<{ colorId: any; node: string }> = []
    if (isValidColorId(pointSymbol.innerColor) && pointSymbol.innerRadius > 0) {
      out.push({
        colorId: pointSymbol.innerColor,
        node: `<circle cx="${nestedCoord[0]}" cy="${nestedCoord[1]}" r="${pointSymbol.innerRadius}" fill="${escapeAttr(
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
        node: `<circle cx="${nestedCoord[0]}" cy="${nestedCoord[1]}" r="${pointSymbol.innerRadius}" fill="none" stroke="${escapeAttr(
          getColor({ colorId: pointSymbol.outerColor }, colors),
        )}" stroke-width="${pointSymbol.outerWidth}" />`,
      })
    }
    return out
  }

  return []
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

  // Object rotation is stored in radians, positive CCW in the source
  // format's y-up frame (OMAP + OCAD both). SVG's y-axis points DOWN,
  // so its `rotate()` is positive CW visually — apply the axis flip
  // by negating before converting to degrees.
  const rotation = object.rotation || 0
  const transformAttr = rotation
    ? ` transform="rotate(${(-rotation * 180) / Math.PI} ${coord[0]} ${coord[1]})"`
    : ''

  // Internal fontSize is millimetres. Map coordinates in the SVG
  // viewBox are 0.01mm units (100 units = 1mm). Multiply by 100 so
  // text renders at its true physical size relative to the map.
  const fontSize = ((layer.fontSize as number) || 0.12) * 100

  // Mapper text alignment: hAlign 0=left, 1=center, 2=right; vAlign
  // 0=baseline, 1=top, 2=middle, 3=bottom. Map to SVG text-anchor +
  // dominant-baseline so the anchor point sits where Mapper places it.
  const hAlign = (object as any).hAlign
  const vAlign = (object as any).vAlign
  const anchor = hAlign === 1 ? 'middle' : hAlign === 2 ? 'end' : 'start'
  const baseline =
    vAlign === 1 ? 'hanging' :
    vAlign === 2 ? 'central' :
    vAlign === 3 ? 'text-after-edge' :
    'alphabetic'
  const anchorAttr = anchor !== 'start' ? ` text-anchor="${anchor}"` : ''
  const baselineAttr = baseline !== 'alphabetic' ? ` dominant-baseline="${baseline}"` : ''

  // Newlines produce real line breaks. SVG's <text> collapses white-
  // space, so multi-line labels have to be split into one <tspan> per
  // line. Each line inherits x= from the parent <text> and steps down
  // by 1em (well — dy is relative to the previous line, so first line
  // uses 0 and subsequent lines use 1em).
  const lines = String(object.text).split(/\r\n?|\n/)
  const inner = lines.length === 1
    ? escapeText(lines[0])
    : lines.map((line, i) =>
        `<tspan x="${coord[0]}"${i === 0 ? '' : ' dy="1em"'}>${escapeText(line)}</tspan>`,
      ).join('')

  return `<text x="${coord[0]}" y="${coord[1]}"${transformAttr} fill="${escapeAttr(
    getColor(layer, colors)
  )}" font-family="${escapeAttr(layer.fontFamily || 'Arial')}" font-size="${fontSize}"${anchorAttr}${baselineAttr}${opacityAttr(layer)}>${inner}</text>`
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
    if (color) colors[color.id] = normaliseColorRgb(color)
    return colors
  }, {})
}

// Recover from source files that carry `<rgb method="custom" r=0 g=0 b=0/>`
// on a colour whose CMYK is not black. Mapper (and Purple Pen and OOM
// itself) recompute the on-screen RGB from CMYK in that case; do the
// same so a colour like "Green 45%" doesn't paint pure black just
// because the file's custom RGB slot was never populated.
const RGB_BLACK = 'rgb(0, 0, 0)'
function normaliseColorRgb(color) {
  if (color.rgb !== RGB_BLACK) return color
  const cmyk = color.cmyk
  if (!Array.isArray(cmyk) || cmyk.length < 4) return color
  const nonBlack = cmyk[0] > 0 || cmyk[1] > 0 || cmyk[2] > 0
  const notFullK = (cmyk[3] || 0) < 1
  if (!nonBlack || !notFullK) return color
  const rgb = cmykFractionToRgb(cmyk[0], cmyk[1], cmyk[2], cmyk[3])
  return { ...color, rgb: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }
}

function getColor(layer, colors) {
  return colors[layer.colorId] ? colors[layer.colorId].rgb : 'rgb(0, 0, 0)'
}

/**
 * A color id can be either a numeric OCAD-style id (>= 0 means "set")
 * or a Panmap string id from a gitmap-remapped Map. Rejects
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

/**
 * Resolve a primitive's render order. Every SVG primitive knows the
 * colour it paints in; that colour's `renderOrder` is the canonical
 * paint depth (Mapper's colour priority). When the colour isn't
 * resolvable (e.g. `colorId = -1` on an intentionally-invisible slot
 * used for composition), fall back to the containing layer's derived
 * order so the primitive at least paints somewhere sensible.
 *
 * Kept as one function so every renderer path (`pointElementToSvg`,
 * `xmapPointSymbolToSvg`, `lineSymbolsLayerToSvg`) resolves orders
 * with the exact same fallback logic — bugs like "green ring paints
 * under white halo because they were joined in one string" reduce to
 * "every primitive resolved with the same helper".
 */
function orderFor(colorId: unknown, layer, colors): number {
  const key = colorId as string | number
  if (colors[key]) return colors[key].renderOrder
  return getColorOrder(layer, colors)
}

const escapeText = textEscape
const escapeAttr = attrEscape

export { getMapSvgRenderSupport }
export default mapToSvg
