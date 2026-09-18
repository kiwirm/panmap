import type { MapSymbol } from '../../../../../panmap/model.js'
import { classifyLineLayers } from '../../../../../panmap/render-layers.js'
import type {
  StrokeLayer,
  DoubleLineLayer,
} from '../../../../../panmap/render-layers.js'
import { encodeLineStyle } from '../../../codecs/line-style.js'
import {
  strokeColorValid,
  pickMainStroke,
  mainStrokeVisible,
} from '../../../../../panmap/stroke-classifier.js'
import type { ColorNumber } from './shared.js'
import { normUnits } from './shared.js'
import { pointElementFromXmap } from './point.js'

function frameFields(
  primary: StrokeLayer | undefined,
  strokes: StrokeLayer[],
  colorNumber: ColorNumber,
  doubleLine: { dblFillColor: number },
): { frColor: number; frWidth: number; frStyle: number } {
  // The OCD reader flags the frame stroke explicitly (`frame: true`;
  // see reader/to-panmap.ts). Prefer that marker over "any other visible
  // non-dashed stroke", which used to miss frames on non-dashed primary
  // lines (e.g. ISOM 502.0 Motorway — frame under a double-line, primary
  // stroke has no dash but Mapper still records frColor=16 / frWidth=126).
  const framed = strokes.find(
    s => (s as StrokeLayer & { frame?: boolean }).frame,
  )
  if (framed && strokeColorValid(framed)) {
    // The OCD reader stashes the raw frStyle byte on the frame stroke's
    // `lineStyle` field (capStyle / joinStyle stay undefined). Prefer
    // the raw byte when it's there so it round-trips verbatim; fall back
    // to re-packing cap/join for xmap-sourced framed lines that arrive
    // with the decoded fields instead.
    const frStyle =
      typeof framed.lineStyle === 'number'
        ? framed.lineStyle
        : encodeLineStyle(framed.capStyle, framed.joinStyle)
    return {
      frColor: colorNumber(framed.colorId),
      frWidth: normUnits(framed.width),
      frStyle,
    }
  }
  // Fallback for xmap-native / gitmap-round-tripped lines that don't
  // carry the `frame` marker: the frame is any visible non-dashed
  // stroke that isn't the primary, and only meaningful when the
  // primary itself is dashed (matches OCD's "frame under a dashed
  // main line" idiom — ara 509.1 style). Skip the fallback when a
  // double-line is present — its border stroke would falsely register
  // as a frame (Mapper's `<combined_symbol>` path/road symbols like
  // hillmorton 501.11 Paved footpath have a dashed main line PLUS a
  // solid double-line border, no frame).
  if (!primary?.dash) return { frColor: 0, frWidth: 0, frStyle: 0 }
  if (doubleLine.dblFillColor > 0)
    return { frColor: 0, frWidth: 0, frStyle: 0 }
  const frame = strokes.find(
    s => s !== primary && strokeColorValid(s) && !s.dash,
  )
  if (!frame) return { frColor: 0, frWidth: 0, frStyle: 0 }
  return {
    frColor: colorNumber(frame.colorId),
    frWidth: normUnits(frame.width),
    frStyle: encodeLineStyle(frame.capStyle, frame.joinStyle),
  }
}

/**
 * Rebuild the OCAD double-line block from a `double-line`
 * render layer emitted by the OCAD reader. The layer already carries
 * OCAD-shaped field values (mode/flags/widths/colours + dash rhythm),
 * so this is a straight copy.
 */
function doubleLineFromCanonical(
  layer: DoubleLineLayer,
  colorNumber: ColorNumber,
): {
  dblMode: number
  dblFlags: number
  dblFillColor: number
  dblLeftColor: number
  dblRightColor: number
  dblWidth: number
  dblLeftWidth: number
  dblRightWidth: number
  dblLength: number
  dblGap: number
  dblRes: [number, number]
} {
  const l = layer as DoubleLineLayer & {
    flags?: number
    dashLength?: number
    breakLength?: number
  }
  return {
    dblMode: l.mode ?? 0,
    dblFlags: l.flags ?? 0,
    dblFillColor: l.fillColorId != null ? colorNumber(l.fillColorId) : 0,
    dblLeftColor: l.leftColorId != null ? colorNumber(l.leftColorId) : 0,
    dblRightColor: l.rightColorId != null ? colorNumber(l.rightColorId) : 0,
    dblWidth: l.centerWidth ?? 0,
    dblLeftWidth: l.leftWidth ?? 0,
    dblRightWidth: l.rightWidth ?? 0,
    dblLength: l.dashLength ?? 0,
    dblGap: l.breakLength ?? 0,
    dblRes: [0, 0],
  }
}

