/**
 * XMap converter — `Panmap` symbols/objects → intermediate
 * XMap record shapes (`OmapSymbol`, `OmapAreaPattern`, …).
 *
 * The XML emission itself lives in `write.ts`. This file only builds
 * the record shape; nothing here formats XML.
 */
import type { MapObject, MapSymbol, RenderLayer } from '../../map/model.js'
import {
  classifyAreaLayers, classifyLineLayers,
  classifyPointLayers, classifyTextLayers,
} from '../../map/render-layers.js'
import type {
  DoubleLineLayer, FillLayer, HatchLayer, LineElementsLayer,
  LineSymbolsLayer, PointPatternLayer, StrokeLayer, StructureLayer,
} from '../../map/render-layers.js'
import type {
  OmapAreaPattern,
  OmapAreaSymbol,
  OmapLineBorder,
  OmapLineSymbol,
  OmapObject,
  OmapPointSymbol,
  OmapSymbol,
  OmapTextSymbol,
} from './read.js'
import { coordX, coordY, coordFlags } from '../../map/coord.js'
import type { Coord } from '../../map/coord.js'
import { buildColorIdMap, colorRefLookup } from '../../util/color.js'
import { pickMainStroke, strokeVisible } from '../../util/stroke-classifier.js'
import { decodeLineStyle as decodeLineStyleForXmap } from '../../util/line-style-codec.js'

/** XMap symbol shape accepted by `xmapSymbolToXml`. Wider than
 *  `OmapSymbol` because the Panmap → xmap adapter may produce
 *  records with a few optional fields the strict interface omits. */
export type RawOmapSymbol = OmapSymbol | (Partial<OmapSymbol> & {
  id?: number
  code?: string
  name?: string
  [key: string]: unknown
})

/**
 * Convert a `MapSymbol` (render-layer shape) into an
 * `OmapSymbol` structure that `xmapSymbolToXml` accepts. This is the
 * single path from to XMap XML — the earlier `native.xmap.raw`
 * passthrough retired in favour of it.
 *
 * Layer → XMap mappings:
 *   - stroke                  → lineSymbol (color, lineWidth, cap/join,
 *                                dash, borders, segmentLength, etc.)
 *   - double-line             → lineSymbol.borders (OCD-only; xmap
 *                                sources already carry borders on the
 *                                stroke layer)
 *   - line-elements           → lineSymbol.mid/dash/start/endSymbol
 *   - fill                    → areaSymbol.innerColor
 *   - hatch-fill              → areaSymbol.patterns[type=1]
 *   - structure-fill          → areaSymbol.patterns[type=2|3]
 *   - point-pattern-fill      → areaSymbol.patterns[type=2|3]
 *   - point-fill/point-stroke → pointSymbol.inner/outer
 *   - point-elements          → pointSymbol.elements
 *   - text                    → textSymbol
 */
