import { DOMParser, type Element as DOMElement } from '@xmldom/xmldom'
import type Panmap from '../../panmap/model.js'
import type { MapObject } from '../../panmap/model.js'
import type {
  RenderLayer,
  StrokeLayer,
  LineElementsLayer,
  DoubleLineLayer,
  LineSymbolsLayer,
  HatchLayer,
  StructureLayer,
  PointPatternLayer,
  BorderSymbolLayer,
  TextLayer,
} from '../../panmap/render-layers.js'
import type { FlaggedCoord } from '../../panmap/coord.js'
import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import { coordsToPath, type Transform } from './path.js'
import { dashToSvg, lineJoinToSvg, lineCapToSvg } from './style.js'
import {
  getColor,
  getColorsById,
  getSymbolsById,
  getColorOrder,
  orderFor,
  opacityAttr,
  isValidColorId,
  type ColorLookup,
  type SymbolLookup,
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
  object: MapObject,
  layer: RenderLayer,
  colors: ColorLookup,
  defs: string[],
  patternIndex: number,
  transform: Transform,
  symbols: SymbolLookup = {},
): string | null | Array<{ order: number; node: string }> {
  switch (object.type) {
    case 'line': {
      if (layer.type === 'line-elements') {
        return lineElementsLayerToSvg(
          object,
          layer as LineElementsLayer,
          colors,
          transform,
        )
      }
      if (layer.type === 'double-line') {
        return doubleLineLayerToSvg(
          object,
          layer as DoubleLineLayer,
          colors,
          transform,
        )
      }
      if (layer.type === 'line-symbols') {
        return lineSymbolsLayerToSvg(
          object,
          layer as LineSymbolsLayer,
          colors,
          transform,
        )
      }
      if (layer.type !== 'stroke') return null
      const strokeLayer = layer as StrokeLayer
      // colorId = -1 (or otherwise unresolvable) marks the layer as
      // deliberately invisible — a composition slot for borders / line-
      // symbols to hang off. Rendering it as a black stroke turned
      // symbol 309 (narrow marsh) into a fat black line.
      const hasMainColor = isValidColorId(strokeLayer.colorId)
      const dashArray = dashToSvg(strokeLayer.dash)
      const d = coordsToPath(object.coordinates as FlaggedCoord[], transform)
      const mainNode = hasMainColor
        ? `<path d="${d}" stroke="${escapeAttr(
            getColor(strokeLayer, colors),
          )}" stroke-width="${strokeLayer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
            strokeLayer,
          )}" stroke-linecap="${lineCapToSvg(strokeLayer)}"${opacityAttr(strokeLayer)}${
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
        Array.isArray(strokeLayer.borders) && hasMainColor
          ? strokeLayer.borders
          : []
      if (!borders.length) return mainNode
      const bordersOut: Array<{ order: number; node: string }> = (
        borders as unknown[]
      )
        .map((b: any) => {
          if (!b || !isValidColorId(b.color) || !(b.width > 0)) return null
          const mainW = Number(strokeLayer.width) || 0
          const shift = Number(b.shift) || 0
          const bw = Number(b.width) || 0
          const outerWidth = mainW + 2 * shift + 2 * bw
          const bDash =
            b.dashed && b.dashLength > 0
              ? `${b.dashLength} ${b.breakLength || b.dashLength}`
              : null
          return {
            order: orderFor(b.color, strokeLayer, colors),
            node: `<path d="${d}" stroke="${escapeAttr(
              getColor({ colorId: b.color }, colors),
            )}" stroke-width="${outerWidth}" fill="none" stroke-linejoin="${lineJoinToSvg(
              strokeLayer,
            )}" stroke-linecap="${lineCapToSvg(strokeLayer)}"${
              bDash ? ` stroke-dasharray="${bDash}"` : ''
            } />`,
          }
        })
        .filter(Boolean) as Array<{ order: number; node: string }>
      return mainNode
        ? [
            ...bordersOut,
            { order: getColorOrder(strokeLayer, colors), node: mainNode },
          ]
        : bordersOut
    }
    case 'area':
      if (layer.type === 'stroke') {
        const strokeLayer = layer as StrokeLayer
        if (!isValidColorId(strokeLayer.colorId)) return null
        const dashArray = dashToSvg(strokeLayer.dash)
        return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" stroke="${escapeAttr(
          getColor(strokeLayer, colors),
        )}" stroke-width="${strokeLayer.width}" fill="none" stroke-linejoin="${lineJoinToSvg(
          strokeLayer,
        )}" stroke-linecap="${lineCapToSvg(strokeLayer)}"${
          dashArray ? ` stroke-dasharray="${dashArray}"` : ''
        }${opacityAttr(strokeLayer)} />`
      }
      if (layer.type === 'hatch-fill') {
        const id = `map-hatch-${patternIndex}`
        defs.push(hatchPatternToSvg(id, layer as HatchLayer, colors))
        return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(layer)} />`
      }
      if (layer.type === 'structure-fill') {
        const id = `map-structure-${patternIndex}`
        defs.push(structurePatternToSvg(id, layer as StructureLayer, colors))
        return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(layer)} />`
      }
      if (layer.type === 'point-pattern-fill') {
        const id = `map-point-pattern-${patternIndex}`
        defs.push(pointPatternToSvg(id, layer as PointPatternLayer, colors))
        return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(layer)} />`
      }
      if (layer.type === 'border-symbol') {
        const borderSymbol =
          symbols[(layer as BorderSymbolLayer).symbolId as string | number]
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
      return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" fill="${escapeAttr(
        getColor(layer, colors),
      )}" fill-rule="evenodd"${opacityAttr(layer)} />`
    case 'point':
      return pointLayerToSvg(object, layer, colors, transform)
    case 'text':
    case 'line-text':
      if (layer.type !== 'text') return null
      return textLayerToSvg(object, layer as TextLayer, colors, transform)
    default:
      return null
  }
}

function renderedLayerEntries(
  rendered: string | null | Array<{ order?: number; node: string }>,
  layer: RenderLayer,
  colors: ColorLookup,
): Array<{ order: number; node: string }> {
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
