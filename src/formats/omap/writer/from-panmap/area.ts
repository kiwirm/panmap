/**
 * Area-symbol builder: `MapSymbol` fill / hatch / structure /
 * point-pattern layers → an XMap `<area_symbol>` record (inner colour
 * plus the `<pattern>` list).
 */
import type {
  FillLayer,
  HatchLayer,
  PointPatternLayer,
  StructureLayer,
} from '../../../../panmap/render-layers.js'
import type {
  OmapAreaPattern,
  OmapAreaSymbol,
  OmapSymbol,
} from '../../native.js'
import { colorRef, rewriteSymbolColors } from './colors.js'
import { ocadElementsToXmapPointSymbol } from './elements.js'

function buildXmapAreaSymbol(
  fills: FillLayer[],
  hatches: HatchLayer[],
  structures: StructureLayer[],
  pointPatterns: PointPatternLayer[],
  colorIds: Map<string | number, number>,
): OmapAreaSymbol {
  const primaryFill = fills[0]
  const innerColor = primaryFill ? colorRef(primaryFill.colorId, colorIds) : -1

  const patterns: OmapAreaPattern[] = []

  for (const h of hatches) {
    patterns.push({
      type: 1,
      // xmap stores hatch angle in RADIANS; uses degrees
      angle: ((h.angle ?? 0) * Math.PI) / 180,
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
    const lineSpacing =
      mode === 2 ? (s.symbolHeight ?? 0) * 2 : (s.symbolHeight ?? 0)
    const angleRad = ((s.angle ?? 0) * Math.PI) / 180
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
    } as OmapAreaPattern)

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
      } as OmapAreaPattern)
    }
  }

  for (const p of pointPatterns) {
    const nested = p.pattern?.symbol as OmapSymbol | undefined
    const pat = p.pattern as
      | {
          lineSpacing?: number
          pointDistance?: number
          lineOffset?: number
          offsetAlongLine?: number
          noClipping?: number
          rotatable?: boolean
        }
      | undefined
    patterns.push({
      type: 2,
      angle: ((p.angle ?? 0) * Math.PI) / 180,
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
    } as OmapAreaPattern)
  }

  return {
    innerColor,
    patterns: patterns.length ? patterns : undefined,
  }
}

export { buildXmapAreaSymbol }