/**
 * Build the OCAD double-line block from the stroke layers. Xmap stores
 * "borders" as `{color, width, shift}` on each stroke; OCAD encodes
 * `dblLeftColor + dblLeftWidth` / `dblRightColor + dblRightWidth`
 * around a central fill (`dblWidth`, `dblFillColor`).
 */
export function deriveDoubleLine(
  strokes: StrokeLayer[],
  primary: StrokeLayer | undefined,
  colorNumber: ColorNumber,
  primaryVisible: boolean,
): {
  dblMode: number
  dblFlags: number
  dblFillColor: number
  dblLeftColor: number
  dblRightColor: number
  dblWidth: number
  dblLeftWidth: number
  dblRightWidth: number
  dblLength: number
  dblGap: number
  dblRes: [number, number]
} {
  const empty = {
    dblMode: 0,
    dblFlags: 0,
    dblFillColor: 0,
    dblLeftColor: 0,
    dblRightColor: 0,
    dblWidth: 0,
    dblLeftWidth: 0,
    dblRightWidth: 0,
    dblLength: 0,
    dblGap: 0,
    dblRes: [0, 0] as [number, number],
  }
  let borderStroke: StrokeLayer | undefined = strokes.find(s => {
    const b = s.borders
    return Array.isArray(b) && b.length > 0
  })
  let borders = borderStroke?.borders as
    | Array<{
        color: number
        width: number
        shift: number
        dashed?: boolean
        dashLength?: number
        breakLength?: number
      }>
    | undefined
  if (!borderStroke) {
    const primaryDashed = !!primary?.dash
    if (!primaryDashed) {
      borderStroke = strokes.find(s => s !== primary && strokeColorValid(s))
      borders = borders ?? []
    }
  }
  if (!borderStroke) return empty
  if (!borders) borders = []

  const left = borders[0]
  const right = borders[1] ?? borders[0]
  const isValidColor = (v: unknown): boolean => {
    if (v === undefined || v === null) return false
    if (typeof v === 'number') return v >= 0
    return typeof v === 'string' && v.length > 0
  }
  const leftValid = left ? isValidColor(left.color) : false
  const rightValid = right ? isValidColor(right.color) : false
  const borderStrokeVisible =
    borderStroke !== primary && strokeColorValid(borderStroke)
  if (!leftValid && !rightValid && !borderStrokeVisible) return empty

  const fillWidth = normUnits(borderStroke?.width)
  let fillColor = 0
  const borderStrokeIsPrimary = borderStroke === primary
  if (!borderStrokeIsPrimary || !primaryVisible) {
    const rawFill = borderStroke?.colorId
    fillColor =
      rawFill === undefined || rawFill === null || Number(rawFill) < 0
        ? 0
        : colorNumber(rawFill)
  }
  const leftDashed = !!left?.dashed
  const rightDashed = !!right?.dashed
  let dblMode: 0 | 1 | 2 | 3 | 4 = 1
  if (leftDashed && rightDashed) dblMode = 3
  else if (leftDashed) dblMode = 2
  const dashSource = leftDashed ? left : rightDashed ? right : null
  const dashLen = normUnits(dashSource?.dashLength ?? 0)
  const gapLen = normUnits(dashSource?.breakLength ?? 0)
  const dblFlags = fillColor > 0 ? 1 : 0
  return {
    dblMode,
    dblFlags,
    dblFillColor: fillColor,
    dblLeftColor: leftValid ? colorNumber(left.color) : 0,
    dblRightColor: rightValid ? colorNumber(right.color) : 0,
    dblWidth: fillWidth,
    dblLeftWidth: leftValid ? normUnits(left.width) : 0,
    dblRightWidth: rightValid ? normUnits(right.width) : 0,
    dblLength: dashLen,
    dblGap: gapLen,
    dblRes: [0, 0],
  }
}

