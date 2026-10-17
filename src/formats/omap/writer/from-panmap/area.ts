/**
 * Area-symbol builder: `MapSymbol` fill / hatch / point-pattern layers
 * → an XMap `<area_symbol>` record (inner colour plus the `<pattern>`
 * list).
 */
import type {
  FillLayer,
  HatchLayer,
  PointPatternLayer,
} from '../../../../panmap/render-layers.js'
import type { OmapAreaPattern, OmapAreaSymbol } from '../../native.js'
import { colorRef } from './colors.js'
import { ocadElementsToXmapPointSymbol } from './elements.js'

function buildXmapAreaSymbol(
  fills: FillLayer[],
  hatches: HatchLayer[],
  pointPatterns: PointPatternLayer[],
  colorIds: Map<string | number, number>,
): OmapAreaSymbol {
  const primaryFill = fills[0]
  const innerColor = primaryFill ? colorRef(primaryFill.colorId, colorIds) : -1

  const patterns: OmapAreaPattern[] = []

  for (const h of hatches) {
    patterns.push({
      type: 1,
      // xmap stores hatch angle in RADIANS; the model uses degrees
      angle: ((h.angle ?? 0) * Math.PI) / 180,
      lineSpacing: h.spacing ?? 0,
      pointDistance: 0,
      lineOffset: h.lineOffset ?? 0,
      offsetAlongLine: h.offsetAlongLine ?? 0,
      color: colorRef(h.colorId, colorIds),
      lineWidth: h.lineWidth ?? 0,
      rotatable: !!h.rotatable,
    } as OmapAreaPattern)
  }

  for (const p of pointPatterns) {
    // Canonical `width` is spacing along a row, `height` between rows.
    // xmap names these `point_distance` / `line_spacing`.
    const pointDistance = p.width ?? 0
    const lineSpacing = p.height ?? 0
    const angleRad = ((p.angle ?? 0) * Math.PI) / 180
    const rotatable = !!p.rotatable
    // Mapper's single-dot inline canonicalisation: a pattern whose stamp
    // is one flat dot is written as `<point_symbol inner_radius=X
    // inner_color=Y elements="0"/>` rather than a wrapped `<element>`.
    const stamp = ocadElementsToXmapPointSymbol(
      (p.elements as unknown[]) ?? [],
      colorIds,
      {
        inlineSingleDot: true,
        // Preserve xmap-authored wrapper metadata on the stamp (kura-
        // tawhiti 208 boulder-field has inner_radius=1200 on the outer;
        // 414/414.1 have inner_radius=0). Undefined for OCD-sourced
        // patterns, where the writer default applies.
        wrapper: (p as { stampWrapper?: unknown }).stampWrapper as never,
      },
    )
    const base = {
      type: 2,
      angle: angleRad,
      lineSpacing,
      pointDistance,
      color: colorRef(p.colorId, colorIds),
      lineWidth: 0,
      rotatable,
      symbol: stamp,
    }
    // A shifted-rows layout is ONE canonical layer; xmap expresses it as
    // a PAIR of `<pattern>` records offset by half a tile in both axes
    // (see `omap/reader/to-panmap.ts:isShiftedRowsPair` for the inverse).
    // Mapper writes `no_clipping` only on the second of the pair.
    if (p.shiftedRows) {
      patterns.push({
        ...base,
        lineOffset: p.rowOffset ?? 0,
        offsetAlongLine: p.columnOffset ?? 0,
        noClipping: 0,
      } as OmapAreaPattern)
      patterns.push({
        ...base,
        lineOffset: (p.rowOffset ?? 0) + lineSpacing / 2,
        offsetAlongLine: (p.columnOffset ?? 0) + pointDistance / 2,
        noClipping: p.noClipping,
      } as OmapAreaPattern)
      continue
    }
    patterns.push({
      ...base,
      lineOffset: p.rowOffset ?? 0,
      offsetAlongLine: p.columnOffset ?? 0,
      noClipping: p.noClipping,
    } as OmapAreaPattern)
  }

  return {
    innerColor,
    patterns: patterns.length ? patterns : undefined,
    // Preserve Mapper's `min_area` when the reader carried it on the
    // primary fill layer. OCD-sourced maps have no equivalent slot;
    // `primaryFill?.minArea` is undefined for them and we fall through
    // to encoder default 0.
    minArea: primaryFill?.minArea,
  }
}

export { buildXmapAreaSymbol }
