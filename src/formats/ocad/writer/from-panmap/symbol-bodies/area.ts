import type { MapSymbol } from '../../../../../map/model.js'
import { classifyAreaLayers } from '../../../../../map/render-layers.js'
import type { HatchLayer, PointPatternLayer } from '../../../../../map/render-layers.js'
import { DotElementType } from '../../../native/symbol-element-types.js'
import type { ColorNumber } from './shared.js'
import { normUnits } from './shared.js'
import { pointElementFromXmap } from './point.js'

export function areaBody(
  symbol: MapSymbol,
  colorNumber: ColorNumber,
  flipY: boolean,
  borderSymNum?: number,
) {
  const { fill, hatches, pointPatterns: patterns } = classifyAreaLayers(symbol)
  const fillColorId = fill?.colorId
  return {
    fillColor: fillColorId != null ? colorNumber(fillColorId) : 0,
    ...encodeHatchMode(hatches, colorNumber),
    fillOn: fillColorId != null,
    borderSym: borderSymNum ?? 0,
    borderOn: borderSymNum !== undefined,
    ...encodePatternStructure(patterns, colorNumber, flipY),
  }
}

/**
 * OCAD `hatchMode`: 0 none, 1 single, 2 crossed. Two hatch-fill layers
 * with DIFFERENT angles form a cross-hatch (ISOM 709). Same-angle pairs
 * are overlapping fills — Mapper keeps only the first as visible.
 */
function encodeHatchMode(
  hatches: HatchLayer[],
  colorNumber: ColorNumber,
): {
  hatchMode: number
  hatchColor: number
  hatchLineWidth: number
  hatchDist: number
  hatchAngle1: number
  hatchAngle2: number
} {
  const hatch = hatches[0]
  const hatch2 = hatches[1]
  const hatchAnglesDiffer =
    !!hatch2 && Math.abs(((hatch?.angle ?? 0) - (hatch2.angle ?? 0)) % 180) >= 1
  const hatchMode = hatchAnglesDiffer ? 2 : hatches.length >= 1 ? 1 : 0
  return {
    hatchMode,
    hatchColor: colorNumber(hatch?.colorId),
    hatchLineWidth: normUnits(hatch?.lineWidth),
    hatchDist: normUnits(hatch?.spacing),
    hatchAngle1: Math.round((hatch?.angle ?? 0) * 10) % 3600,
    hatchAngle2: hatchAnglesDiffer ? Math.round((hatch2!.angle ?? 0) * 10) % 3600 : 0,
  }
}

/**
 * OCAD's structure fields (structMode / structWidth / structHeight /
 * structAngle / structDraw + elements). Two point-pattern layers form
 * OCAD `StructureShiftedRows` (structMode=2) when their spacing matches
 * and the second's offsets are exactly half of the first's; anything
 * else falls back to structMode=1 with offset elements.
 */
function encodePatternStructure(
  patterns: PointPatternLayer[],
  colorNumber: ColorNumber,
  flipY: boolean,
): {
  structMode: number
  structDraw: number
  structWidth: number
  structHeight: number
  structAngle: number
  structIrregularVarX: number
  structIrregularVarY: number
  structIrregularMinDist: number
  structRes: number
  elements: unknown[]
} {
  const pattern = patterns[0]
  const shiftedRows = isShiftedRows(patterns[0], patterns[1])
  const patternElements = pattern
    ? extractPatternElements(pattern, colorNumber, flipY, null)
    : []
  const secondPatternElements = (!shiftedRows && patterns[1])
    ? extractPatternElements(patterns[1], colorNumber, flipY, patternOffset(patterns[0], patterns[1]))
    : []
  const structHeight = patternElements.length
    ? shiftedRows
      ? normUnits(patterns[1]?.pattern?.lineOffset ?? 0)
      : patternMetric(pattern, 'lineSpacing', pattern?.height, 100)
    : 0
  return {
    structMode: shiftedRows ? 2 : patterns.length ? 1 : 0,
    structDraw: patternElements.length ? patternClipMode(pattern) : 0,
    structWidth: patternElements.length
      ? patternMetric(pattern, 'pointDistance', pattern?.width, 100)
      : 0,
    structHeight,
    structAngle: Math.round((pattern?.angle ?? 0) * 10) % 3600,
    structIrregularVarX: 0, structIrregularVarY: 0, structIrregularMinDist: 0,
    structRes: 0,
    elements: [...patternElements, ...secondPatternElements],
  }
}

