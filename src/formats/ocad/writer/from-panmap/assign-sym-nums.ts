import type { MapSymbol } from '../../../../panmap/model.js'
import { parseSymbolCode } from '../../../../panmap/symbol-code.js'

/**
 * Assign a unique OCAD `symNum` to every symbol in a map.
 *
 * OCAD stores each symbol as a 32-bit `symNum = main*1000 + sub`, which
 * gives 1000 unique slots per main code. Source formats (xmap/gitmap)
 * allow richer dotted codes like `501.0.1` alongside `501.1`; both fold
 * to the same synNum under `parseSymbolCode`. Without disambiguation
 * the second symbol overwrites the first in the symbol table.
 *
 * Strategy: TWO-PASS to match Mapper's own convention. In pass 1 every
 * symbol whose preferred slot is free claims it (source order). Symbols
 * whose preferred slot is already taken defer to pass 2. In pass 2
 * deferred symbols get the next free slot under the same main code.
 *
 * This matches Mapper's observed kura-tawhiti allocation for the paved-
 * paths family (501.*):
 *   501.0     → 501000    (pass 1)
 *   501.0.1   → 501001    (pass 1)
 *   501.1     → 501001    collides → pass 2 → 501005 (after
 *                          501.2/501.3/501.4 claimed 501002/3/4 in pass 1)
 *   501.2     → 501002    (pass 1)
 *   501.3     → 501003    (pass 1)
 *   501.3.1   → 501301    (pass 1, distinct)
 *   501.4     → 501004    (pass 1)
 *   501.4.1   → 501401    (pass 1, distinct)
 *
 * A single-pass "bump on first sight" scheme would have bumped 501.1 to
 * 501002 as soon as it collided — before 501.2 was seen — and then
 * cascaded misalignment through every downstream slot.
 */
export function assignSymNums(
  symbols: MapSymbol[],
): Map<MapSymbol['id'], number> {
  const byId = new Map<MapSymbol['id'], number>()
  const taken = new Set<number>()
  const deferred: Array<{ symbol: MapSymbol; preferred: number }> = []
  // Pass 1: claim preferred slots in source order. Collisions defer.
  for (const s of symbols) {
    const preferred = parseSymbolCode(s.code || String(s.sourceId ?? s.id))
    if (taken.has(preferred)) {
      deferred.push({ symbol: s, preferred })
    } else {
      taken.add(preferred)
      byId.set(s.id, preferred)
      if (s.sourceId !== undefined) byId.set(s.sourceId, preferred)
    }
  }
  // Pass 2: deferred symbols get the next free slot under their main code.
  for (const { symbol: s, preferred } of deferred) {
    const main = Math.floor(preferred / 1000)
    let n = preferred
    for (let sub = 1; sub < 1000; sub++) {
      const cand = main * 1000 + sub
      if (!taken.has(cand)) {
        n = cand
        break
      }
    }
    taken.add(n)
    byId.set(s.id, n)
    if (s.sourceId !== undefined) byId.set(s.sourceId, n)
  }
  return byId
}
