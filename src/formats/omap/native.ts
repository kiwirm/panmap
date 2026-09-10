/**
 * OMap native file model — the OmapFile record shape shared by the reader
 * (decode / to-panmap) and the writer (from-panmap / encode), plus the two
 * on-disk constants both sides need. Lives above reader/ and writer/ so the
 * writer does not have to import from the reader to reach the shared model.
 */

/** fast-xml-parser attribute prefix; attributes serialise as `@_name`. */
export const ATTR_PREFIX = '@_'

/** OMap stores coordinates as fixed-point centi-millimetres; multiply on-disk
 *  values by this to get map units (millimetres). */
export const MAP_UNIT_SCALE = 0.1

export interface OmapFile {
  colors: OmapColor[]
  symbols: OmapSymbol[]
  objects: OmapObject[]
  /**
   * Document-level extras captured verbatim from the parsed XML so writers
   * can round-trip sections we don't yet model (templates, georeferencing,
   * parts metadata > 1, notes, print parameters, view settings, etc.).
   *
   * The shape mirrors fast-xml-parser's parsed JSON; the writer hands it
   * back through XMLBuilder.
   */
  extras?: OmapExtras
}

export interface OmapExtras {
  /** Attributes on the root `<map>` element (e.g. version). */
  mapAttributes?: Record<string, string>
  /** Attributes on the inner `<barrier>` element (e.g. version, required). */
  barrierAttributes?: Record<string, string>
  /** Raw `<georeferencing>` subtree. */
  georeferencing?: unknown
  /** Raw `<notes>` subtree. */
  notes?: unknown
  /** Raw `<templates>` subtree. */
  templates?: unknown
  /** Raw `<view>` subtree. */
  view?: unknown
  /** Raw `<print>` subtree. */
  print?: unknown
  /** Raw `<parts>` subtree (multi-part documents); single-part is flattened. */
  parts?: unknown
}

export interface OmapColor {
  priority: number
  name: string
  rgb: OmapRgb | null
  /** CMYK components in [0, 1], from the `c`/`m`/`y`/`k` XML attributes. */
  cmyk?: [number, number, number, number]
  /** Per-color opacity in [0, 1], from the `opacity` XML attribute. */
  opacity?: number
}

export interface OmapRgb {
  r: number
  g: number
  b: number
}

export interface OmapCoord {
  x: number
  y: number
  flags?: number
}

export interface OmapSize {
  width: number
  height: number
}

export interface OmapPattern {
  rotation?: number
  origin?: OmapCoord
}

export interface OmapObject {
  type: number
  symbol: number
  rotation?: number
  hAlign?: number
  vAlign?: number
  coords: OmapCoord[]
  text: string | null
  textBox: OmapSize | null
  pattern?: OmapPattern
}

export interface OmapLineSymbol {
  color: number
  lineWidth: number
  minimumLength: number
  dashed: boolean
  dashLength: number
  breakLength: number
  dashesInGroup: number
  inGroupBreakLength: number
  endLength: number
  dashSymbol?: OmapSymbol
  segmentLength: number
  startOffset: number
  endOffset: number
  showAtLeastOneSymbol: boolean
  midSymbolsPerSpot: number
  minimumMidSymbolCount: number
  minimumMidSymbolCountWhenClosed: number
  suppressDashSymbolAtEnds: boolean
  scaleDashSymbol: boolean
  capStyle: number
  joinStyle: number
  midSymbol?: OmapSymbol
  midSymbolDistance: number
  midSymbolPlacement: number
  startSymbol?: OmapSymbol
  endSymbol?: OmapSymbol
  borders?: OmapLineBorder[]
}

export interface OmapLineBorder {
  color: number
  width: number
  shift: number
}

export interface OmapAreaPattern {
  type: number
  angle: number
  lineSpacing: number
  pointDistance: number
  lineOffset: number
  offsetAlongLine: number
  color?: number
  lineWidth: number
  rotatable: boolean
  symbol?: OmapSymbol
}

export interface OmapAreaSymbol {
  innerColor: number
  patterns?: OmapAreaPattern[]
}

export interface OmapPointElement {
  symbol?: OmapSymbol
  object?: OmapObject
}

export interface OmapPointSymbol {
  innerColor: number | null
  elements?: OmapPointElement[]
  innerRadius: number
  outerWidth: number
  outerColor: number | null
  rotatable: boolean
}

export interface OmapCombinedSymbol {
  parts: Array<{ symbol?: OmapSymbol; symbolRef?: number }>
}

export interface OmapTextSymbol {
  color: number
  fontFamily: string
  /** Font size in map units (mm). */
  fontSize: number
  bold: boolean
  italic: boolean
  /** Line spacing as a multiplier (1 = single-spaced). */
  lineSpacing?: number
  /** Paragraph spacing in map units. */
  paragraphSpacing?: number
  /** Character spacing in map units. */
  characterSpacing?: number
  rotatable?: boolean
  framing?: {
    color?: number
    mode?: number
    lineHalfWidth?: number
    shadowX?: number
    shadowY?: number
  }
  lineBelow?: {
    color?: number
    width?: number
    distance?: number
  }
}

export interface OmapSymbol {
  id: number
  code?: string
  name?: string
  type: number
  isHidden?: boolean
  lineSymbol?: OmapLineSymbol
  areaSymbol?: OmapAreaSymbol
  pointSymbol?: OmapPointSymbol
  combinedSymbol?: OmapCombinedSymbol
  textSymbol?: OmapTextSymbol
}
