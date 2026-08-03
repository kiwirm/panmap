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
