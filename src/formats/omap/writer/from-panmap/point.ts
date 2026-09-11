/**
 * Point-symbol builder: `MapSymbol` point fill / stroke / element layers
 * → an XMap `<point_symbol>` record (inner/outer colours plus nested
 * `<element>` shapes).
 */
import type { RenderLayer } from '../../../../panmap/model.js'
import type { OmapPointSymbol } from '../../native.js'
import { colorRef } from './colors.js'
import { ocadElementsToXmapPointSymbol } from './elements.js'

function buildXmapPointSymbol(
  pointFill: RenderLayer | undefined,
  pointStroke: RenderLayer | undefined,
  pointElements: RenderLayer | undefined,
  colorIds: Map<string | number, number>,
  rotatable = false,
): OmapPointSymbol {
  const innerColor = pointFill ? colorRef(pointFill.colorId, colorIds) : -1
  const innerRadius =
    (pointFill?.radius as number | undefined) ??
    (pointStroke?.radius as number | undefined) ??
    0
  const outerColor = pointStroke ? colorRef(pointStroke.colorId, colorIds) : -1
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

export { buildXmapPointSymbol }
