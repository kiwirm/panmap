import type { MapSymbol } from '../../../../map/model.js'
import { parseSymbolCode } from '../../../../map/symbol-code.js'

/**
 * Assign a unique OCAD `symNum` to every symbol in a map.
 *
 * OCAD stores each symbol as a 32-bit `symNum = main*1000 + sub`, which
 * gives 1000 unique slots per main code. Source formats (xmap/gitmap)
 * allow richer dotted codes like `501.0.1` alongside `501.1`; both fold
 * to the same synNum under `parseSymbolCode`. Without disambiguation
 * the second symbol overwrites the first in the symbol table and any
 * objects referencing it end up pointing at a mismatched symbol (or at
 * a hash fallback, which surfaces in Mapper as "object with no symbol
 * at all").
 *
 * Strategy: walk symbols in source order and let each one claim its
 * preferred synNum. On collision, bump the sub number to the next free
 * slot under the same main code — matching what Mapper does when it
 * exports the same source (source `501.1` becomes symNum 501005 when
 * `501.0.1` already took 501001).
 */
export function assignSymNums(
  symbols: MapSymbol[],
): Map<MapSymbol['id'], number> {
  const byId = new Map<MapSymbol['id'], number>()
  const taken = new Set<number>()
  for (const s of symbols) {
    const preferred = parseSymbolCode(s.code || String(s.sourceId ?? s.id))
    let n = preferred
    if (taken.has(n)) {
      const main = Math.floor(preferred / 1000)
      for (let sub = 1; sub < 1000; sub++) {
        const cand = main * 1000 + sub
        if (!taken.has(cand)) { n = cand; break }
      }
    }
    taken.add(n)
    byId.set(s.id, n)
    if (s.sourceId !== undefined) byId.set(s.sourceId, n)
  }
  return byId
}