function toOmapSymbol(
  symbol: MapSymbol,
  id: number,
  colorIds: Map<string | number, number>,
): RawOmapSymbol {
  const {
    fills, hatches, structures, pointPatterns, strokes,
    border: borderSymbolLayer,
  } = classifyAreaLayers(symbol)
  const {
    doubleLine, lineElements, lineSymbols: lineSymbolsLayer,
  } = classifyLineLayers(symbol)
  const {
    fill: pointFill, stroke: pointStroke, elements: pointElementsLayer,
  } = classifyPointLayers(symbol)
  const { text: textLayer } = classifyTextLayers(symbol)

  const t = symbol.type
  const hasLine = strokes.length > 0 || !!doubleLine || !!lineElements || !!lineSymbolsLayer
  const hasArea = fills.length > 0 || hatches.length > 0 || structures.length > 0 || pointPatterns.length > 0
  const hasPoint = !!pointFill || !!pointStroke || !!pointElementsLayer
  const hasText = !!textLayer

  const record: RawOmapSymbol = {
    id,
    code: symbol.code,
    name: symbol.name,
    type: omapSymbolType(symbol),
    // Round-trip Mapper's UI-hide flag. `xmapSymbolToXml` reads
    // `isHidden` and emits `is_hidden="true"` when truthy.
    isHidden: symbol.hidden || undefined,
  }

  // OCAD "double line" or "frame" line-symbol idiom → XMap `<combined_symbol>`:
  // OCAD packs "main visible line + wider fill/frame + optional borders"
  // into a single line symbol (lineColor/lineWidth on top, dblFillColor
  // + dblWidth + dblLeft/Right OR frColor + frWidth around/under it).
  // XMap has no dblFillColor / frColor concept — Mapper's own exporter
  // splits this into a combined symbol with two private line parts:
  //   part 1: the top decoration (main line + mid/dash symbols)
  //   part 2: the fill/frame line (colored, wider) with optional
  //           `<borders>` for the left/right border colors and widths.
  // Trigger the split whenever either the double-line has a real fill
  // color or the Panmap carries a `frame: true` stroke (surfaced
  // by the OCD reader from OCAD's fr* fields). A doubleLine with no
  // fill AND no frame collapses to a plain `<line_symbol>` — otherwise
  // an all-zero fill stroke adds a phantom color slot.
  // Detect the frame stroke — a visible under-stroke drawn beneath the main
  // line (OCAD's `fr*` fields, e.g. 509 Railway's black backing behind the
  // dashed white). OCD reader sets `frame: true`, but the gitmap canonicaliser
  // strips that marker for cross-format identity with OMap-native symbols.
  // Fall back to structural detection: for a DASHED primary, a solid wider
  // non-borders stroke is the frame. Narrow criteria — a plain 2-solid-stroke
  // symbol without a real frame relationship would break round-trip if
  // treated as combined.
  const strokePrimary = pickMainStroke(strokes)
  const isFrameCandidate = (s: StrokeLayer): boolean => {
    if (s === strokePrimary || s.frame) return false
    if (!strokeVisible(s)) return false
    if (Array.isArray(s.borders) && s.borders.length > 0) return false
    if (!strokePrimary?.dash) return false
    const primaryWidth = strokePrimary.width ?? 0
    return (s.width ?? 0) > primaryWidth
  }
  const frameStroke = strokes.find(s => s.frame) ?? strokes.find(isFrameCandidate)
  // Detect the gitmap canonical form of a double-line: a secondary stroke
  // carrying `borders` in addition to a preceding visible primary stroke.
  // The gitmap writer normalises OCAD's `double-line` layer into this shape
  // so both dialects agree; here we recognise it and re-split into the same
  // combined_symbol shape Mapper produces from a native double-line.
  //
  // The "preceding visible stroke" guard is load-bearing: single-stroke-
  // with-borders symbols (e.g. stairway 532 — an invisible primary with a
  // borders array) are handled by the plain `<line_symbol>` path, not this
  // one. Firing here for those breaks xmap→xmap idempotence.
  const primaryVisibleForBorderSearch = strokes.find(s => strokeVisible(s))
  const borderCarrierStroke = primaryVisibleForBorderSearch
    ? strokes.find(s =>
      s !== primaryVisibleForBorderSearch
      && Array.isArray(s.borders) && s.borders.length > 0
    )
    : undefined
  if ((t === 'line' || t === 'combined') && (doubleLine || frameStroke || borderCarrierStroke)) {
    const dl = doubleLine
    const fillC = dl ? colorRef(dl.fillColorId, colorIds) : -1
    const frameC = frameStroke
      ? colorRef(frameStroke.colorId, colorIds)
      : -1
    const carrierC = borderCarrierStroke
      ? colorRef(borderCarrierStroke.colorId, colorIds)
      : -1
    // Emit combined when there's a visible fill or frame, OR when the
    // double-line has borders but no fill (stairway 532: color=-1 on
    // the fill line, borders on either side). Emitting as a plain line
    // in that case would put the borders directly on the visible
    // primary → Mapper's OCD encoding would set dblWidth = primary.
    // width instead of the invisible fill's width, losing 1mm per side.
    const dlHasBorders = !!dl
      && (((dl.leftWidth ?? 0) > 0) || ((dl.rightWidth ?? 0) > 0))
    const carrierHasBorders = !!borderCarrierStroke
      && Array.isArray(borderCarrierStroke.borders)
      && borderCarrierStroke.borders.length > 0
    if (fillC > 0 || frameC > 0 || carrierC > 0 || dlHasBorders || carrierHasBorders) {
    // Prefer strokes that are NOT the frame carrier as "primary".
    // The frame stroke, when present, was surfaced from OCAD's fr*
    // fields and is drawn UNDER the main line — not the top layer.
    const nonFrameStrokes = strokes.filter(s =>
      !s.frame && s !== borderCarrierStroke,
    )
    const primary = nonFrameStrokes.find(s => strokeVisible(s))
      ?? nonFrameStrokes[0]
      ?? strokes[0]
    const mainLine = buildXmapLineSymbol(
      primary ? [primary] : [],
      undefined, lineElements, lineSymbolsLayer, colorIds,
    )
    // Inherit cap/join from the source stroke so lineStyle round-trips.
    // OCAD stores one `lineStyle` byte per line-symbol; both the visible
    // main line and the fill share it. Xmap's cap_style/join_style
    // attributes on the fill part must match what the primary carried
    // or the round-trip re-encodes to a different lineStyle.
    const strokeCapJoin = primary?.lineStyle !== undefined
      ? decodeLineStyleForXmap(primary.lineStyle)
      : { capStyle: primary?.capStyle, joinStyle: primary?.joinStyle }
    // Width and color: prefer doubleLine's fill fields when present;
    // fall back to the border-carrier stroke's own (gitmap-canonical
    // double-line), then the frame stroke's, otherwise invisible.
    const fillColorNumeric =
      fillC > 0 ? fillC :
      carrierC > 0 ? carrierC :
      frameC > 0 ? frameC : -1
    const fillWidth = dl
      ? (dl.centerWidth ?? 0)
      : (borderCarrierStroke?.width ?? frameStroke?.width ?? 0)
    const fillLine: OmapLineSymbol = {
      color: fillColorNumeric,
      lineWidth: fillWidth,
      minimumLength: 0,
      dashed: false,
      dashLength: 400,
      breakLength: 100,
      dashesInGroup: 1,
      inGroupBreakLength: 50,
      endLength: 0,
      segmentLength: 400,
      startOffset: 0,
      endOffset: 0,
      showAtLeastOneSymbol: true,
      midSymbolsPerSpot: 1,
      midSymbolDistance: 0,
      midSymbolPlacement: 0,
      minimumMidSymbolCount: 0,
      minimumMidSymbolCountWhenClosed: 0,
      suppressDashSymbolAtEnds: false,
      scaleDashSymbol: true,
      capStyle: strokeCapJoin.capStyle ?? 0,
      joinStyle: strokeCapJoin.joinStyle ?? 0,
      borders: doubleLine
        ? extractBorders(undefined, doubleLine, colorIds)
        : (borderCarrierStroke
          ? extractBorders(borderCarrierStroke, undefined, colorIds)
          : undefined),
    } as OmapLineSymbol
      record.type = 16
      record.combinedSymbol = {
        parts: [
          { symbol: { id: -1, type: 2, code: symbol.code, name: `${symbol.name ?? ''} - main line`, lineSymbol: mainLine } as OmapSymbol },
          { symbol: { id: -1, type: 2, code: symbol.code, name: `${symbol.name ?? ''} - double line`, lineSymbol: fillLine } as OmapSymbol },
        ],
      }
      return record
    }
  }

  // Area + border-symbol: OCAD encodes areas with a coloured border as
  // an area-symbol with `borderSym` pointing at a separate line symbol.
  // XMap has no such reference on `<area_symbol>`; instead Mapper
  // exports the same shape as a `<combined_symbol>` with two parts:
  // (1) private area, (2) reference to the border line symbol. We do
  // the same so the border survives the ocd → xmap → ocd trip.
  if ((t === 'area' || t === 'combined') && hasArea && borderSymbolLayer) {
    const borderRef = borderSymbolLayer.symbolId
    const areaBody = buildXmapAreaSymbol(fills, hatches, structures, pointPatterns, colorIds)
    record.type = 16
    record.combinedSymbol = {
      parts: [
        {
          symbol: {
            id: -1,
            type: 4,
            code: symbol.code,
            name: symbol.name,
            areaSymbol: areaBody,
          } as OmapSymbol,
        },
        { symbolRef: typeof borderRef === 'number' ? borderRef : Number(borderRef) },
      ],
    }
    return record
  }

  // Combined "area + inline bank line" (xmap `<combined_symbol>` with a
  // private area part and a private line part — e.g. ISOM 301
  // "Uncrossable body of water, with bank line"). No border-symbol
  // reference, so the earlier path doesn't apply. Emit as combined_symbol
  // with two inline parts instead of collapsing to `<line_symbol>` +
  // `<area_symbol>` on the same root — Mapper reads that as area-only
  // (loses the bank line) and idempotence breaks.
  if (t === 'combined' && hasArea && hasLine) {
    const areaBody = buildXmapAreaSymbol(fills, hatches, structures, pointPatterns, colorIds)
    const lineBody = buildXmapLineSymbol(
      strokes, doubleLine, lineElements, lineSymbolsLayer, colorIds,
    )
    record.type = 16
    record.combinedSymbol = {
      parts: [
        { symbol: { id: -1, type: 4, code: symbol.code, name: symbol.name, areaSymbol: areaBody } as OmapSymbol },
        { symbol: { id: -1, type: 2, code: symbol.code, name: symbol.name, lineSymbol: lineBody } as OmapSymbol },
      ],
    }
    return record
  }

  if ((t === 'line' || t === 'combined') && hasLine) {
    record.lineSymbol = buildXmapLineSymbol(
      strokes, doubleLine, lineElements, lineSymbolsLayer, colorIds,
    )
  }
  if ((t === 'area' || t === 'combined') && hasArea) {
    record.areaSymbol = buildXmapAreaSymbol(
      fills, hatches, structures, pointPatterns, colorIds,
    )
  }
  if (t === 'point' && hasPoint) {
    record.pointSymbol = buildXmapPointSymbol(
      pointFill, pointStroke, pointElementsLayer, colorIds,
      isRotatableFromNative(symbol),
    )
  }
  if ((t === 'text' || t === 'line-text') && hasText) {
    record.textSymbol = buildXmapTextSymbol(
      textLayer, symbol, colorIds, isRotatableFromNative(symbol),
    )
  }

  // Fallback: if the declared type didn't produce a body, fall back to
  // whichever layer bucket has something. Prevents the writer from
  // emitting an empty <symbol/> for a symbol that just happens to have
  // a `type` we didn't match cleanly (e.g. OCAD "combined" symbols).
  if (!record.lineSymbol && !record.areaSymbol && !record.pointSymbol && !record.textSymbol) {
    if (hasLine) {
      record.lineSymbol = buildXmapLineSymbol(strokes, doubleLine, lineElements, lineSymbolsLayer, colorIds)
    } else if (hasArea) {
      record.areaSymbol = buildXmapAreaSymbol(fills, hatches, structures, pointPatterns, colorIds)
    } else if (hasPoint) {
      record.pointSymbol = buildXmapPointSymbol(pointFill, pointStroke, pointElementsLayer, colorIds)
    } else if (hasText) {
      record.textSymbol = buildXmapTextSymbol(textLayer, symbol, colorIds)
    }
  }

  // Re-derive the xmap `type` byte from whichever body actually got
  // attached — `symbol.type` can be 'combined' even when we
  // ultimately emit a plain <line_symbol>/<area_symbol>. Mirroring the
  // reader's `symbolTypeName` priority (text > point > area > line >
  // combined) keeps first-write and second-write in agreement.
  if (record.combinedSymbol) record.type = 16
  else if (record.textSymbol) record.type = 8
  else if (record.pointSymbol) record.type = 1
  else if (record.areaSymbol) record.type = 4
  else if (record.lineSymbol) record.type = 2

  return record
}

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
  const decoded = primary?.lineStyle !== undefined
    ? decodeLineStyleForXmap(primary.lineStyle)
    : {}

  const dash = primary?.dash
  const isDashed = dash && (dash.mainGap || dash.secGap || dash.dashLength || dash.breakLength)

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
    primary?.segmentLength
    ?? (lineElements?.mainLength as number | undefined)
    ?? (isDashed ? dashLength : 0)
  const endLength =
    primary?.endLength
    ?? (lineElements?.endLength as number | undefined)
    ?? 0

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
  const primaryWidth = (primary?.width ?? 0)
    || (doubleLine?.centerWidth ?? 0)

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
        color?: unknown; width?: number; shift?: number;
        dashed?: boolean; dashLength?: number; breakLength?: number;
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
    const dl = doubleLine as DoubleLineLayer & { dashLength?: number; breakLength?: number }
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
        color: leftC, width: leftW, shift: 0,
        dashed: leftDashed || undefined,
        dashLength: leftDashed ? dashLength : undefined,
        breakLength: leftDashed ? breakLength : undefined,
      } as OmapLineBorder)
    }
    if (rightW > 0) {
      out.push({
        color: rightC, width: rightW, shift: 0,
        dashed: rightDashed || undefined,
        dashLength: rightDashed ? dashLength : undefined,
        breakLength: rightDashed ? breakLength : undefined,
      } as OmapLineBorder)
    }
    return out.length ? out : undefined
  }
  return undefined
}

