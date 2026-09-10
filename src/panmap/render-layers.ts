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
  | FillLayer | StrokeLayer | HatchLayer | StructureLayer
  | PointPatternLayer | BorderSymbolLayer | DoubleLineLayer
  | LineElementsLayer | LineSymbolsLayer
  | PointFillLayer | PointStrokeLayer | PointElementsLayer
  | TextLayer
  | BaseRenderLayer

/** True when `layer` carries a `pattern` field (structure-fill /
 *  point-pattern-fill). Narrows callers to the union of both types. */
export function isPatternLayer(layer: RenderLayer): layer is StructureLayer | PointPatternLayer {
  return layer.type === 'structure-fill' || layer.type === 'point-pattern-fill'
}

export interface FillLayer extends BaseRenderLayer { type: 'fill' }

export interface DashSpec {
  dashLength?: number
  breakLength?: number
  dashesInGroup?: number
  inGroupBreakLength?: number
  mainLength?: number
  mainGap?: number
  secGap?: number
  endLength?: number
  endGap?: number
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

export interface HatchLayer extends BaseRenderLayer { type: 'hatch-fill' }

export interface PatternSpec {
  /** Row-to-row spacing (xmap `line_spacing`). */
  lineSpacing?: number
  /** Symbol-to-symbol spacing along a row (xmap `point_distance`). */
  pointDistance?: number
  /** Offset of the first row (xmap `line_offset`). */
  lineOffset?: number
  /** Offset along the first row (xmap `offset_along_line`). */
  offsetAlongLine?: number
  /** OCAD `structDraw` clip mode: 0 clip, 1 don't clip if inside, 2 if centre inside. */
  noClipping?: number
  rotation?: number
  rotatable?: boolean
  symbol?: {
    pointSymbol?: {
      elements?: unknown[]
      innerColor?: unknown
      innerRadius?: number
    }
  }
}

export interface StructureLayer extends BaseRenderLayer {
  type: 'structure-fill'
  pattern?: PatternSpec
  /** OCAD structMode: 1 = aligned rows, 2 = shifted rows. */
  mode?: number
  symbolWidth?: number
  symbolHeight?: number
  noClipping?: number
}

export interface PointPatternLayer extends BaseRenderLayer {
  type: 'point-pattern-fill'
  pattern?: PatternSpec
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
}

export interface LineElementsLayer extends BaseRenderLayer {
  type: 'line-elements'
}

export interface LineSymbolsSpec {
  midSymbol?: unknown
  dashSymbol?: unknown
  startSymbol?: unknown
  endSymbol?: unknown
}

export interface LineSymbolsLayer extends BaseRenderLayer {
  type: 'line-symbols'
  lineSymbol?: LineSymbolsSpec
}

export interface PointFillLayer extends BaseRenderLayer { type: 'point-fill' }
export interface PointStrokeLayer extends BaseRenderLayer { type: 'point-stroke' }
export interface PointElementsLayer extends BaseRenderLayer { type: 'point-elements' }
export interface TextLayer extends BaseRenderLayer { type: 'text' }

export interface AreaLayers {
  /** First `fill` layer, or undefined. Most areas have at most one. */
  fill: FillLayer | undefined
  /** All `fill` layers, in source order. */
  fills: FillLayer[]
  /** `stroke` layers — an area's outline stroke(s). */
  strokes: StrokeLayer[]
  /** `hatch-fill` layers. Two crossed layers form OCAD `hatchMode=2`. */
  hatches: HatchLayer[]
  /** `structure-fill` layers (xmap "structure" patterns). */
  structures: StructureLayer[]
  /** `point-pattern-fill` layers. Two matching layers form OCAD `structMode=2`. */
  pointPatterns: PointPatternLayer[]
  /** First `border-symbol` layer, or undefined. Points at a paired line symbol. */
  border: BorderSymbolLayer | undefined
}

export function classifyAreaLayers(symbol: MapSymbol): AreaLayers {
  const layers = symbol.layers ?? []
  const fills: FillLayer[] = []
  const strokes: StrokeLayer[] = []
  const hatches: HatchLayer[] = []
  const structures: StructureLayer[] = []
  const pointPatterns: PointPatternLayer[] = []
  let border: BorderSymbolLayer | undefined
  for (const l of layers) {
    switch (l.type) {
      case 'fill': fills.push(l as FillLayer); break
      case 'stroke': strokes.push(l as StrokeLayer); break
      case 'hatch-fill': hatches.push(l as HatchLayer); break
      case 'structure-fill': structures.push(l as StructureLayer); break
      case 'point-pattern-fill': pointPatterns.push(l as PointPatternLayer); break
      case 'border-symbol':
        if (!border) border = l as BorderSymbolLayer
        break
    }
  }
  return { fill: fills[0], fills, strokes, hatches, structures, pointPatterns, border }
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
  lineSymbols: LineSymbolsLayer | undefined
}

export function classifyLineLayers(symbol: MapSymbol): LineLayers {
  const strokes: StrokeLayer[] = []
  let doubleLine: DoubleLineLayer | undefined
  let lineElements: LineElementsLayer | undefined
  let lineSymbols: LineSymbolsLayer | undefined
  for (const l of symbol.layers ?? []) {
    switch (l.type) {
      case 'stroke': strokes.push(l as StrokeLayer); break
      case 'double-line':
        if (!doubleLine) doubleLine = l as DoubleLineLayer
        break
      case 'line-elements':
        if (!lineElements) lineElements = l as LineElementsLayer
        break
      case 'line-symbols':
        if (!lineSymbols) lineSymbols = l as LineSymbolsLayer
        break
    }
  }
  return { strokes, doubleLine, lineElements, lineSymbols }
}
