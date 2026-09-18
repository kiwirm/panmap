/**
 * Line-symbol builder: `MapSymbol` stroke / double-line / line-element
 * layers → an XMap `<line_symbol>` record (plus the `<borders>` shape
 * reconstructed from either stroke borders or an OCD double-line layer).
 */
import type {
  DoubleLineLayer,
  LineElementsLayer,
  StrokeLayer,
} from '../../../../panmap/render-layers.js'
import type { OmapLineBorder, OmapLineSymbol } from '../../native.js'
import { strokeVisible } from '../../../../panmap/stroke-classifier.js'
import { decodeLineStyle as decodeLineStyleForXmap } from '../../../ocad/codecs/line-style.js'
import { colorRef } from './colors.js'
import { ocadElementsToXmapPointSymbol } from './elements.js'

function buildXmapLineSymbol(
  strokes: StrokeLayer[],
  doubleLine: DoubleLineLayer | undefined,
  lineElements: LineElementsLayer | undefined,
  colorIds: Map<string | number, number>,
): OmapLineSymbol {
  // Pick the primary stroke — visible ones first, then anything. When a
  // stroke has borders (xmap-sourced), that IS the primary and its
  // width is the "fill" width for the borders.
  const primary =
    strokes.find(s => strokeVisible(s)) ??
    strokes.find(s => Array.isArray(s.borders)) ??
    strokes[0]

  const cap = primary?.capStyle
  const join = primary?.joinStyle
  const decoded =
    primary?.lineStyle !== undefined
      ? decodeLineStyleForXmap(primary.lineStyle)
      : {}

  const dash = primary?.dash
  const isDashed = !!(dash && (dash.dashLength || dash.breakLength))

  // Dash geometry: model uses Mapper's semantic vocab (both readers
  // canonicalise to this — see ocad/reader/to-panmap.ts:dashFromOcd for
  // the OCD-side translation). Defaults match Mapper's built-ins
  // (internal 400/100/50 → XML 4000/1000/500 via dim() * 10).
  const dashLength = dash?.dashLength ?? 400
  const breakLength = dash?.breakLength ?? 100
  const dashesInGroup = dash?.dashesInGroup ?? 1
  const inGroupBreakLength = dash?.inGroupBreakLength ?? 50

  // segmentLength / endLength — used for mid-symbol placement even on
  // non-dashed lines. Only surface `segment_length`/`end_length` when
  // the line actually has mid-symbol decoration to place; on a plain
  // dashed line Mapper writes `segment_length="4000"` (UI default,
  // unused by the renderer) and on a plain solid line writes 0.
  const hasMidDecor =
    ((lineElements?.primSymElements as unknown[] | undefined)?.length ?? 0) >
      0 ||
    ((lineElements?.startSymElements as unknown[] | undefined)?.length ?? 0) >
      0 ||
    ((lineElements?.endSymElements as unknown[] | undefined)?.length ?? 0) >
      0 ||
    ((lineElements?.cornerSymElements as unknown[] | undefined)?.length ?? 0) >
      0
  // segment_length: prefer the explicit model value (xmap-sourced
  // strokes carry it verbatim; OCD-sourced only carry a value when the
  // line has mid-symbol content, via line-elements.spacing). Fall back
  // to Mapper's UI default (400 internal → xmap 4000) when the model
  // has no value.
  const segmentLength =
    primary?.segmentLength ??
    (lineElements?.spacing as number | undefined) ??
    400
  const endLength =
    primary?.endLength ??
    (lineElements?.endOffset as number | undefined) ??
    0

  const halfOuterDashes = isDashed && !!dash?.halfOuterDashes

  // Borders: xmap-sourced carries `borders` on the stroke;
  // OCD-sourced carries a separate `double-line` layer.
  const borders = extractBorders(primary, doubleLine, colorIds)

  const primaryColor = colorRef(primary?.colorId, colorIds)
  // Prefer the primary stroke's own width. If the primary is invisible
  // (width=0) but a double-line exists, `centerWidth` on the double-
  // line encodes the distance between the two borders — Mapper reads
  // this back as `line_width` in the xmap. Without this the ISOM 511
  // Major Power Line (invisible wide main + two thin dashed borders)
  // collapses to a zero-width line on ocd→xmap→ocd.
  const primaryWidth = (primary?.width ?? 0) || (doubleLine?.centerWidth ?? 0)

  // Line-decoration builders enable the single-dot inline
  // canonicalisation — Mapper writes a cliff/bank/etc. mid_symbol as
  // an inline <point_symbol inner_radius=X inner_color=Y elements="0"/>
  // rather than as a wrapped <point_symbol><element><symbol>
  // <point_symbol/></symbol></element></point_symbol>. Both forms are
  // semantically identical, but only the inline form byte-matches the
  // Mapper-authored source on xmap→gitmap→xmap round-trips.
  //
  // Both OMap-native and OCD-sourced line symbols reach this builder
  // through the SAME canonical `line-elements` layer (OMap reader
  // flattens `<mid_symbol>` etc. into `primSymElements` at read time;
  // OCD reader ships them there directly). No source-format branching.
  const inlineOpts = { inlineSingleDot: true }
  const midSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.primSymElements as unknown[]) ?? [],
    colorIds,
    inlineOpts,
  )
  const startSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.startSymElements as unknown[]) ?? [],
    colorIds,
    inlineOpts,
  )
  const endSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.endSymElements as unknown[]) ?? [],
    colorIds,
    inlineOpts,
  )
  // OCAD's `cornerSymElements` = xmap's `<dash_symbol>` (used by power
  // lines 510/511 to draw a per-corner tick). Without this, Mapper's
  // useSymbolFlags loses bit 2 and Mapper renders the line as plain.
  const dashSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.cornerSymElements as unknown[]) ?? [],
    colorIds,
    inlineOpts,
  )

  return {
    color: primaryColor,
    lineWidth: primaryWidth,
    minimumLength: 0,
    dashed: !!isDashed,
    dashLength,
    breakLength,
    dashesInGroup,
    inGroupBreakLength,
    endLength,
    halfOuterDashes,
    segmentLength,
    startOffset: primary?.startOffset ?? 0,
    endOffset: primary?.endOffset ?? 0,
    showAtLeastOneSymbol: primary?.showAtLeastOneSymbol ?? true,
    midSymbolsPerSpot: primary?.midSymbolsPerSpot ?? 1,
    midSymbolDistance: primary?.midSymbolDistance ?? 0,
    // Mapper's default for `mid_symbol_placement` depends on whether the
    // line has a mid_symbol at all: lines with mid-decoration default to
    // 2 (centre on segment), lines without to 0. Mapper writes the value
    // explicitly on every ocd→xmap export, so match by inspecting the
    // presence of a midSymbol. If a canonical OMap-side value is carried
    // (from an xmap round-trip), prefer it.
    midSymbolPlacement:
      (primary as { midSymbolPlacement?: number })?.midSymbolPlacement ??
      (midSymbol ? 2 : 0),
    minimumMidSymbolCount: primary?.minimumMidSymbolCount ?? 0,
    minimumMidSymbolCountWhenClosed: 0,
    suppressDashSymbolAtEnds: false,
    scaleDashSymbol: true,
    capStyle: cap ?? decoded.capStyle ?? 0,
    joinStyle: join ?? decoded.joinStyle ?? 0,
    // Pointed-cap length only makes sense with cap_style=3; still emit
    // it verbatim when the source set it, and let the emitter skip the
    // attribute when 0 (the encode-side default suppression).
    pointedCapLength: (primary as { pointedCapLength?: number })
      ?.pointedCapLength,
    midSymbol,
    startSymbol,
    endSymbol,
    dashSymbol,
    borders,
  } as OmapLineSymbol
}

