/**
 * `MapSymbol` → intermediate XMap symbol record (`toOmapSymbol`).
 *
 * The top-level `toOmapSymbol` reads as a dispatch: it classifies the
 * symbol's render layers, then tries the combined-symbol cases in order
 * (double-line split, area+border, area+bank-line) before falling back
 * to the plain single-body path, a last-resort body, and a final
 * type-byte re-derivation. Each case lives in its own helper below.
 *
 * The XML emission itself lives in `../encode.ts`. This module only
 * builds the record shape; nothing here formats XML.
 */
import {
  classifyAreaLayers,
  classifyLineLayers,
  classifyPointLayers,
  classifyTextLayers,
} from '../../../../panmap/render-layers.js'
import type { StrokeLayer } from '../../../../panmap/render-layers.js'
import type { MapSymbol } from '../../../../panmap/model.js'
import type { OmapLineSymbol, OmapSymbol } from '../../native.js'
import {
  pickMainStroke,
  strokeVisible,
} from '../../../../panmap/stroke-classifier.js'
import { decodeLineStyle as decodeLineStyleForXmap } from '../../../ocad/codecs/line-style.js'
import type { RawOmapSymbol } from './types.js'
import { colorRef } from './colors.js'
import { buildXmapLineSymbol, extractBorders } from './line.js'
import { buildXmapAreaSymbol } from './area.js'
import { buildXmapPointSymbol } from './point.js'
import { buildXmapTextSymbol } from './text.js'
import { omapSymbolType } from './object-type.js'

type ColorIds = Map<string | number, number>

/**
 * Classify a symbol's render layers into the buckets the case helpers
 * consume, plus the coarse `hasLine`/`hasArea`/`hasPoint`/`hasText`
 * flags derived from them.
 */
function classifySymbol(symbol: MapSymbol) {
  const {
    fills,
    hatches,
    structures,
    pointPatterns,
    strokes,
    border: borderSymbolLayer,
  } = classifyAreaLayers(symbol)
  const {
    doubleLine,
    lineElements,
    lineSymbols: lineSymbolsLayer,
  } = classifyLineLayers(symbol)
  const {
    fill: pointFill,
    stroke: pointStroke,
    elements: pointElementsLayer,
  } = classifyPointLayers(symbol)
  const { text: textLayer } = classifyTextLayers(symbol)

  const t = symbol.type
  const hasLine =
    strokes.length > 0 || !!doubleLine || !!lineElements || !!lineSymbolsLayer
  const hasArea =
    fills.length > 0 ||
    hatches.length > 0 ||
    structures.length > 0 ||
    pointPatterns.length > 0
  const hasPoint = !!pointFill || !!pointStroke || !!pointElementsLayer
  const hasText = !!textLayer

  return {
    fills,
    hatches,
    structures,
    pointPatterns,
    strokes,
    borderSymbolLayer,
    doubleLine,
    lineElements,
    lineSymbolsLayer,
    pointFill,
    pointStroke,
    pointElementsLayer,
    textLayer,
    t,
    hasLine,
    hasArea,
    hasPoint,
    hasText,
  }
}

type ClassifiedSymbol = ReturnType<typeof classifySymbol>

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
  colorIds: ColorIds,
): RawOmapSymbol {
  const ctx = classifySymbol(symbol)

  const record: RawOmapSymbol = {
    id,
    code: symbol.code,
    name: symbol.name,
    type: omapSymbolType(symbol),
    // Round-trip Mapper's UI-hide flag. `xmapSymbolToXml` reads
    // `isHidden` and emits `is_hidden="true"` when truthy.
    isHidden: symbol.hidden || undefined,
  }

  if (tryDoubleLineSplit(record, ctx, symbol, colorIds)) return record
  if (tryAreaWithBorder(record, ctx, symbol, colorIds)) return record
  if (tryAreaWithBankLine(record, ctx, symbol, colorIds)) return record

  applyPlainBodies(record, ctx, symbol, colorIds)
  applyFallbackBody(record, ctx, symbol, colorIds)
  rederiveSymbolType(record)

  return record
}

/**
 * OCAD "double line" or "frame" line-symbol idiom → XMap
 * `<combined_symbol>`. Returns `true` (and fills `record`) when the
 * split applies; `false` to fall through to the plain path.
 */