function buildXmapAreaSymbol(
  fills: FillLayer[],
  hatches: HatchLayer[],
  structures: StructureLayer[],
  pointPatterns: PointPatternLayer[],
  colorIds: Map<string | number, number>,
): OmapAreaSymbol {
  const primaryFill = fills[0]
  const innerColor = primaryFill
    ? colorRef(primaryFill.colorId, colorIds)
    : -1

  const patterns: OmapAreaPattern[] = []

  for (const h of hatches) {
    patterns.push({
      type: 1,
      // xmap stores hatch angle in RADIANS; uses degrees
      angle: (h.angle ?? 0) * Math.PI / 180,
      lineSpacing: h.spacing ?? 0,
      pointDistance: 0,
      lineOffset: 0,
      offsetAlongLine: 0,
      color: colorRef(h.colorId, colorIds),
      lineWidth: h.lineWidth ?? 0,
      rotatable: !!h.rotatable,
    } as OmapAreaPattern)
  }

  for (const s of structures) {
    // OCAD structMode 1 = aligned rows, 2 = shifted rows. Mapper's XMap
    // export represents "shifted rows" as TWO patterns of type=2 with
    // the second one offset by half in both axes — this is what
    // `isShiftedRows` on the OCD synth side detects to set structMode=2.
    // Emitting a single type=3 pattern would be lossy: the OCD reader
    // would read it back as structMode=1 and elements would collapse
    // onto a single row.
    const mode = s.mode ?? 1
    const pointDistance = s.symbolWidth ?? s.width ?? 0
    const lineSpacing = mode === 2
      ? (s.symbolHeight ?? 0) * 2
      : (s.symbolHeight ?? 0)
    const angleRad = (s.angle ?? 0) * Math.PI / 180
    const color = colorRef(s.colorId, colorIds)
    const rotatable = !!s.rotatable
    const nested = ocadElementsToXmapPointSymbol(s.elements ?? [], colorIds)
    const noClipping = s.noClipping ?? 0

    patterns.push({
      type: 2,
      angle: angleRad,
      lineSpacing,
      pointDistance,
      lineOffset: 0,
      offsetAlongLine: 0,
      color,
      lineWidth: 0,
      rotatable,
      noClipping,
      symbol: nested,
    } as OmapAreaPattern & { noClipping?: number })

    if (mode === 2) {
      patterns.push({
        type: 2,
        angle: angleRad,
        lineSpacing,
        pointDistance,
        lineOffset: lineSpacing / 2,
        offsetAlongLine: pointDistance / 2,
        color,
        lineWidth: 0,
        rotatable,
        noClipping,
        symbol: nested,
      } as OmapAreaPattern & { noClipping?: number })
    }
  }

  for (const p of pointPatterns) {
    const nested = p.pattern?.symbol as OmapSymbol | undefined
    const pat = p.pattern as {
      lineSpacing?: number; pointDistance?: number;
      lineOffset?: number; offsetAlongLine?: number;
      noClipping?: number; rotatable?: boolean;
    } | undefined
    patterns.push({
      type: 2,
      angle: (p.angle ?? 0) * Math.PI / 180,
      // Prefer the nested pattern's spacing over the layer's top-level
      // `width`/`height`. In the shifted-rows case the layer height is the
      // OCAD `structHeight` (half the tile) while the pattern encodes the
      // full lineSpacing — using `p.height` collapsed mode=2 to mode=1.
      lineSpacing: pat?.lineSpacing ?? p.height ?? 0,
      pointDistance: pat?.pointDistance ?? p.width ?? 0,
      // Preserve the pattern's row/column offsets so shifted-rows encoding
      // survives ocd→gitmap→xmap→ocd. The OCD writer's `isShiftedRows`
      // detects the mode=2 case by comparing these offsets between the two
      // paired patterns; a hardcoded 0 collapsed them to mode=1.
      lineOffset: pat?.lineOffset ?? 0,
      offsetAlongLine: pat?.offsetAlongLine ?? 0,
      color: colorRef(p.colorId, colorIds),
      lineWidth: 0,
      // Carry rotatability so the OMap reader's `patterns.some(p => p.rotatable)`
      // recovers the symbol-level rotatable flag.
      rotatable: !!pat?.rotatable,
      // OCAD's `structDraw` byte packs a clipping mode (bits 0-1); the OMap
      // writer's structures path preserves it and the OCD writer's
      // `patternClipMode` reads it back. Point-patterns need the same round-
      // trip — without this the OCAD writer defaults to `structDraw=2` for
      // structure-fills that were originally 0 (or vice versa).
      noClipping: pat?.noClipping,
      // Nested symbol comes from panmap gitmap where all colour refs
      // are string ids; OMAP requires numeric priorities or Mapper
      // renders in the "unknown colour" fallback (bright pink).
      symbol: nested ? rewriteSymbolColors(nested, colorIds) : nested,
    } as OmapAreaPattern & { noClipping?: number })
  }

  return {
    innerColor,
    patterns: patterns.length ? patterns : undefined,
  }
}

