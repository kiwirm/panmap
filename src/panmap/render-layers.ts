/**
 * Shared render-layer classifiers + narrowed subtypes.
 *
 * Each format writer (OCAD synth, XMap from-map, SVG export, …) needs
 * to bucket a symbol's `layers` by layer type before it can
 * emit anything. Rather than have every writer re-implement the same
 * `.filter(l => l.type === '…')` sequence — which is where subtle
 * classification bugs tend to hide — the shared classifiers live here.
 *
 * The classifiers narrow return types to the corresponding subtype so
 * callers reading typed fields (e.g. a border layer's `symbolId`, a
 * pattern layer's `pattern.lineSpacing`) don't need `as unknown as`
 * casts. Fields still not modelled here fall through to the `[key:
 * string]: unknown` index signature inherited from `RenderLayer`.
 */
import type { BaseRenderLayer, MapSymbol } from './model.js'

/**
 * Discriminated union of all known render-layer types, plus a
 * permissive `BaseRenderLayer` fallback for `layer.type` values
 * outside the current enum. Each variant inherits BaseRenderLayer's
 * `[key: string]: unknown` index signature so format-specific extras
 * stash freely.
 *
 * To narrow to a specific variant inside code, use the type
 * predicates below (`isPatternLayer`, etc.) — a bare `layer.type ===
 * 'X'` won't rule out the BaseRenderLayer fallback.
 */
export type RenderLayer =
  | FillLayer
  | StrokeLayer
  | HatchLayer
  | PointPatternLayer
  | BorderSymbolLayer
  | DoubleLineLayer
  | LineElementsLayer
  | PointFillLayer
  | PointStrokeLayer
  | PointElementsLayer
  | TextLayer
  | BaseRenderLayer

/** True when `layer` is a tiled stamp pattern. */
export function isPatternLayer(
  layer: RenderLayer,
): layer is PointPatternLayer {
  return layer.type === 'point-pattern-fill'
}

export interface FillLayer extends BaseRenderLayer {
  type: 'fill'
}

/**
 * A single decoration primitive stashed in a layer's `elements` /
 * `*SymElements` arrays: an OCAD symbol element (flat `coords` + a
 * single `color`) or an XMap nested element (its own `object` +
 * `symbol` subtree). Only the fields the SVG exporter reads are
 * modelled; format-specific extras fall through.
 */
export interface RenderElement {
  type?: number
  color?: number | string
  lineWidth?: number
  diameter?: number
  /** OCAD-style flat coords (`[x, y]` tuples). */
  coords?: number[][]
  /** XMap-style nested object coords (`{ x, y }` objects). */
  object?: { coords?: Array<{ x: number; y: number }> }
  symbol?: DecorationSymbol
  // Dash descriptor carried by OCAD line elements (see style.ts::dashToSvg).
  dashLength?: number
  breakLength?: number
  dashesInGroup?: number
  inGroupBreakLength?: number
  mainLength?: number
  mainGap?: number
  secGap?: number
}

/** The disc + ring geometry of a point symbol, plus its nested elements. */
export interface PointSymbolSpec {
  innerColor?: number | string
  /** Radius of the inner disc, in map units (0 = no disc). */
  innerRadius: number
  outerColor?: number | string
  /** Width of the outer ring, in map units (0 = no ring). */
  outerWidth: number
  rotatable?: boolean
  elements?: RenderElement[]
}

/**
 * A point/area/line symbol nested inside a decoration — a line
 * mid/dash/start/end symbol or an area pattern's symbol. Only the
 * fields the SVG exporter reads are modelled.
 */
export interface DecorationSymbol {
  pointSymbol?: PointSymbolSpec
  areaSymbol?: { innerColor?: number | string }
  lineSymbol?: { color?: number | string; lineWidth?: number }
}

export interface DashSpec {
  dashLength?: number
  breakLength?: number
  dashesInGroup?: number
  inGroupBreakLength?: number
  /** Mapper's `half_outer_dashes` — outermost dashes drawn at half the
   *  interior length. Both readers populate this: OMap directly from
   *  the xmap flag, OCD from `endLength ≈ mainLength / 2` when there's
   *  no mid-symbol content (see `ocad/reader/to-panmap.ts:dashFromOcd`). */
  halfOuterDashes?: boolean
}

export interface StrokeLayer extends BaseRenderLayer {
  type: 'stroke'
  dash?: DashSpec
  lineStyle?: number
  capStyle?: number
  joinStyle?: number
  /** OCAD "framing" line — drawn under the primary stroke. */
  frame?: boolean
  /** Left/right stroke borders (xmap `<borders>`), each { color, lineWidth, shift, dash }. */
  borders?: unknown[]
  segmentLength?: number
  endLength?: number
  midSymbolsPerSpot?: number
  midSymbolDistance?: number
  midSymbolPlacement?: number
  minimumMidSymbolCount?: number
  minimumMidSymbolCountWhenClosed?: number
  showAtLeastOneSymbol?: boolean
  startOffset?: number
  endOffset?: number
}

export interface HatchLayer extends BaseRenderLayer {
  type: 'hatch-fill'
}

/**
 * A repeating stamp tiled across an area. `width` is the spacing along
 * a row, `height` the spacing between rows; `elements` is the stamp
 * itself, in the same flat icon-primitive shape `point-elements` and
 * `line-elements` use.
 *
 * `shiftedRows` covers the "brick bond" layout both source formats can
 * express — OCAD as one symbol with `structMode=2`, xmap as a pair of
 * `<pattern>` records offset by half a tile. Either input reduces to a
 * single layer with the flag set.
 */
