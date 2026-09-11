/**
 * Colour / id mapping for the XMap writer: numeric colour-slot lookup,
 * per-symbol unique id allocation, and the nested-symbol colour rewrite
 * that turns gitmap string colour ids into OMAP numeric priorities.
 */
import type { MapSymbol } from '../../../../panmap/model.js'
import type { OmapObject, OmapSymbol } from '../../native.js'
import { buildColorIdMap, colorRefLookup } from '../../../../panmap/color.js'

const colorRef = colorRefLookup
const colorIdMap = buildColorIdMap

// Panmap allows multiple MapSymbols to share the same `symbol.id`
// (e.g. two "201.2" variants). OMAP requires each <symbol id="…"/> to
// be unique. Allocate a unique numeric id per symbol *instance* (not
// per symbol.id key): prefer sourceId when it's unique so ocd/xmap
// round-trips stay stable, otherwise fall back to the next free slot
// above the max claimed sourceId.
function symbolIdMap(symbols: MapSymbol[]): Map<MapSymbol, number> {
  const map = new Map<MapSymbol, number>()
  const used = new Set<number>()
  const preferred: Array<{ symbol: MapSymbol; wanted: number | null }> = []
  let maxUsed = 0
  for (const symbol of symbols) {
    const sourceId = Number(symbol.sourceId)
    const ownId = Number(symbol.id)
    const wanted = Number.isFinite(sourceId)
      ? sourceId
      : Number.isFinite(ownId)
        ? ownId
        : null
    preferred.push({ symbol, wanted })
    if (wanted !== null) maxUsed = Math.max(maxUsed, wanted)
  }
  for (const { symbol, wanted } of preferred) {
    if (wanted !== null && !used.has(wanted)) {
      used.add(wanted)
      map.set(symbol, wanted)
    } else {
      const id = ++maxUsed
      used.add(id)
      map.set(symbol, id)
    }
  }
  return map
}

function rewriteSymbolColors(
  symbol: OmapSymbol,
  colorIds: Map<string | number, number>,
): OmapSymbol {
  const rewriteColor = (c: unknown): unknown =>
    typeof c === 'string' ? colorRef(c, colorIds) : c
  const out: OmapSymbol = { ...symbol }
  const ps = symbol.pointSymbol as Record<string, unknown> | undefined
  if (ps) {
    out.pointSymbol = {
      ...ps,
      innerColor: rewriteColor(ps.innerColor),
      outerColor: rewriteColor(ps.outerColor),
      elements: Array.isArray(ps.elements)
        ? (
            ps.elements as Array<{ symbol: OmapSymbol; object: OmapObject }>
          ).map(el => ({
            symbol: rewriteSymbolColors(el.symbol, colorIds),
            object: el.object,
          }))
        : ps.elements,
    } as typeof symbol.pointSymbol
  }
  const ls = symbol.lineSymbol as Record<string, unknown> | undefined
  if (ls) {
    out.lineSymbol = {
      ...ls,
      color: rewriteColor(ls.color),
    } as typeof symbol.lineSymbol
  }
  const as = symbol.areaSymbol as Record<string, unknown> | undefined
  if (as) {
    out.areaSymbol = {
      ...as,
      innerColor: rewriteColor(
        (as as { innerColor?: unknown }).innerColor ??
          (as as { color?: unknown }).color,
      ),
    } as typeof symbol.areaSymbol
  }
  return out
}

export { colorRef, colorIdMap, symbolIdMap, rewriteSymbolColors }
