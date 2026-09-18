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
  // Mapper writes rotatable point symbols with inner_radius="1000" even
  // when inner_color=-1 (no fill) — it's the UI-hint marker for where
  // the rotation gizmo sits. Match so ocd→xmap round-trip doesn't drift
  // and every rotatable knoll/depression (101.1–4, 102.1, 103.1–3, …)
  // keeps its default marker size. Internal 100 → XML 1000 via dim() * 10.
  // Prefer an explicit radius carried on the render layer (either fill
  // or stroke), else fall back to Mapper's typical UI-gizmo default
  // (100 = xmap "inner_radius=1000"). Nothing here inspects source
  // format — the reader is responsible for putting an explicit value
  // on the layer whenever the source carries one.
  const innerRadius =
    (pointFill?.radius as number | undefined) ??
    (pointStroke?.radius as number | undefined) ??
    100
  const outerColor = pointStroke ? colorRef(pointStroke.colorId, colorIds) : -1
  const outerWidth = (pointStroke?.width as number | undefined) ?? 0

  const elementsRaw = (pointElements?.elements as unknown[] | undefined) ?? []

  // OCD-sourced point symbols with just one flat DOT / CIRCLE element
  // (109 Small knoll, 111 Small depression, 112 Small U-depression, etc.)
  // land here as a lone `point-elements` layer. Mapper's own ocd→xmap
  // conversion folds that single dot directly into the outer
  // `<point_symbol>` — Mapper writes `inner_radius="375" inner_color="15"
  // elements="0"` rather than the wrapped `elements="1"` scaffold. Fold
  // when there's no explicit fill/stroke layer (which would clash with
  // the inlined fields) and the single child is a bare dot/circle at
  // the origin.
  if (!pointFill && !pointStroke && elementsRaw.length === 1) {
    const inlined = ocadElementsToXmapPointSymbol(elementsRaw, colorIds, {
      inlineSingleDot: true,
    })
    const ips = inlined?.pointSymbol
    if (ips && !ips.elements?.length) {
      return {
        innerColor: ips.innerColor ?? -1,
        innerRadius: ips.innerRadius ?? 0,
        outerColor: ips.outerColor ?? -1,
        outerWidth: ips.outerWidth ?? 0,
        rotatable,
      } as OmapPointSymbol
    }
  }

  // OCD-sourced compound point symbols where the FIRST element is a
  // stroke-ring (OCD Circle at origin) — 417 Prominent large tree, 418
  // Prominent bush — get folded so Mapper's own ocd→xmap output matches.
  // The Circle's stroke ends up on the outer wrapper's outer_width /
  // outer_color, its "hole" radius on inner_radius, and all remaining
  // elements pass through as nested `<element>`s untouched (each
  // Dot/Line/Area already carries its own point/line/area_symbol shape,
  // Mapper doesn't re-fold at the nested level).
  if (!pointFill && !pointStroke && elementsRaw.length >= 2) {
    const first = elementsRaw[0] as
      | {
          type?: number
          diameter?: number
          lineWidth?: number
          color?: number
          coords?: unknown[]
        }
      | undefined
    if (isFoldableCircle(first)) {
      const dia = Number(first!.diameter ?? 0)
      const lw = Number(first!.lineWidth ?? 0)
      const nestedRest = ocadElementsToXmapPointSymbol(
        elementsRaw.slice(1),
        colorIds,
      )
      return {
        innerColor: -1,
        innerRadius: Math.max(0, (dia - lw) / 2),
        outerColor: colorRef(first!.color, colorIds),
        outerWidth: lw,
        rotatable,
        elements: nestedRest?.pointSymbol?.elements,
      } as OmapPointSymbol
    }
  }

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

/** OCD element is a stroke-ring circle at origin (type=3=Circle, single
 *  coord, real color, positive diameter/lineWidth). */
function isFoldableCircle(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const e = el as {
    type?: number
    diameter?: number
    lineWidth?: number
    color?: number
    numberCoords?: number
    coords?: unknown[]
  }
  if (e.type !== 3) return false
  if (!(Number(e.diameter) > 0) || !(Number(e.lineWidth) > 0)) return false
  if (typeof e.color !== 'number' || e.color < 0) return false
  const nCoords = e.numberCoords ?? e.coords?.length ?? 0
  if (nCoords !== 1) return false
  const c = e.coords?.[0] as
    | { 0?: number; 1?: number; x?: number; y?: number }
    | undefined
  if (!c) return false
  const x = (c[0] ?? c.x ?? 0) as number
  const y = (c[1] ?? c.y ?? 0) as number
  return x === 0 && y === 0
}

export { buildXmapPointSymbol }