export interface PointPatternLayer extends BaseRenderLayer {
  type: 'point-pattern-fill'
  /** Offset of the first row, perpendicular to the row direction. */
  rowOffset?: number
  /** Offset of the first stamp along its row. */
  columnOffset?: number
  /** Alternate rows offset by half a tile (OCAD "shifted rows"). */
  shiftedRows?: boolean
  /** Clip mode: 0 clip, 1 don't clip if fully inside, 2 if centre inside. */
  noClipping?: number
  /** Pattern rotates with the object. */
  rotatable?: boolean
  /** The stamp drawn at each grid point, as flat icon primitives. */
  elements?: RenderElement[]
}

export interface BorderSymbolLayer extends BaseRenderLayer {
  type: 'border-symbol'
  symbolId?: number | string
}

export interface DoubleLineLayer extends BaseRenderLayer {
  type: 'double-line'
  fillColorId?: number | string
  leftColorId?: number | string
  rightColorId?: number | string
  leftWidth?: number
  rightWidth?: number
  centerWidth?: number
  mode?: number
  /** OCAD double-line flag bits (bit 0 = draw as solid overprint pair). */
  flags?: number
}

export interface LineElementsLayer extends BaseRenderLayer {
  type: 'line-elements'
  /** Spacing between primary decoration placements along the line. */
  spacing?: number
  /** Reserved end-run length used to inset the first/last placement. */
  endOffset?: number
  /** Decoration elements placed at even intervals along the line. */
  primSymElements?: RenderElement[]
  /** Secondary-run decoration elements (currently unused by the renderer). */
  secSymElements?: RenderElement[]
  /** Decoration elements placed at each interior corner. */
  cornerSymElements?: RenderElement[]
  /** Decoration elements placed at the line start. */
  startSymElements?: RenderElement[]
  /** Decoration elements placed at the line end. */
  endSymElements?: RenderElement[]
}

export interface PointFillLayer extends BaseRenderLayer {
  type: 'point-fill'
}
export interface PointStrokeLayer extends BaseRenderLayer {
  type: 'point-stroke'
}
export interface PointElementsLayer extends BaseRenderLayer {
  type: 'point-elements'
}
export interface TextLayer extends BaseRenderLayer {
  type: 'text'
}

export interface AreaLayers {
  /** First `fill` layer, or undefined. Most areas have at most one. */
  fill: FillLayer | undefined
  /** All `fill` layers, in source order. */
  fills: FillLayer[]
  /** `stroke` layers — an area's outline stroke(s). */
  strokes: StrokeLayer[]
  /** `hatch-fill` layers. Two crossed layers form OCAD `hatchMode=2`. */
  hatches: HatchLayer[]
  /** `point-pattern-fill` layers — tiled stamps. */
  pointPatterns: PointPatternLayer[]
  /** First `border-symbol` layer, or undefined. Points at a paired line symbol. */
  border: BorderSymbolLayer | undefined
}

export function classifyAreaLayers(symbol: MapSymbol): AreaLayers {
  const layers = symbol.layers ?? []
  const fills: FillLayer[] = []
  const strokes: StrokeLayer[] = []
  const hatches: HatchLayer[] = []
  const pointPatterns: PointPatternLayer[] = []
  let border: BorderSymbolLayer | undefined
  for (const l of layers) {
    switch (l.type) {
      case 'fill':
        fills.push(l as FillLayer)
        break
      case 'stroke':
        strokes.push(l as StrokeLayer)
        break
      case 'hatch-fill':
        hatches.push(l as HatchLayer)
        break
      case 'point-pattern-fill':
        pointPatterns.push(l as PointPatternLayer)
        break
      case 'border-symbol':
        if (!border) border = l as BorderSymbolLayer
        break
    }
  }
  return {
    fill: fills[0],
    fills,
    strokes,
    hatches,
    pointPatterns,
    border,
  }
}

export interface PointLayers {
  fill: PointFillLayer | undefined
  stroke: PointStrokeLayer | undefined
  elements: PointElementsLayer | undefined
}

export function classifyPointLayers(symbol: MapSymbol): PointLayers {
  let fill: PointFillLayer | undefined
  let stroke: PointStrokeLayer | undefined
  let elements: PointElementsLayer | undefined
  for (const l of symbol.layers ?? []) {
    switch (l.type) {
      case 'point-fill':
        if (!fill) fill = l as PointFillLayer
        break
      case 'point-stroke':
        if (!stroke) stroke = l as PointStrokeLayer
        break
      case 'point-elements':
        if (!elements) elements = l as PointElementsLayer
        break
    }
  }
  return { fill, stroke, elements }
}

export interface TextLayers {
  text: TextLayer | undefined
}

export function classifyTextLayers(symbol: MapSymbol): TextLayers {
  for (const l of symbol.layers ?? []) {
    if (l.type === 'text') return { text: l as TextLayer }
  }
  return { text: undefined }
}

export interface LineLayers {
  strokes: StrokeLayer[]
  doubleLine: DoubleLineLayer | undefined
  lineElements: LineElementsLayer | undefined
}

export function classifyLineLayers(symbol: MapSymbol): LineLayers {
  const strokes: StrokeLayer[] = []
  let doubleLine: DoubleLineLayer | undefined
  let lineElements: LineElementsLayer | undefined
  for (const l of symbol.layers ?? []) {
    switch (l.type) {
      case 'stroke':
        strokes.push(l as StrokeLayer)
        break
      case 'double-line':
        if (!doubleLine) doubleLine = l as DoubleLineLayer
        break
      case 'line-elements':
        if (!lineElements) lineElements = l as LineElementsLayer
        break
    }
  }
  return { strokes, doubleLine, lineElements }
}
