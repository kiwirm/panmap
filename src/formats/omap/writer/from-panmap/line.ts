/**
 * Line-symbol builder: `MapSymbol` stroke / double-line / line-element
 * layers → an XMap `<line_symbol>` record (plus the `<borders>` shape
 * reconstructed from either stroke borders or an OCD double-line layer).
 */
import type {
  DoubleLineLayer,
  LineElementsLayer,
  LineSymbolsLayer,
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
  lineSymbolsLayer: LineSymbolsLayer | undefined,
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
  const isDashed =
    dash && (dash.mainGap || dash.secGap || dash.dashLength || dash.breakLength)

  // Dash geometry: xmap has dashLength/breakLength (main dash + gap) and
  // dashesInGroup/inGroupBreakLength (secondary intra-group). OCD stores
  // mainLength/mainGap/secGap/endLength/endGap. Xmap-sourced dashes come
  // through with dashLength/breakLength/... directly; OCD-sourced ones
  // arrive as mainLength+mainGap and we map those to dashLength+breakLength.
  const dashLength = dash?.dashLength ?? dash?.mainLength ?? 4
  const breakLength = dash?.breakLength ?? dash?.mainGap ?? 1
  const dashesInGroup = dash?.dashesInGroup ?? 1
  const inGroupBreakLength = dash?.inGroupBreakLength ?? dash?.secGap ?? 0.5

  // segmentLength / endLength — used for mid-symbol placement even on
  // non-dashed lines. Try `segmentLength` first (xmap-native field
  // stashed on the stroke), then fall back to a line-elements layer's
  // mainLength (OCD-sourced). Only fall back to `dashLength` when the
  // line is actually dashed — for a plain solid line with no
  // decorations, Mapper writes `mainLength=0` and we should match.
  const segmentLength =
    primary?.segmentLength ??
    (lineElements?.mainLength as number | undefined) ??
    (isDashed ? dashLength : 0)
  const endLength =
    primary?.endLength ?? (lineElements?.endLength as number | undefined) ?? 0

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

  const midSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.primSymElements as unknown[]) ?? [],
    colorIds,
  )
  const startSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.startSymElements as unknown[]) ?? [],
    colorIds,
  )
  const endSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.endSymElements as unknown[]) ?? [],
    colorIds,
  )
  // OCAD's `cornerSymElements` = xmap's `<dash_symbol>` (used by power
  // lines 510/511 to draw a per-corner tick). Without this, Mapper's
  // useSymbolFlags loses bit 2 and Mapper renders the line as plain.
  const dashSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.cornerSymElements as unknown[]) ?? [],
    colorIds,
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
    segmentLength,
    startOffset: primary?.startOffset ?? 0,
    endOffset: primary?.endOffset ?? 0,
    showAtLeastOneSymbol: primary?.showAtLeastOneSymbol ?? true,
    midSymbolsPerSpot: primary?.midSymbolsPerSpot ?? 1,
    midSymbolDistance: primary?.midSymbolDistance ?? 0,
    midSymbolPlacement: 0,
    minimumMidSymbolCount: primary?.minimumMidSymbolCount ?? 0,
    minimumMidSymbolCountWhenClosed: 0,
    suppressDashSymbolAtEnds: false,
    scaleDashSymbol: true,
    capStyle: cap ?? decoded.capStyle ?? 0,
    joinStyle: join ?? decoded.joinStyle ?? 0,
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