export function lineBody(
  symbol: MapSymbol,
  colorNumber: ColorNumber,
  flipY = false,
) {
  const {
    strokes,
    lineElements: lineElementsLayer,
    doubleLine: doubleLineLayer,
  } = classifyLineLayers(symbol)
  const primary = pickMainStroke(strokes)
  const doubleLine = doubleLineLayer
    ? doubleLineFromCanonical(doubleLineLayer, colorNumber)
    : deriveDoubleLine(
        strokes,
        primary,
        colorNumber,
        mainStrokeVisible(primary, strokes),
      )
  const mainMeta = strokes[0] !== primary ? strokes[0] : undefined
  const hasMidSymbol =
    !!lineElementsLayer &&
    Array.isArray(lineElementsLayer.primSymElements) &&
    lineElementsLayer.primSymElements.length > 0
  const rhythm = encodeDashRhythm(primary, mainMeta, {
    hasMidSymbol,
    spacing: lineElementsLayer?.spacing as number | undefined,
    endOffset: lineElementsLayer?.endOffset as number | undefined,
  })
  const visible = mainStrokeVisible(primary, strokes)
  const hasPrimary = !!primary
  return {
    lineColor: hasPrimary && visible ? colorNumber(primary!.colorId) : 0,
    lineWidth: hasPrimary && visible ? normUnits(primary!.width) : 0,
    lineStyle: encodePrimaryLineStyle(primary, mainMeta),
    // OCD's `distFromStart` / `distToEnd` = xmap's `start_offset` /
    // `end_offset`. On pointed-cap lines Mapper's xmap stores the same
    // value into `pointed_cap_length` as well, so the reader always
    // carries both fields on the stroke — prefer `startOffset` here
    // since that's the primary carrier, falling back to `pointedCapLength`
    // only when the source populated one but not the other.
    distFromStart:
      normUnits(
        primary?.startOffset ??
          (primary as { pointedCapLength?: number })?.pointedCapLength,
      ) || 0,
    distToEnd:
      normUnits(
        primary?.endOffset ??
          (primary as { pointedCapLength?: number })?.pointedCapLength,
      ) || 0,
    ...rhythm,
    minSym: primary?.showAtLeastOneSymbol === false ? -1 : 0,
    nPrimSym: primary?.midSymbolsPerSpot ?? 0,
    primSymDist: normUnits(primary?.midSymbolDistance) || 0,
    doubleLine,
    decrease: {
      decMode: 0,
      decSymbolSize: 0,
      decSymbolDistance: false,
      decSymbolWidth: false,
    },
    ...frameFields(primary, strokes, colorNumber, doubleLine),
    useSymbolFlags: encodeUseSymbolFlags(symbol),
    reserved: 0,
    // Both OCD-sourced and OMap-sourced maps expose line decorations
    // through the canonical `line-elements` layer (OMap reader flattens
    // its <mid_symbol>/<start_symbol>/etc. into these arrays at read
    // time). Gitmap-sourced elements arrive with `color` as a string
    // colorId; translate to an OCD palette slot via `colorNumber` so
    // dash/tag/etc. decorations render in the correct color instead of
    // defaulting to slot 0 (black). See also point-body's
    // `normaliseOcadElementColor`.
    primSymElements: mapElementColors(
      lineElementsLayer?.primSymElements,
      colorNumber,
    ),
    secSymElements: mapElementColors(
      lineElementsLayer?.secSymElements,
      colorNumber,
    ),
    cornerSymElements: mapElementColors(
      lineElementsLayer?.cornerSymElements,
      colorNumber,
    ),
    startSymElements: mapElementColors(
      lineElementsLayer?.startSymElements,
      colorNumber,
    ),
    endSymElements: mapElementColors(
      lineElementsLayer?.endSymElements,
      colorNumber,
    ),
  }
}