function tryDoubleLineSplit(
  record: RawOmapSymbol,
  ctx: ClassifiedSymbol,
  symbol: MapSymbol,
  colorIds: ColorIds,
): boolean {
  const { strokes, doubleLine, lineElements, lineSymbolsLayer, t } = ctx

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
  const frameStroke =
    strokes.find(s => s.frame) ?? strokes.find(isFrameCandidate)
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
    ? strokes.find(
        s =>
          s !== primaryVisibleForBorderSearch &&
          Array.isArray(s.borders) &&
          s.borders.length > 0,
      )
    : undefined
  if (
    (t === 'line' || t === 'combined') &&
    (doubleLine || frameStroke || borderCarrierStroke)
  ) {
    const dl = doubleLine
    const fillC = dl ? colorRef(dl.fillColorId, colorIds) : -1
    const frameC = frameStroke ? colorRef(frameStroke.colorId, colorIds) : -1
    const carrierC = borderCarrierStroke
      ? colorRef(borderCarrierStroke.colorId, colorIds)
      : -1
    // Emit combined when there's a visible fill or frame, OR when the
    // double-line has borders but no fill (stairway 532: color=-1 on
    // the fill line, borders on either side). Emitting as a plain line
    // in that case would put the borders directly on the visible
    // primary → Mapper's OCD encoding would set dblWidth = primary.
    // width instead of the invisible fill's width, losing 1mm per side.
    const dlHasBorders =
      !!dl && ((dl.leftWidth ?? 0) > 0 || (dl.rightWidth ?? 0) > 0)
    const carrierHasBorders =
      !!borderCarrierStroke &&
      Array.isArray(borderCarrierStroke.borders) &&
      borderCarrierStroke.borders.length > 0
    if (
      fillC > 0 ||
      frameC > 0 ||
      carrierC > 0 ||
      dlHasBorders ||
      carrierHasBorders
    ) {
      // Prefer strokes that are NOT the frame carrier as "primary".
      // The frame stroke, when present, was surfaced from OCAD's fr*
      // fields and is drawn UNDER the main line — not the top layer.
      const nonFrameStrokes = strokes.filter(
        s => !s.frame && s !== borderCarrierStroke,
      )
      const primary =
        nonFrameStrokes.find(s => strokeVisible(s)) ??
        nonFrameStrokes[0] ??
        strokes[0]
      const mainLine = buildXmapLineSymbol(
        primary ? [primary] : [],
        undefined,
        lineElements,
        lineSymbolsLayer,
        colorIds,
      )
      // Inherit cap/join from the source stroke so lineStyle round-trips.
      // OCAD stores one `lineStyle` byte per line-symbol; both the visible
      // main line and the fill share it. Xmap's cap_style/join_style
      // attributes on the fill part must match what the primary carried
      // or the round-trip re-encodes to a different lineStyle.
      const strokeCapJoin =
        primary?.lineStyle !== undefined
          ? decodeLineStyleForXmap(primary.lineStyle)
          : { capStyle: primary?.capStyle, joinStyle: primary?.joinStyle }
      // Width and color: prefer doubleLine's fill fields when present;
      // fall back to the border-carrier stroke's own (gitmap-canonical
      // double-line), then the frame stroke's, otherwise invisible.
      const fillColorNumeric =
        fillC > 0 ? fillC : carrierC > 0 ? carrierC : frameC > 0 ? frameC : -1
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
          : borderCarrierStroke
            ? extractBorders(borderCarrierStroke, undefined, colorIds)
            : undefined,
      } as OmapLineSymbol
      record.type = 16
      record.combinedSymbol = {
        parts: [
          {
            symbol: {
              id: -1,
              type: 2,
              code: symbol.code,
              name: `${symbol.name ?? ''} - main line`,
              lineSymbol: mainLine,
            } as OmapSymbol,
          },
          {
            symbol: {
              id: -1,
              type: 2,
              code: symbol.code,
              name: `${symbol.name ?? ''} - double line`,
              lineSymbol: fillLine,
            } as OmapSymbol,
          },
        ],
      }
      return true
    }
  }
  return false
}

/**
 * Area + border-symbol: OCAD encodes areas with a coloured border as
 * an area-symbol with `borderSym` pointing at a separate line symbol.
 * XMap has no such reference on `<area_symbol>`; instead Mapper
 * exports the same shape as a `<combined_symbol>` with two parts:
 * (1) private area, (2) reference to the border line symbol. We do
 * the same so the border survives the ocd → xmap → ocd trip.
 */
function tryAreaWithBorder(
  record: RawOmapSymbol,
  ctx: ClassifiedSymbol,
  symbol: MapSymbol,
  colorIds: ColorIds,
): boolean {
  const {
    t,
    hasArea,
    borderSymbolLayer,
    fills,
    hatches,
    structures,
    pointPatterns,
  } = ctx
  if ((t === 'area' || t === 'combined') && hasArea && borderSymbolLayer) {
    const borderRef = borderSymbolLayer.symbolId
    const areaBody = buildXmapAreaSymbol(
      fills,
      hatches,
      structures,
      pointPatterns,
      colorIds,
    )
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
        {
          symbolRef:
            typeof borderRef === 'number' ? borderRef : Number(borderRef),
        },
      ],
    }
    return true
  }
  return false
}

/**
 * Combined "area + inline bank line" (xmap `<combined_symbol>` with a
 * private area part and a private line part — e.g. ISOM 301
 * "Uncrossable body of water, with bank line"). No border-symbol
 * reference, so the earlier path doesn't apply. Emit as combined_symbol
 * with two inline parts instead of collapsing to `<line_symbol>` +
 * `<area_symbol>` on the same root — Mapper reads that as area-only
 * (loses the bank line) and idempotence breaks.
 */