/**
 * Read the Panmap rotatable flag. Both readers (`ocad/to-map.ts` and
 * `xmap/to-map.ts`) surface the bit here, so consumers no longer need
 * to walk `native.*.raw` records — that's what let the writer's raw
 * passthrough retire.
 */
function isRotatableFromNative(symbol: MapSymbol): boolean {
  return !!symbol.rotatable
}

function buildXmapPointSymbol(
  pointFill: RenderLayer | undefined,
  pointStroke: RenderLayer | undefined,
  pointElements: RenderLayer | undefined,
  colorIds: Map<string | number, number>,
  rotatable = false,
): OmapPointSymbol {
  const innerColor = pointFill
    ? colorRef(pointFill.colorId, colorIds)
    : -1
  const innerRadius = (pointFill?.radius as number | undefined)
    ?? (pointStroke?.radius as number | undefined) ?? 0
  const outerColor = pointStroke
    ? colorRef(pointStroke.colorId, colorIds)
    : -1
  const outerWidth = (pointStroke?.width as number | undefined) ?? 0

  const elementsRaw = (pointElements?.elements as unknown[] | undefined) ?? []
  const nested = ocadElementsToXmapPointSymbol(elementsRaw, colorIds)
  return {
    innerColor,
    innerRadius,
    outerColor,
    outerWidth,
    rotatable,
    elements: nested?.pointSymbol?.elements,
  } as OmapPointSymbol
}

