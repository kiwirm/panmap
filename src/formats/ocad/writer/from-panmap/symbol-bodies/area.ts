import type { MapSymbol } from '../../../../../panmap/model.js'
import { classifyAreaLayers } from '../../../../../panmap/render-layers.js'
import type {
  HatchLayer,
  PointPatternLayer,
} from '../../../../../panmap/render-layers.js'
import type { ColorNumber } from './shared.js'
import { normUnits } from './shared.js'

export function areaBody(
  symbol: MapSymbol,
  colorNumber: ColorNumber,
  _flipY: boolean,
  borderSymNum?: number,
) {
  const { fill, hatches, pointPatterns: patterns } = classifyAreaLayers(symbol)
  const fillColorId = fill?.colorId
  const structFields = encodePatternStructure(patterns, colorNumber)
  return {
    fillColor: fillColorId != null ? colorNumber(fillColorId) : 0,
    ...encodeHatchMode(hatches, colorNumber),
    fillOn: fillColorId != null,
    borderSym: borderSymNum ?? 0,
    borderOn: borderSymNum !== undefined,
    ...structFields,
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
    hatchAngle2: hatchAnglesDiffer
      ? Math.round((hatch2!.angle ?? 0) * 10) % 3600
      : 0,
  }
}

/**
 * Canonical `point-pattern-fill` render layer -> OCD struct fields
 * (structMode / structWidth / structHeight / structAngle / structDraw +
 * elements). The layer already carries the semantic shape both readers
 * produce, so this is a direct encode with no shape sniffing.
 *
 * OCAD's `structHeight` is the ROW PITCH: for a shifted-rows layout the
 * canonical `height` spans two rows, so halve it back.
 */
function encodePatternStructure(
  patterns: PointPatternLayer[],
  colorNumber: ColorNumber,
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
  const p = patterns[0]
  if (!p) {
    return {
      structMode: 0,
      structDraw: 0,
      structWidth: 0,
      structHeight: 0,
      structAngle: 0,
      structIrregularVarX: 0,
      structIrregularVarY: 0,
      structIrregularMinDist: 0,
      structRes: 0,
      elements: [],
    }
  }
  const shifted = !!p.shiftedRows
  const height = Number(p.height) || 0
  // Preserve OCAD-only irregular scatter fields (Stony ground 210
  // etc.) — when the reader captured them, gate the "shifted → 0"
  // convention below off: Mapper's ocd→xmap→ocd only zeros structDraw
  // on regular shifted patterns, not on irregular scatters where it's
  // a real value.
  const pIrregVarX =
    (p as { structIrregularVarX?: number }).structIrregularVarX ?? 0
  const pIrregVarY =
    (p as { structIrregularVarY?: number }).structIrregularVarY ?? 0
  const pIrregMinDist =
    (p as { structIrregularMinDist?: number }).structIrregularMinDist ?? 0
  const isIrregular = pIrregVarX > 0 || pIrregVarY > 0 || pIrregMinDist > 0
  return {
    structMode: shifted ? 2 : 1,
    // Mapper's own xmap→OCD conversion writes structDraw=0 for regular
    // shifted-rows fills (structMode=2, xmap pair-second's no_clipping
    // dropped — hillmorton 113 / 208 / 210). Preserve the value on
    // irregular scatters (myggfritt 210000 Stony ground: structDraw=2
    // carries the real clipping enum).
    structDraw: shifted && !isIrregular ? 0 : (p.noClipping ?? 0) & 0x03,
    structWidth: normUnits(p.width),
    structHeight: normUnits(shifted ? height / 2 : height),
    structAngle: Math.round((p.angle ?? 0) * 10) % 3600,
    structIrregularVarX: pIrregVarX,
    structIrregularVarY: pIrregVarY,
    structIrregularMinDist: pIrregMinDist,
    structRes: 0,
    // Gitmap-sourced elements carry `color` as a string colorId; rewrite
    // to numeric OCD palette slots. Without this, structure-fill dots
    // (rough-open sand, boulder-field boulders) render as slot 0 (black).
    elements: (Array.isArray(p.elements) ? p.elements : []).map(el => {
      if (!el || typeof el !== 'object') return el
      const e = el as { color?: unknown }
      if (typeof e.color === 'number' || e.color === undefined) return el
      return { ...(el as object), color: colorNumber(e.color) }
    }),
  }
}
