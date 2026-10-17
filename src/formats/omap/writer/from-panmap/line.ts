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
  // For NON-dashed strokes, prefer the OMap-hoisted per-symbol dashLength
  // and breakLength — Mapper stores real values there on symbols like
  // 302.1 Small watercourse and 501.4 Vehicle track that aren't dashed
  // but carry non-default dash geometry the UI exposes.
  const dashLength =
    dash?.dashLength ?? (primary as { dashLength?: number })?.dashLength ?? 400
  const breakLength =
    dash?.breakLength ??
    (primary as { breakLength?: number })?.breakLength ??
    100
  const dashesInGroup = dash?.dashesInGroup ?? 1
  // `in_group_break_length` is semantically unused when dashesInGroup<=1
  // (no gap between grouped dashes). OCAD's dashFromOcd returns 0 in
  // that case, but Mapper's ocd→xmap conversion writes the UI default
  // (500 = internal 50). Skip the dash-object value when it's the
  // no-op-zero from a single-dash-per-group OCD line.
  const inGroupBreakLength =
    (dashesInGroup > 1 ? dash?.inGroupBreakLength : undefined) ??
    (primary as { inGroupBreakLength?: number })?.inGroupBreakLength ??
    50

  // `end_length` is meaningful even without mid-symbol decoration —
  // Mapper writes it on plain dashed lines (509.2, 513.3, 518.1 …) as
  // the reserved end-run length. Prefer the primary stroke's own value
  // whenever the reader captured one; only fall back to the
  // line-elements layer's `endOffset` when decoration is present (that
  // OCD-side derivation was designed for the decorated case only).
  const hasMidDecor =
    ((lineElements?.primSymElements as unknown[] | undefined)?.length ?? 0) >
      0 ||
    ((lineElements?.startSymElements as unknown[] | undefined)?.length ?? 0) >
      0 ||
    ((lineElements?.endSymElements as unknown[] | undefined)?.length ?? 0) >
      0 ||
    ((lineElements?.cornerSymElements as unknown[] | undefined)?.length ?? 0) >
      0
  // segment_length turns only on DASHED vs SOLID — not on decoration.
  // Established across 14 fixture pairs / 951 paired line symbols
  // (945/951 = 99.4% agreement with Mapper):
  //
  //   * DASHED → Mapper's OCD importer consumes the OCD `mainLength` as
  //     `dash_length` and never assigns `segment_length`, so the field
  //     keeps its constructor default of 4000 (internal 400). True in
  //     151/157 dashed lines.
  //   * SOLID → Mapper assigns the real `mainLength`, so emit our
  //     equivalent unconditionally. True in 794/794 solid lines —
  //     including 423 that carry no decoration at all, which is why
  //     this must NOT be gated on `hasMidDecor`.
  // For dashed lines: OCD-sourced strokes carry `mainLength` on
  // `primary.segmentLength` (a dual-purpose OCAD field). Compound OCD
  // dashes (mainGap>0, secGap>0) have `dashLength ≠ mainLength`, so a
  // simple "differs from dashLength" check spuriously treats them as
  // xmap-sourced. Use the OMap-hoist marker instead: OMap reader always
  // hoists `primary.dashLength` at the stroke top level (see
  // to-panmap.ts:790), OCD reader doesn't. When absent, this is an
  // OCD-sourced dashed line and Mapper's convention emits the default
  // 400. When present with an explicit user value in xmap (kura-tawhiti
  // 501.2 with segment_length=0), preserve it.
  const isOMapSourcedDashedForSegment =
    isDashed && (primary as { dashLength?: number })?.dashLength !== undefined
  const segmentLength = isDashed
    ? isOMapSourcedDashedForSegment
      ? (primary?.segmentLength ?? 400)
      : 400
    : (primary?.segmentLength ??
      (lineElements?.spacing as number | undefined) ??
      // Fallback to Mapper's constructor default (xmap 4000) rather
      // than 0 — matches what Mapper writes for any line whose source
      // (xmap OR OCD import) didn't explicitly set segment_length.
      // Prevents via-gitmap round-trips from emitting `segment_length=0`
      // on symbols where gitmap dropped the field as canonical-default.
      400)
  // For dashed lines, Mapper's ocd→xmap conversion emits end_length=0.
  // The OCD reader stores `s.endLength` on the stroke (the OCAD "last
  // dash" length), which we DON'T want to surface as xmap end_length
  // for OCD-sourced content. Discriminator: an OMap-sourced dashed
  // line always has `primary.dashLength` hoisted at the stroke top
  // level (see to-panmap.ts:790); OCD-sourced doesn't. So skip
  // primary.endLength for dashed lines without that hoist.
  const isOMapSourcedDashed =
    isDashed && (primary as { dashLength?: number })?.dashLength !== undefined
  const endLength =
    isDashed && !isOMapSourcedDashed
      ? 0
      : (primary?.endLength ??
        (hasMidDecor
          ? ((lineElements?.endOffset as number | undefined) ?? 0)
          : 0))

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
  // Xmap-authored wrapper metadata (mid/start/end/dash) — the reader
  // hoists these from `<mid_symbol><point_symbol>` etc. so the direct
  // round-trip preserves Mapper's inner_radius / inner_color / … on
  // the outer wrapper (butlers-bush 104 with inner_radius=0, etc.).
  // Undefined for OCD-sourced content, where the writer defaults apply.
  const le = lineElements as
    | (typeof lineElements & {
        primSymWrapper?: unknown
        startSymWrapper?: unknown
        endSymWrapper?: unknown
        cornerSymWrapper?: unknown
      })
    | undefined
  const midSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.primSymElements as unknown[]) ?? [],
    colorIds,
    { inlineSingleDot: true, wrapper: le?.primSymWrapper as never },
  )
  const startSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.startSymElements as unknown[]) ?? [],
    colorIds,
    { inlineSingleDot: true, wrapper: le?.startSymWrapper as never },
  )
  const endSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.endSymElements as unknown[]) ?? [],
    colorIds,
    { inlineSingleDot: true, wrapper: le?.endSymWrapper as never },
  )
  // OCAD's `cornerSymElements` = xmap's `<dash_symbol>` (used by power
  // lines 510/511 to draw a per-corner tick). Without this, Mapper's
  // useSymbolFlags loses bit 2 and Mapper renders the line as plain.
  const dashSymbol = ocadElementsToXmapPointSymbol(
    (lineElements?.cornerSymElements as unknown[]) ?? [],
    colorIds,
    { inlineSingleDot: true, wrapper: le?.cornerSymWrapper as never },
  )

  return {
    color: primaryColor,
    lineWidth: primaryWidth,
    minimumLength: primary?.minimumLength ?? 0,
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
    minimumMidSymbolCountWhenClosed:
      primary?.minimumMidSymbolCountWhenClosed ?? 0,
    suppressDashSymbolAtEnds: primary?.suppressDashSymbolAtEnds ?? false,
    scaleDashSymbol: primary?.scaleDashSymbol ?? true,
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