/**
 * Turn a flat array of OCAD point-elements (from `primSymElements` /
 * `elements` / etc.) into an xmap-shaped `<point_symbol>` record. Each
 * OCAD element becomes one nested `<element>` block containing an inline
 * `<symbol>` describing the shape's line / area / point drawing and an
 * `<object>` carrying the coords.
 *
 * OCAD element types (`element.type`):
 *   1 = line      → object type=1 + line_symbol
 *   2 = area      → object type=1 + area_symbol
 *   3 = circle    → object type=0 + point_symbol with outer_color/outer_width (ring)
 *   4 = dot       → object type=0 + point_symbol with inner_color (filled)
 */
function ocadElementsToXmapPointSymbol(
  elements: unknown[],
  colorIds: Map<string | number, number>,
): OmapSymbol | undefined {
  if (!elements?.length) return undefined
  // Two element shapes reach here:
  //   • OCAD-shaped (from OCD reader): `{ type, color, coords, ... }`.
  //     Convert via `ocadElementToXmapElement`.
  //   • xmap-shaped (from XMap reader): `{ symbol, object }` already
  //     in xmap's nested form. Pass through untouched — otherwise the
  //     ocad-only conversion silently drops them (missing `type` field
  //     → returns null → elements collapses to empty).
  const isXmapShaped = (el: unknown): el is { symbol: OmapSymbol; object: OmapObject } =>
    !!el && typeof el === 'object' && 'symbol' in el && 'object' in el
  const converted: Array<{ symbol: OmapSymbol; object: OmapObject }> = []
  for (const el of elements) {
    if (isXmapShaped(el)) {
      // XMap-shaped nested elements came from gitmap where all colour
      // references were replaced with string ids (e.g.
      // `color_white_over_green_and_brown_17`). OMAP requires numeric
      // priorities. Rewrite the nested symbol's colours before
      // passthrough — otherwise Mapper renders these primitives in the
      // "unknown colour" fallback (bright pink/magenta).
      converted.push({
        symbol: rewriteSymbolColors(el.symbol, colorIds),
        object: el.object,
      })
    } else {
      const ocadEl = ocadElementToXmapElement(el, colorIds)
      if (ocadEl) converted.push(ocadEl)
    }
  }
  if (!converted.length) return undefined
  return {
    id: -1,
    type: 1,
    pointSymbol: {
      innerColor: -1,
      innerRadius: 0,
      outerColor: -1,
      outerWidth: 0,
      rotatable: false,
      elements: converted,
    },
  }
}