function isShiftedRows(a: PointPatternLayer | undefined, b: PointPatternLayer | undefined): boolean {
  if (!a || !b) return false
  const pa = a.pattern
  const pb = b.pattern
  if (!pa || !pb) return false
  const ls = pa.lineSpacing; const pd = pa.pointDistance
  if (!ls || !pd) return false
  if (pa.lineSpacing !== pb.lineSpacing) return false
  if (pa.pointDistance !== pb.pointDistance) return false
  const dLine = Math.abs((((pa.lineOffset ?? 0) - (pb.lineOffset ?? 0) + ls) % ls) - ls / 2)
  const dAlong = Math.abs((((pa.offsetAlongLine ?? 0) - (pb.offsetAlongLine ?? 0) + pd) % pd) - pd / 2)
  return dLine <= 1 && dAlong <= 1
}

function patternOffset(
  a: PointPatternLayer | undefined, b: PointPatternLayer | undefined,
): { dx: number; dy: number } | null {
  if (!a || !b) return null
  const pa = a.pattern
  const pb = b.pattern
  if (!pa || !pb) return null
  return {
    dx: (pb.offsetAlongLine ?? 0) - (pa.offsetAlongLine ?? 0),
    dy: (pb.lineOffset ?? 0) - (pa.lineOffset ?? 0),
  }
}

function patternMetric(
  layer: PointPatternLayer | undefined,
  key: 'pointDistance' | 'lineSpacing',
  fallback: unknown,
  ultimate: number,
): number {
  const v = layer?.pattern?.[key]
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return normUnits(v)
  if (typeof fallback === 'number' && fallback > 0) return normUnits(fallback)
  return ultimate
}

function patternClipMode(layer: PointPatternLayer | undefined): number {
  const nc = layer?.pattern?.noClipping
  return typeof nc === 'number' ? Math.max(0, Math.min(2, nc)) : 2
}

function extractPatternElements(
  layer: PointPatternLayer,
  colorNumber: ColorNumber,
  flipY: boolean,
  offset: { dx: number; dy: number } | null = null,
): unknown[] {
  const pattern = layer.pattern
  if (!pattern?.symbol) return []
  const ps = pattern.symbol.pointSymbol
  if (!ps) return []
  const out: unknown[] = []
  const yScale = flipY ? -1 : 1
  const anchor = {
    0: normUnits(offset?.dx ?? 0),
    1: normUnits((offset?.dy ?? 0) * yScale),
    xFlags: 0, yFlags: 0,
  }
  const inner = normUnits(ps.innerRadius)
  if (inner > 0 && ps.innerColor !== undefined && ps.innerColor !== null) {
    const c = colorNumber(ps.innerColor)
    if (c > 0) {
      out.push({
        type: DotElementType, flags: 0, color: c, lineWidth: 0, diameter: inner * 2,
        numberCoords: 1, coords: [anchor],
      })
    }
  }
  for (const sub of ps.elements ?? []) {
    const emitted = pointElementFromXmap(sub, colorNumber, flipY)
    if (offset) {
      for (const el of emitted) {
        for (const c of el.coords) {
          const coord = c as { 0: number; 1: number }
          coord[0] += anchor[0]
          coord[1] += anchor[1]
        }
      }
    }
    out.push(...emitted)
  }
  return out
}
