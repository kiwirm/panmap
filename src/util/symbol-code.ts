/**
 * OCAD packs a dotted symbol code into an integer:
 *   symNum = main * 1000 + subCombined
 * where subCombined is each sub-part in two-digit slots. Empirical
 * mapping against Mapper-produced files:
 *   "413.1"   → 413001    (sub = 1)
 *   "801.4"   → 801004    (sub = 4)
 *   "501.4.7" → 501407    (sub = 4*100 + 7)
 *   "501.0.1" → 501001    (sub = 0*100 + 1)
 *   "522.0.2" → 522002
 * ISOM extensions frequently use three-part codes, so a two-part
 * regex was quietly hashing them to random ids and losing whole
 * symbol families (e.g. every "501.4.*" paved-footpath variant).
 */
export function parseSymbolCode(code: string): number {
  const parts = code.trim().split('.')
  if (parts.length >= 1 && parts.every((p) => /^\d+$/.test(p))) {
    const main = parseInt(parts[0], 10)
    let sub = 0
    for (let i = 1; i < parts.length; i++) sub = sub * 100 + parseInt(parts[i], 10)
    return main * 1000 + sub
  }
  let hash = 0
  for (let i = 0; i < code.length; i++) {
    hash = ((hash << 5) - hash + code.charCodeAt(i)) | 0
  }
  return Math.abs(hash) || 1
}

/**
 * Canonical string form of a numeric symbol code.
 *
 * OCAD writes variant-zero codes with a trailing group ("101.0"); OMap drops it
 * ("101"). They're the same symbol (`parseSymbolCode` gives 101000 for both), so
 * an OCD- and an OMap-sourced copy of the same map otherwise produce different
 * symbol ids (`sym_101_0` vs `sym_101`) — and every object referencing them then
 * differs too. Reconstruct a canonical dotted string from the parsed value so
 * equivalent codes collapse ("101.0"→"101", "204.01"→"204.1") while genuinely
 * distinct ones are preserved ("204.1.0" stays, since it parses differently).
 * Non-numeric codes are returned unchanged.
 */
export function canonicalSymbolCode(code: string | number | null | undefined): string {
  if (code === null || code === undefined) return ''
  const s = String(code).trim()
  const parts = s.split('.')
  if (!(parts.length >= 1 && parts.every((p) => /^\d+$/.test(p)))) return s
  const main = parseInt(parts[0], 10)
  let sub = 0
  for (let i = 1; i < parts.length; i++) sub = sub * 100 + parseInt(parts[i], 10)
  if (sub === 0) return String(main)
  const subParts: number[] = []
  for (let x = sub; x > 0; x = Math.floor(x / 100)) subParts.unshift(x % 100)
  return [main, ...subParts].join('.')
}