function rewriteSymbolColors(
  symbol: OmapSymbol,
  colorIds: Map<string | number, number>,
): OmapSymbol {
  const rewriteColor = (c: unknown): unknown =>
    (typeof c === 'string') ? colorRef(c, colorIds) : c
  const out: OmapSymbol = { ...symbol }
  const ps = symbol.pointSymbol as (Record<string, unknown> | undefined)
  if (ps) {
    out.pointSymbol = {
      ...ps,
      innerColor: rewriteColor(ps.innerColor),
      outerColor: rewriteColor(ps.outerColor),
      elements: Array.isArray(ps.elements)
        ? (ps.elements as Array<{symbol: OmapSymbol; object: OmapObject}>).map(el => ({
            symbol: rewriteSymbolColors(el.symbol, colorIds),
            object: el.object,
          }))
        : ps.elements,
    } as typeof symbol.pointSymbol
  }
  const ls = symbol.lineSymbol as (Record<string, unknown> | undefined)
  if (ls) {
    out.lineSymbol = { ...ls, color: rewriteColor(ls.color) } as typeof symbol.lineSymbol
  }
  const as = symbol.areaSymbol as (Record<string, unknown> | undefined)
  if (as) {
    out.areaSymbol = {
      ...as,
      innerColor: rewriteColor((as as { innerColor?: unknown }).innerColor ?? (as as { color?: unknown }).color),
    } as typeof symbol.areaSymbol
  }
  return out
}