function tryAreaWithBankLine(
  record: RawOmapSymbol,
  ctx: ClassifiedSymbol,
  symbol: MapSymbol,
  colorIds: ColorIds,
): boolean {
  const {
    t,
    hasArea,
    hasLine,
    fills,
    hatches,
    structures,
    pointPatterns,
    strokes,
    doubleLine,
    lineElements,
    lineSymbolsLayer,
  } = ctx
  if (t === 'combined' && hasArea && hasLine) {
    const areaBody = buildXmapAreaSymbol(
      fills,
      hatches,
      structures,
      pointPatterns,
      colorIds,
    )
    const lineBody = buildXmapLineSymbol(
      strokes,
      doubleLine,
      lineElements,
      lineSymbolsLayer,
      colorIds,
    )
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
        {
          symbol: {
            id: -1,
            type: 2,
            code: symbol.code,
            name: symbol.name,
            lineSymbol: lineBody,
          } as OmapSymbol,
        },
      ],
    }
    return true
  }
  return false
}

/**
 * Plain single-body path: attach whichever body the declared `type`
 * calls for (line / area / point / text).
 */
function applyPlainBodies(
  record: RawOmapSymbol,
  ctx: ClassifiedSymbol,
  symbol: MapSymbol,
  colorIds: ColorIds,
): void {
  const {
    t,
    hasLine,
    hasArea,
    hasPoint,
    hasText,
    strokes,
    doubleLine,
    lineElements,
    lineSymbolsLayer,
    fills,
    hatches,
    structures,
    pointPatterns,
    pointFill,
    pointStroke,
    pointElementsLayer,
    textLayer,
  } = ctx

  if ((t === 'line' || t === 'combined') && hasLine) {
    record.lineSymbol = buildXmapLineSymbol(
      strokes,
      doubleLine,
      lineElements,
      lineSymbolsLayer,
      colorIds,
    )
  }
  if ((t === 'area' || t === 'combined') && hasArea) {
    record.areaSymbol = buildXmapAreaSymbol(
      fills,
      hatches,
      structures,
      pointPatterns,
      colorIds,
    )
  }
  if (t === 'point' && hasPoint) {
    record.pointSymbol = buildXmapPointSymbol(
      pointFill,
      pointStroke,
      pointElementsLayer,
      colorIds,
      isRotatableFromNative(symbol),
    )
  }
  if ((t === 'text' || t === 'line-text') && hasText) {
    record.textSymbol = buildXmapTextSymbol(
      textLayer,
      symbol,
      colorIds,
      isRotatableFromNative(symbol),
    )
  }
}

/**
 * Fallback: if the declared type didn't produce a body, fall back to
 * whichever layer bucket has something. Prevents the writer from
 * emitting an empty <symbol/> for a symbol that just happens to have
 * a `type` we didn't match cleanly (e.g. OCAD "combined" symbols).
 */
function applyFallbackBody(
  record: RawOmapSymbol,
  ctx: ClassifiedSymbol,
  symbol: MapSymbol,
  colorIds: ColorIds,
): void {
  const {
    hasLine,
    hasArea,
    hasPoint,
    hasText,
    strokes,
    doubleLine,
    lineElements,
    lineSymbolsLayer,
    fills,
    hatches,
    structures,
    pointPatterns,
    pointFill,
    pointStroke,
    pointElementsLayer,
    textLayer,
  } = ctx

  if (
    !record.lineSymbol &&
    !record.areaSymbol &&
    !record.pointSymbol &&
    !record.textSymbol
  ) {
    if (hasLine) {
      record.lineSymbol = buildXmapLineSymbol(
        strokes,
        doubleLine,
        lineElements,
        lineSymbolsLayer,
        colorIds,
      )
    } else if (hasArea) {
      record.areaSymbol = buildXmapAreaSymbol(
        fills,
        hatches,
        structures,
        pointPatterns,
        colorIds,
      )
    } else if (hasPoint) {
      record.pointSymbol = buildXmapPointSymbol(
        pointFill,
        pointStroke,
        pointElementsLayer,
        colorIds,
      )
    } else if (hasText) {
      record.textSymbol = buildXmapTextSymbol(textLayer, symbol, colorIds)
    }
  }
}

/**
 * Re-derive the xmap `type` byte from whichever body actually got
 * attached — `symbol.type` can be 'combined' even when we
 * ultimately emit a plain <line_symbol>/<area_symbol>. Mirroring the
 * reader's `symbolTypeName` priority (text > point > area > line >
 * combined) keeps first-write and second-write in agreement.
 */
function rederiveSymbolType(record: RawOmapSymbol): void {
  if (record.combinedSymbol) record.type = 16
  else if (record.textSymbol) record.type = 8
  else if (record.pointSymbol) record.type = 1
  else if (record.areaSymbol) record.type = 4
  else if (record.lineSymbol) record.type = 2
}

/**
 * Read the Panmap rotatable flag. Both readers (`ocad/reader/to-panmap.ts`
 * and `omap/reader/to-panmap.ts`) surface the bit here, so consumers no longer need
 * to walk `native.*.raw` records — that's what let the writer's raw
 * passthrough retire.
 */
function isRotatableFromNative(symbol: MapSymbol): boolean {
  return !!symbol.rotatable
}

export { toOmapSymbol }
