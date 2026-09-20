import type { MapSymbol } from '../../../../panmap/model.js'

/**
 * Every OCAD symbol carries a fixed-length color set (14 slots) plus a
 * count of how many are actually used. Walk the render layers deeply —
 * area point-pattern-fills and point-elements bury their real colors
 * inside nested `pattern.symbol.…innerColor` chains, so a shallow scan
 * that only inspects top-level keys misses everything except the
 * outermost layer's color.
 *
 * When the colorSet is empty or contains only slot 0, Mapper renders
 * the symbol as invisible — the field is used for its render-slot
 * lookups, not just decoration. Callers pass a `colorNumber` resolver
 * to translate string ids (e.g. gitmap's `color_black`) to numeric slots.
 */
const COLOR_KEYS = new Set([
  'color',
  'colorId',
  'fillColor',
  'fillColorId',
  'hatchColor',
  'innerColor',
  'innerColorId',
  'outerColor',
  'outerColorId',
  'leftColor',
  'leftColorId',
  'rightColor',
  'rightColorId',
])

/**
 * Colour slots a layer carries but never paints with. Mapper's own
 * symbol colour set omits these (verified across the whole .ocd corpus),
 * so counting them makes our `nColors` disagree with the ground truth.
 *
 *  • `double-line.fillColorId` — OCAD gates the centre fill on
 *    `dblFlags & 1`; with the bit clear the `dblFillColor` slot is a
 *    leftover from an earlier config and nothing is painted with it.
 *    (Same rule the gitmap canonicaliser already applies in
 *    `doubleLineToStroke`.) Every corpus symbol with `dblFlags=1` has
 *    its fill colour in Mapper's set; every `dblFlags=0` one either
 *    doesn't, or the value coincides with a border colour counted anyway.
 *  • `point-pattern-fill.colorId` with no `elements` — the layer's
 *    colour is a derived "dominant ink of the stamp" hint, and the OCD
 *    reader falls back to the area's `fillColor` when the structure is
 *    empty. An empty stamp paints nothing (jarnvag / tahunanui 308
 *    Marsh, basic-1 404.3).
 */
function withoutInertColors(layer: unknown): unknown {
  if (!layer || typeof layer !== 'object') return layer
  const l = layer as Record<string, unknown>
  if (l.type === 'double-line' && (((l.flags as number) ?? 0) & 1) === 0) {
    const { fillColorId: _drop, ...rest } = l
    return rest
  }
  if (
    l.type === 'point-pattern-fill' &&
    !(Array.isArray(l.elements) && l.elements.length > 0)
  ) {
    const { colorId: _drop, ...rest } = l
    return rest
  }
  return layer
}

export function collectSymbolColors(
  symbol: MapSymbol,
  colorNumber: (id: unknown) => number,
): number[] {
  // Mapper appears to emit the symbol colorSet in ascending order —
  // e.g. sym 601005 arrowhead's set is [1,2,3,4,5,6] even though the
  // render layers reference colors in [4,3,1,2,5,6] order.
  const seen = new Set<number>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const c of node) walk(c)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (
        COLOR_KEYS.has(k) &&
        (typeof v === 'number' || typeof v === 'string')
      ) {
        if (typeof v === 'number') {
          if (v >= 0) seen.add(v)
        } else {
          const num = colorNumber(v)
          if (num >= 0) seen.add(num)
        }
      } else {
        walk(v)
      }
    }
  }
  for (const layer of symbol.layers ?? []) walk(withoutInertColors(layer))
  return [...seen].sort((a, b) => a - b).slice(0, 14)
}