function ocadElementToXmapElement(
  el: unknown,
  colorIds: Map<string | number, number>,
): { symbol: OmapSymbol; object: OmapObject } | null {
  const e = el as {
    type?: number; flags?: number; color?: number; lineWidth?: number;
    diameter?: number; coords?: Coord[];
  }
  if (!e || e.type === undefined) return null

  // Coordinates on OCAD point-elements arrive as TdPoly tuples ([x, y])
  // while xmap-native elements use { x, y } objects. Accept both so we
  // don't silently truncate coords on the ocd→xmap path. Also flip Y —
  // OCAD is Y-up, XMap is Y-down; synth-symbols un-flips on the way
  // back to OCD via `flipY = sourceFormat !== 'ocad'`.
  const coords = (e.coords ?? []).map(c => ({
    x: coordX(c),
    y: -coordY(c),
    flags: coordFlags(c) || undefined,
  }))
  const c = colorRef(e.color, colorIds)
  // OCAD line-element `flags` byte packs cap+join style:
  //   bit 0 (0x01) = RoundCap, bit 2 (0x04) = MiterJoin
  // Decode so xmap emits cap_style/join_style and Mapper's re-export
  // reconstructs the same OCAD flags. Contour slope lines (101/102/103)
  // ship with flags=4 (miter join) so this bit is a common one.
  const elFlags = e.flags ?? 0
  const elCap = (elFlags & 0x01) ? 1 : 0
  const elJoin = (elFlags & 0x04) ? 1 : 0

  if (e.type === 1) {
    // line
    return {
      symbol: {
        id: -1,
        type: 2,
        lineSymbol: {
          color: c,
          lineWidth: e.lineWidth ?? 0,
          minimumLength: 0,
          dashed: false,
          dashLength: 4,
          breakLength: 1,
          dashesInGroup: 1,
          inGroupBreakLength: 0.5,
          endLength: 0,
          segmentLength: 4,
          startOffset: 0,
          endOffset: 0,
          showAtLeastOneSymbol: true,
          midSymbolsPerSpot: 1,
          midSymbolDistance: 0,
          midSymbolPlacement: 0,
          minimumMidSymbolCount: 0,
          minimumMidSymbolCountWhenClosed: 0,
          suppressDashSymbolAtEnds: false,
          scaleDashSymbol: true,
          capStyle: elCap,
          joinStyle: elJoin,
        } as OmapLineSymbol,
      } as OmapSymbol,
      object: { type: 1, symbol: 0, coords, text: null, textBox: null } as OmapObject,
    }
  }

  if (e.type === 2) {
    // area
    return {
      symbol: {
        id: -1,
        type: 4,
        areaSymbol: { innerColor: c, patterns: undefined },
      } as OmapSymbol,
      object: { type: 1, symbol: 0, coords, text: null, textBox: null } as OmapObject,
    }
  }

  if (e.type === 3 || e.type === 4) {
    // circle (3) or dot (4)
    const filled = e.type === 4
    const dia = e.diameter ?? 0
    return {
      symbol: {
        id: -1,
        type: 1,
        pointSymbol: {
          innerColor: filled ? c : -1,
          innerRadius: filled ? dia / 2 : Math.max(0, dia / 2 - (e.lineWidth ?? 0) / 2),
          outerColor: filled ? -1 : c,
          outerWidth: filled ? 0 : (e.lineWidth ?? 0),
          rotatable: false,
        } as OmapPointSymbol,
      } as OmapSymbol,
      object: { type: 0, symbol: 0, coords, text: null, textBox: null } as OmapObject,
    }
  }

  return null
}

