import type { MapSymbol } from '../../../../../map/model.js'
import { classifyLineLayers } from '../../../../../map/render-layers.js'
import type { StrokeLayer , DoubleLineLayer } from '../../../../../map/render-layers.js'
import { encodeLineStyle } from '../../../../../map/line-style-codec.js'
import {
  strokeColorValid, pickMainStroke, mainStrokeVisible,
} from '../../../../../map/stroke-classifier.js'
import type { ColorNumber } from './shared.js'
import { normUnits } from './shared.js'
import { pointElementFromXmap } from './point.js'


function frameFields(
  primary: StrokeLayer | undefined,
  strokes: StrokeLayer[],
  colorNumber: ColorNumber,
): { frColor: number; frWidth: number; frStyle: number } {
  const primaryDash = !!primary?.dash
  if (!primaryDash) return { frColor: 0, frWidth: 0, frStyle: 0 }
  const frame = strokes.find(
    (s) => s !== primary && strokeColorValid(s) && !s.dash,
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
  dblMode: number; dblFlags: number; dblFillColor: number
  dblLeftColor: number; dblRightColor: number
  dblWidth: number; dblLeftWidth: number; dblRightWidth: number
  dblLength: number; dblGap: number; dblRes: [number, number]
} {
  const l = layer as DoubleLineLayer & {
    flags?: number; dashLength?: number; breakLength?: number
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
  dblMode: number; dblFlags: number; dblFillColor: number;
  dblLeftColor: number; dblRightColor: number;
  dblWidth: number; dblLeftWidth: number; dblRightWidth: number;
  dblLength: number; dblGap: number; dblRes: [number, number];
} {
  const empty = {
    dblMode: 0, dblFlags: 0, dblFillColor: 0, dblLeftColor: 0, dblRightColor: 0,
    dblWidth: 0, dblLeftWidth: 0, dblRightWidth: 0, dblLength: 0, dblGap: 0,
    dblRes: [0, 0] as [number, number],
  }
  let borderStroke: StrokeLayer | undefined = strokes.find((s) => {
    const b = s.borders
    return Array.isArray(b) && b.length > 0
  })
  let borders = borderStroke?.borders as
    Array<{ color: number; width: number; shift: number; dashed?: boolean; dashLength?: number; breakLength?: number }> | undefined
  if (!borderStroke) {
    const primaryDashed = !!primary?.dash
    if (!primaryDashed) {
      borderStroke = strokes.find((s) => s !== primary && strokeColorValid(s))
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
  const borderStrokeVisible = borderStroke !== primary && strokeColorValid(borderStroke)
  if (!leftValid && !rightValid && !borderStrokeVisible) return empty

  const fillWidth = normUnits(borderStroke?.width)
  let fillColor = 0
  const borderStrokeIsPrimary = borderStroke === primary
  if (!borderStrokeIsPrimary || !primaryVisible) {
    const rawFill = borderStroke?.colorId
    fillColor = rawFill === undefined || rawFill === null || Number(rawFill) < 0
      ? 0 : colorNumber(rawFill)
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
      strokes, primary, colorNumber, mainStrokeVisible(primary, strokes),
    )
  const mainMeta = strokes[0] !== primary ? strokes[0] : undefined
  const rhythm = encodeDashRhythm(primary, mainMeta)
  const visible = mainStrokeVisible(primary, strokes)
  const hasPrimary = !!primary
  return {
    lineColor: hasPrimary && visible ? colorNumber(primary!.colorId) : 0,
    lineWidth: hasPrimary && visible ? normUnits(primary!.width) : 0,
    lineStyle: encodePrimaryLineStyle(primary, mainMeta),
    distFromStart: normUnits(primary?.startOffset) || 0,
    distToEnd: normUnits(primary?.endOffset) || 0,
    ...rhythm,
    minSym: primary?.showAtLeastOneSymbol === false ? -1 : 0,
    nPrimSym: primary?.midSymbolsPerSpot ?? 0,
    primSymDist: normUnits(primary?.midSymbolDistance) || 0,
    doubleLine,
    decrease: {
      decMode: 0, decSymbolSize: 0,
      decSymbolDistance: false, decSymbolWidth: false,
    },
    ...(doubleLine.dblFillColor > 0
      ? { frColor: 0, frWidth: 0, frStyle: 0 }
      : frameFields(primary, strokes, colorNumber)),
    useSymbolFlags: encodeUseSymbolFlags(symbol),
    reserved: 0,
    // OCAD-sourced line symbols carry raw element arrays on a
    // `line-elements` render layer; prefer those verbatim. Xmap-sourced
    // symbols expose their mid/corner/start/end sub-symbols via a
    // `line-symbols` layer, in which case `lineDecorElements` builds
    // the OCAD elements from that nested shape.
    primSymElements: lineElementsLayer?.primSymElements
      ?? lineDecorElements(symbol, 'midSymbol', colorNumber, flipY),
    secSymElements: lineElementsLayer?.secSymElements ?? ([] as unknown[]),
    cornerSymElements: lineElementsLayer?.cornerSymElements
      ?? lineDecorElements(symbol, 'dashSymbol', colorNumber, flipY),
    startSymElements: lineElementsLayer?.startSymElements
      ?? lineDecorElements(symbol, 'startSymbol', colorNumber, flipY),
    endSymElements: lineElementsLayer?.endSymElements
      ?? lineDecorElements(symbol, 'endSymbol', colorNumber, flipY),
  }
}

function encodeDashRhythm(
  primary: StrokeLayer | undefined,
  mainMeta: StrokeLayer | undefined,
): { mainLength: number; endLength: number; mainGap: number; secGap: number; endGap: number } {
  const dash = primary?.dash
  if (dash) {
    // OCAD-sourced dashes come in with the OCAD field names already
    // (mainLength/mainGap/…); xmap-sourced dashes come in with Mapper's
    // conceptual names (dashLength/breakLength/dashesInGroup). Prefer
    // the OCAD names when present so OCAD → synth → OCAD round-trips
    // the exact fields Mapper wrote.
    const dashAsOcad = dash as {
      mainLength?: number; mainGap?: number; secGap?: number
      endLength?: number; endGap?: number
    }
    if (dashAsOcad.mainLength !== undefined || dashAsOcad.mainGap !== undefined) {
      return {
        mainLength: normUnits(dashAsOcad.mainLength),
        endLength: normUnits(dashAsOcad.endLength ?? dashAsOcad.mainLength),
        mainGap: normUnits(dashAsOcad.mainGap),
        secGap: normUnits(dashAsOcad.secGap),
        endGap: normUnits(dashAsOcad.endGap),
      }
    }
    const dashLen = normUnits(dash.dashLength)
    const breakLen = normUnits(dash.breakLength)
    const dashesInGroup = dash.dashesInGroup ?? 1
    const inGroupBreak = normUnits(dash.inGroupBreakLength)
    if (dashesInGroup > 1) {
      const mainLength = 2 * dashLen + inGroupBreak
      return {
        mainLength, endLength: mainLength,
        mainGap: breakLen, secGap: inGroupBreak, endGap: inGroupBreak,
      }
    }
    return {
      mainLength: dashLen, endLength: dashLen,
      mainGap: breakLen, secGap: 0, endGap: 0,
    }
  }
  return {
    mainLength: normUnits(mainMeta?.segmentLength ?? primary?.segmentLength),
    endLength: normUnits(mainMeta?.endLength ?? primary?.endLength),
    mainGap: 0, secGap: 0, endGap: 0,
  }
}

function encodePrimaryLineStyle(
  primary: StrokeLayer | undefined,
  mainMeta: StrokeLayer | undefined,
): number {
  return mainMeta?.lineStyle
    ?? encodeLineStyle(
      mainMeta?.capStyle ?? primary?.capStyle,
      mainMeta?.joinStyle ?? primary?.joinStyle,
    )
}

function encodeUseSymbolFlags(symbol: MapSymbol): number {
  const ls = classifyLineLayers(symbol).lineSymbols?.lineSymbol
  if (!ls) return 0
  let flags = 0
  if (ls.startSymbol || ls.endSymbol) flags |= 0x03
  if (ls.dashSymbol) flags |= 0x04
  return flags
}

function lineDecorElements(
  symbol: MapSymbol,
  role: 'midSymbol' | 'startSymbol' | 'endSymbol' | 'dashSymbol',
  colorNumber: ColorNumber,
  flipY = false,
): unknown[] {
  const ls = classifyLineLayers(symbol).lineSymbols?.lineSymbol
  const sub = ls?.[role]
  if (!sub || typeof sub !== 'object') return []
  return pointElementFromXmap(
    { symbol: sub, object: { coords: [{ x: 0, y: 0 }] } },
    colorNumber,
    flipY,
  )
}