function encodeDashRhythm(
  primary: StrokeLayer | undefined,
  mainMeta: StrokeLayer | undefined,
  ctx: {
    hasMidSymbol: boolean
    spacing?: number
    endOffset?: number
  },
): {
  mainLength: number
  endLength: number
  mainGap: number
  secGap: number
  endGap: number
} {
  const dash = primary?.dash
  if (dash) {
    // Canonical model uses Mapper's semantic dash vocab
    // (dashLength/breakLength/dashesInGroup/inGroupBreakLength/
    // halfOuterDashes); encode into OCD's on-disk rhythm here. Keep
    // raw (fractional) values on both sides of the +/× before
    // running through `normUnits` once — the previous form rounded each
    // component separately, producing off-by-1 errors on half-integer
    // xmap values (castle-hill 507 dash_length=1875 → 187.5 → 188×2 = 376,
    // where Mapper's `round(1875×2 + 460 = 4210) / 10 = 421` gives 421).
    const dashLenRaw = Number(dash.dashLength) || 0
    const breakLenRaw = Number(dash.breakLength) || 0
    const dashesInGroup = dash.dashesInGroup ?? 1
    const inGroupBreakRaw = Number(dash.inGroupBreakLength) || 0
    const breakLen = normUnits(breakLenRaw)
    const inGroupBreak = normUnits(inGroupBreakRaw)
    const halfOuter = !!dash.halfOuterDashes
    if (dashesInGroup > 1) {
      // 2-dash group. mainLength packs both dashes plus the intra-group
      // break: mainLength = 2·dashLength + inGroupBreak; secGap = inGroupBreak;
      // mainGap = breakLength.
      const mainLengthRaw = 2 * dashLenRaw + inGroupBreakRaw
      const mainLength = normUnits(mainLengthRaw)
      return {
        mainLength,
        endLength: halfOuter ? normUnits(mainLengthRaw / 2) : mainLength,
        mainGap: breakLen,
        secGap: inGroupBreak,
        endGap: inGroupBreak,
      }
    }
    // 1-dash-per-group: two OCD encodings render the same visual, and
    // Mapper picks between them based on whether the line has mid-symbol
    // content:
    //   • no mid-symbol → straight repeat: mainLength=dashLen, mainGap=break.
    //   • has mid-symbol → 1-dash pairs encoding: mainLength=dashLen+break,
    //     mainGap=0, secGap=break. The mainLength then coincides with the
    //     mid-symbol placement cycle (Mapper's `endLength = mainLength / 2`
    //     for the mid-dot at the centre — see butlers 106 Ruined earth wall).
    const dashLen = normUnits(dashLenRaw)
    if (ctx.hasMidSymbol) {
      const spacing =
        typeof ctx.spacing === 'number'
          ? normUnits(ctx.spacing)
          : normUnits(dashLenRaw + breakLenRaw)
      const endOffset =
        typeof ctx.endOffset === 'number'
          ? normUnits(ctx.endOffset)
          : normUnits(spacing / 2)
      return {
        mainLength: spacing,
        endLength: endOffset,
        mainGap: 0,
        secGap: breakLen,
        endGap: 0,
      }
    }
    return {
      mainLength: dashLen,
      endLength: halfOuter ? normUnits(dashLenRaw / 2) : dashLen,
      mainGap: breakLen,
      secGap: 0,
      endGap: 0,
    }
  }
  return {
    mainLength: normUnits(mainMeta?.segmentLength ?? primary?.segmentLength),
    endLength: normUnits(mainMeta?.endLength ?? primary?.endLength),
    mainGap: 0,
    secGap: 0,
    endGap: 0,
  }
}

function encodePrimaryLineStyle(
  primary: StrokeLayer | undefined,
  mainMeta: StrokeLayer | undefined,
): number {
  return (
    mainMeta?.lineStyle ??
    encodeLineStyle(
      mainMeta?.capStyle ?? primary?.capStyle,
      mainMeta?.joinStyle ?? primary?.joinStyle,
    )
  )
}

/** Rewrite string colorIds (from gitmap) on OCD-shape decoration elements
 *  to numeric OCD palette slots. See point-body's `normaliseOcadElementColor`. */
function mapElementColors(
  els: unknown,
  colorNumber: ColorNumber,
): unknown[] {
  if (!Array.isArray(els)) return []
  return els.map(el => {
    if (!el || typeof el !== 'object') return el
    const e = el as { color?: unknown }
    if (typeof e.color === 'number' || e.color === undefined) return el
    return { ...(el as object), color: colorNumber(e.color) }
  })
}

function encodeUseSymbolFlags(symbol: MapSymbol): number {
  // Derive from the canonical `line-elements` layer — each array's
  // non-empty state maps to an independent bit in OCAD's
  // `useSymbolFlags` byte on the line symbol:
  //   bit 0 (0x01) — <end_symbol>   present (endSymElements)
  //   bit 1 (0x02) — <start_symbol> present (startSymElements)
  //   bit 2 (0x04) — <dash_symbol>  present (cornerSymElements)
  // Verified against bottle-lake 104.3 (start-only → 2) vs 104.0
  // (start + end → 3). Previously the writer folded start+end into
  // `|= 0x03` which lit both bits whenever either was present,
  // spuriously turning 104.3's flags from 2 into 3.
  const le = classifyLineLayers(symbol).lineElements
  if (!le) return 0
  let flags = 0
  const has = (v: unknown): boolean => Array.isArray(v) && v.length > 0
  if (has(le.endSymElements)) flags |= 0x01
  if (has(le.startSymElements)) flags |= 0x02
  if (has(le.cornerSymElements)) flags |= 0x04
  return flags
}