function buildXmapTextSymbol(
  textLayer: RenderLayer | undefined,
  symbol: MapSymbol,
  colorIds: Map<string | number, number>,
  rotatable = false,
): OmapTextSymbol {
  const typo = textLayer?.text as
    | {
        fontFamily?: string; fontSize?: number;
        fontWeight?: number; italic?: boolean;
        lineSpace?: number; paraSpace?: number; charSpace?: number;
      }
    | undefined
  const family = typo?.fontFamily
    ?? (textLayer?.fontFamily as string | undefined)
    ?? 'Arial'
  const size = typo?.fontSize
    ?? (textLayer?.fontSize as number | undefined)
    ?? (symbol.fontSize as number | undefined)
    ?? 12
  const bold = typo?.fontWeight !== undefined ? typo.fontWeight >= 700 : false
  const italic = typo?.italic ?? false
  return {
    color: colorRef(textLayer?.colorId, colorIds),
    fontFamily: family,
    fontSize: size,
    bold,
    italic,
    rotatable,
    lineSpacing: typo?.lineSpace,
    paragraphSpacing: typo?.paraSpace,
    characterSpacing: typo?.charSpace,
  } as OmapTextSymbol
}
function omapSymbolType(symbol: MapSymbol): number {
  if (symbol.type === 'point') return 1
  if (symbol.type === 'line') return 2
  if (symbol.type === 'area') return 4
  if (symbol.type === 'text' || symbol.type === 'line-text') return 8
  return 0
}

function omapObjectType(object: MapObject): number {
  if (object.type === 'point') return 0
  if (object.type === 'text' || object.type === 'line-text') return 4
  return 1
}
const colorRef = colorRefLookup
const colorIdMap = buildColorIdMap

// Panmap allows multiple MapSymbols to share the same `symbol.id`
// (e.g. two "201.2" variants). OMAP requires each <symbol id="…"/> to
// be unique. Allocate a unique numeric id per symbol *instance* (not
// per symbol.id key): prefer sourceId when it's unique so ocd/xmap
// round-trips stay stable, otherwise fall back to the next free slot
// above the max claimed sourceId.
function symbolIdMap(symbols: MapSymbol[]): Map<MapSymbol, number> {
  const map = new Map<MapSymbol, number>()
  const used = new Set<number>()
  const preferred: Array<{ symbol: MapSymbol; wanted: number | null }> = []
  let maxUsed = 0
  for (const symbol of symbols) {
    const sourceId = Number(symbol.sourceId)
    const ownId = Number(symbol.id)
    const wanted = Number.isFinite(sourceId) ? sourceId
      : Number.isFinite(ownId) ? ownId : null
    preferred.push({ symbol, wanted })
    if (wanted !== null) maxUsed = Math.max(maxUsed, wanted)
  }
  for (const { symbol, wanted } of preferred) {
    if (wanted !== null && !used.has(wanted)) {
      used.add(wanted)
      map.set(symbol, wanted)
    } else {
      const id = ++maxUsed
      used.add(id)
      map.set(symbol, id)
    }
  }
  return map
}

export {
  toOmapSymbol,
  colorIdMap,
  colorRef,
  symbolIdMap,
  omapObjectType,
  omapSymbolType,
}
