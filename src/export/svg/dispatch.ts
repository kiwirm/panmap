// Data-driven dispatch for the SVG renderer. The object-type × layer-type
// matrix lives here ONCE, in `OBJECT_LAYER_RENDERERS`, and BOTH consumers
// derive from it — the render path (`objectLayerToSvg`, used by index.ts) and
// the pre-flight support report (`canRenderObjectLayer` / `supportedLayerTypes`,
// used by support.ts). Encoding it once is what stops the two from silently
// drifting apart.
//
// Import direction is strictly one-way to stay acyclic: this module imports the
// leaf render helpers (line-render, fills, point-symbols, text-render, colors,
// path, style); none of those import this module. index.ts imports this module
// and support.ts; support.ts imports this module.

import type { MapObject } from '../../panmap/model.js'
import type {
  RenderLayer,
  StrokeLayer,
  LineElementsLayer,
  DoubleLineLayer,
  HatchLayer,
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
  getColorOrder,
  orderFor,
  opacityAttr,
  isValidColorId,
  type ColorLookup,
  type SymbolLookup,
} from './colors.js'
import { lineElementsLayerToSvg, doubleLineLayerToSvg } from './line-render.js'
import { hatchPatternToSvg, pointPatternToSvg } from './fills.js'
import { pointLayerToSvg } from './point-symbols.js'
import { textLayerToSvg } from './text-render.js'

/** Everything a per-layer renderer needs to emit its SVG for one object. */
export interface LayerRenderContext {
  object: MapObject
  layer: RenderLayer
  colors: ColorLookup
  defs: string[]
  patternIndex: number
  transform: Transform
  symbols: SymbolLookup
}

/**
 * A renderer for one (objectType, layerType) cell. Returns either an SVG
 * string, `null` when nothing paints, or an array of `{ order, node }`
 * primitives that the caller z-sorts by colour priority.
 */
export type LayerRenderFn = (
  ctx: LayerRenderContext,
) => string | null | Array<{ order: number; node: string }>

// --- line ------------------------------------------------------------------

// line/stroke — the primary stroke plus any parallel border strokes.
const lineStrokeToSvg: LayerRenderFn = ctx => {
  const { object, colors, transform } = ctx
  const strokeLayer = ctx.layer as StrokeLayer
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

// --- area ------------------------------------------------------------------

// area/fill — solid polygon fill.
const areaFillToSvg: LayerRenderFn = ctx => {
  const { object, colors, transform } = ctx
  return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" fill="${escapeAttr(
    getColor(ctx.layer, colors),
  )}" fill-rule="evenodd"${opacityAttr(ctx.layer)} />`
}

// area/stroke — polygon outline.
const areaStrokeToSvg: LayerRenderFn = ctx => {
  const { object, colors, transform } = ctx
  const strokeLayer = ctx.layer as StrokeLayer
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

// area/hatch-fill — hatch pattern registered in <defs>.
const areaHatchToSvg: LayerRenderFn = ctx => {
  const { object, colors, defs, patternIndex, transform } = ctx
  const id = `map-hatch-${patternIndex}`
  defs.push(hatchPatternToSvg(id, ctx.layer as HatchLayer, colors))
  return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(ctx.layer)} />`
}

// area/point-pattern-fill — point pattern registered in <defs>.
const areaPointPatternToSvg: LayerRenderFn = ctx => {
  const { object, colors, defs, patternIndex, transform } = ctx
  const id = `map-point-pattern-${patternIndex}`
  defs.push(pointPatternToSvg(id, ctx.layer as PointPatternLayer, colors))
  return `<path d="${coordsToPath(object.coordinates as FlaggedCoord[], transform)} Z" fill="url(#${id})" fill-rule="evenodd"${opacityAttr(ctx.layer)} />`
}

// area/border-symbol — render the referenced line symbol along the area's
// boundary by recursing with the object treated as a line.
const areaBorderSymbolToSvg: LayerRenderFn = ctx => {
  const { object, colors, defs, patternIndex, transform, symbols } = ctx
  const borderSymbol =
    symbols[(ctx.layer as BorderSymbolLayer).symbolId as string | number]
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

// --- point / text (delegate to their leaf renderers) -----------------------

const pointToSvg: LayerRenderFn = ctx =>
  pointLayerToSvg(ctx.object, ctx.layer, ctx.colors, ctx.transform)

const textToSvg: LayerRenderFn = ctx =>
  textLayerToSvg(ctx.object, ctx.layer as TextLayer, ctx.colors, ctx.transform)

/**
 * The single source of truth for the object-type × layer-type render matrix.
 * One entry per (objectType, layerType) cell that renders. Delegating cells
 * wrap the existing leaf helpers; the rest extract the formerly-inline blocks.
 */
export const OBJECT_LAYER_RENDERERS: Record<
  string,
  Partial<Record<string, LayerRenderFn>>
> = {
  line: {
    stroke: lineStrokeToSvg,
    'line-elements': ctx =>
      lineElementsLayerToSvg(
        ctx.object,
        ctx.layer as LineElementsLayer,
        ctx.colors,
        ctx.transform,
      ),
    'double-line': ctx =>
      doubleLineLayerToSvg(
        ctx.object,
        ctx.layer as DoubleLineLayer,
        ctx.colors,
        ctx.transform,
      ),
  },
  area: {
    fill: areaFillToSvg,
    stroke: areaStrokeToSvg,
    'hatch-fill': areaHatchToSvg,
    'point-pattern-fill': areaPointPatternToSvg,
    'border-symbol': areaBorderSymbolToSvg,
  },
  point: {
    'point-fill': pointToSvg,
    'point-stroke': pointToSvg,
    'point-elements': pointToSvg,
  },
  text: {
    text: textToSvg,
  },
  'line-text': {
    text: textToSvg,
  },
}

/**
 * Render one layer of one object to SVG, dispatched through
 * `OBJECT_LAYER_RENDERERS`. Same parameter list and return type as the former
 * inline switch, so index.ts callers are unchanged.
 */
export function objectLayerToSvg(
  object: MapObject,
  layer: RenderLayer,
  colors: ColorLookup,
  defs: string[],
  patternIndex: number,
  transform: Transform,
  symbols: SymbolLookup = {},
): string | null | Array<{ order: number; node: string }> {
  const ctx: LayerRenderContext = {
    object,
    layer,
    colors,
    defs,
    patternIndex,
    transform,
    symbols,
  }
  return OBJECT_LAYER_RENDERERS[object.type]?.[layer.type]?.(ctx) ?? null
}

/** Whether the matrix has a renderer for this object-type × layer-type cell. */
export function canRenderObjectLayer(
  object: MapObject,
  layer: RenderLayer,
): boolean {
  return !!OBJECT_LAYER_RENDERERS[object.type]?.[layer.type]
}

/**
 * Every layer type that some object type can render, derived from the union of
 * layer-type keys across the matrix — never a separate hardcoded list.
 */
export const supportedLayerTypes: Set<string> = new Set(
  Object.values(OBJECT_LAYER_RENDERERS).flatMap(byLayer =>
    Object.keys(byLayer),
  ),
)
