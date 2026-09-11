import { DOMParser, type Element as DOMElement } from '@xmldom/xmldom'
import type Panmap from '../../panmap/model.js'
import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import { coordsToPath } from './path.js'
import { dashToSvg, lineJoinToSvg, lineCapToSvg } from './style.js'
import {
  getColor,
  getColorsById,
  getSymbolsById,
  getColorOrder,
  orderFor,
  opacityAttr,
  isValidColorId,
} from './colors.js'
import {
  lineElementsLayerToSvg,
  doubleLineLayerToSvg,
  lineSymbolsLayerToSvg,
} from './line-render.js'
import {
  hatchPatternToSvg,
  structurePatternToSvg,
  pointPatternToSvg,
} from './fills.js'
import { pointLayerToSvg } from './point-symbols.js'
import { textLayerToSvg } from './text-render.js'
import { getMapSvgRenderSupport } from './support.js'

export interface MapToSvgOptions {
  coordinateTransform?: (coord: number[]) => number[]
  backgroundColor?: string
  fromColor?: number
  toColor?: number
  // Override the SVG viewBox / width / height. Useful when rendering
  // a diff and overlaying it on the full "after" render — without
  // this override the diff's viewBox shrinks to just the changed
  // region, breaking alignment.
  bounds?: [number, number, number, number]
}

/**
 * Render a `Panmap` object to SVG.
 *
 * Simple symbols are rendered directly from source-independent `layers`.
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
    // The model is canonical y-down, same as SVG screen space — no coordinate
    // flip is ever needed (OCAD's y-up is negated at read time).
    coordinateTransform: options.coordinateTransform || undefined,
  })
}

function renderDirectly(
  map: Panmap,
  options: MapToSvgOptions = {},
): DOMElement {
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
    const layers = symbol.layers || []
    layers.forEach(layer => {
      const rendered = objectLayerToSvg(
        object,
        layer,
        colors,
        defs,
        patternId++,
        transformCoord,
        symbols,
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
        (options.toColor == null || node.order <= options.toColor),
    )
    .sort((a, b) => b.order - a.order || a.sequence - b.sequence)
  const background = options.backgroundColor
    ? `<rect x="${bounds[0]}" y="${bounds[1]}" width="${width}" height="${height}" fill="${escapeAttr(
        options.backgroundColor,
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
  const parsed = new DOMParser().parseFromString(
    svg,
    'image/svg+xml',
  ).documentElement
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
  symbols = {},
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
      const mainNode = hasMainColor
        ? `<path d="${d}" stroke="${escapeAttr(
            getColor(layer, colors),
          )}" stroke-width="${layer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
            layer,
          )}" stroke-linecap="${lineCapToSvg(layer)}"${opacityAttr(layer)}${
            dashArray ? ` stroke-dasharray="${dashArray}"` : ''
          } />`
        : null

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
      const borders =
        Array.isArray(layer.borders) && hasMainColor ? layer.borders : []
      if (!borders.length) return mainNode
      const bordersOut: Array<{ order: number; node: string }> = (
        borders as unknown[]
      )
        .map((b: any) => {
          if (!b || !isValidColorId(b.color) || !(b.width > 0)) return null
          const mainW = Number(layer.width) || 0
          const shift = Number(b.shift) || 0
          const bw = Number(b.width) || 0
          const outerWidth = mainW + 2 * shift + 2 * bw
          const bDash =
            b.dashed && b.dashLength > 0
              ? `${b.dashLength} ${b.breakLength || b.dashLength}`
              : null
          return {
            order: orderFor(b.color, layer, colors),
            node: `<path d="${d}" stroke="${escapeAttr(
              getColor({ colorId: b.color }, colors),
            )}" stroke-width="${outerWidth}" fill="none" stroke-linejoin="${lineJoinToSvg(
              layer,
            )}" stroke-linecap="${lineCapToSvg(layer)}"${
              bDash ? ` stroke-dasharray="${bDash}"` : ''
            } />`,
          }
        })
        .filter(Boolean) as Array<{ order: number; node: string }>
      return mainNode
        ? [
            ...bordersOut,
            { order: getColorOrder(layer, colors), node: mainNode },
          ]
        : bordersOut
    }
    case 'area':
      if (layer.type === 'stroke') {
        if (!isValidColorId(layer.colorId)) return null
        const dashArray = dashToSvg(layer.dash)
        return `<path d="${coordsToPath(object.coordinates, transform)} Z" stroke="${escapeAttr(
          getColor(layer, colors),
        )}" stroke-width="${layer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
          layer,
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
        return (borderSymbol.layers || [])
          .map(borderLayer =>
            objectLayerToSvg(
              lineObject,
              borderLayer,
              colors,
              defs,
              patternIndex,
              transform,
              symbols,
            ),
          )
          .filter(Boolean)
          .join('')
      }
      if (layer.type !== 'fill') return null
      return `<path d="${coordsToPath(object.coordinates, transform)} Z" fill="${escapeAttr(
        getColor(layer, colors),
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
          entry.order !== undefined
            ? entry.order
            : getColorOrder(layer, colors),
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

export { getMapSvgRenderSupport }
export type { UnsupportedRenderReason, MapSvgRenderSupport } from './support.js'
export default mapToSvg
