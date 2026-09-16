import { DOMParser, type Element as DOMElement } from '@xmldom/xmldom'
import type Panmap from '../../panmap/model.js'
import type { RenderLayer } from '../../panmap/render-layers.js'
import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import {
  getColorsById,
  getSymbolsById,
  getColorOrder,
  type ColorLookup,
} from './colors.js'
import { objectLayerToSvg } from './dispatch.js'
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