/**
 * Reconstruct xmap `<borders>` from either the stroke's `borders` field
 * (xmap-native Panmap) or an OCD-sourced `double-line` layer. The two
 * shapes carry the same information; the emitter needs xmap's shape:
 *   borders[0] = left, borders[1] = right, each { color, width, shift }
 */
function extractBorders(
  primary: StrokeLayer | undefined,
  doubleLine: DoubleLineLayer | undefined,
  colorIds: Map<string | number, number>,
): OmapLineBorder[] | undefined {
  const strokeBorders = primary?.borders
  if (Array.isArray(strokeBorders) && strokeBorders.length) {
    return strokeBorders.map(b => {
      const bo = b as {
        color?: unknown
        width?: number
        shift?: number
        dashed?: boolean
        dashLength?: number
        breakLength?: number
      }
      return {
        color: colorRef(bo.color, colorIds),
        width: bo.width ?? 0,
        shift: bo.shift ?? 0,
        dashed: bo.dashed,
        dashLength: bo.dashLength,
        breakLength: bo.breakLength,
      } as OmapLineBorder
    })
  }
  if (doubleLine) {
    const dl = doubleLine as DoubleLineLayer & {
      dashLength?: number
      breakLength?: number
    }
    const leftC = colorRef(dl.leftColorId, colorIds)
    const rightC = colorRef(dl.rightColorId, colorIds)
    const leftW = dl.leftWidth ?? 0
    const rightW = dl.rightWidth ?? 0
    // Skip borders entirely when both sides are width-0 (invisible).
    // Mapper's `dblLeftWidth=0 / dblRightWidth=0` means "no border";
    // the leftover `dblLeftColor=0` is the default-init value, NOT
    // an intentional slot-0 reference. Emitting a `<border color=0/>`
    // for it would add color slot 0 to the round-tripped colorSet.
    if (leftW <= 0 && rightW <= 0) return undefined
    // dblMode 2 = LeftBorderDashed, 3 = BordersDashed, 4 = AllDashed
    const leftDashed = dl.mode === 2 || dl.mode === 3 || dl.mode === 4
    const rightDashed = dl.mode === 3 || dl.mode === 4
    const dashLength = dl.dashLength || undefined
    const breakLength = dl.breakLength || undefined
    // A single side visible → emit only that side; a border with
    // width=0 is still a phantom color source.
    const out: OmapLineBorder[] = []
    if (leftW > 0) {
      out.push({
        color: leftC,
        width: leftW,
        shift: 0,
        dashed: leftDashed || undefined,
        dashLength: leftDashed ? dashLength : undefined,
        breakLength: leftDashed ? breakLength : undefined,
      } as OmapLineBorder)
    }
    if (rightW > 0) {
      out.push({
        color: rightC,
        width: rightW,
        shift: 0,
        dashed: rightDashed || undefined,
        dashLength: rightDashed ? dashLength : undefined,
        breakLength: rightDashed ? breakLength : undefined,
      } as OmapLineBorder)
    }
    return out.length ? out : undefined
  }
  return undefined
}

export { buildXmapLineSymbol, extractBorders }
