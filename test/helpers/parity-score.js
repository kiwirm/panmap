/**
 * Shared scoring for the four ground-truth parity suites.
 *
 * Raw mismatch counts don't compare across maps — a 200-symbol map and a
 * 60-symbol map can't be read against each other, and one badly-broken
 * symbol contributing 40 field diffs looks worse than 20 symbols each
 * off by one. Report instead:
 *
 *   • symbol cleanliness — what share of compared symbols are identical.
 *     This is the headline: it answers "how much of this map converts
 *     perfectly".
 *   • field accuracy — what share of individual field comparisons agree.
 *     A high field accuracy with low symbol cleanliness means many
 *     symbols are each off by a hair (usually one systematic attribute);
 *     the reverse means a few symbols are badly wrong.
 */

/** Group mismatches by the `<symbol …>` prefix every suite's paths carry. */
export function symbolsWithMismatches(mismatches) {
  const hit = new Set()
  for (const m of mismatches) {
    const s = m.path.match(/^<symbol [^>]+>/)
    hit.add(s ? s[0] : '<root>')
  }
  return hit
}

/**
 * Build the headline summary line for a parity failure.
 *
 * @param {object} args
 * @param {Array} args.mismatches   every field-level difference found
 * @param {number} args.symbolCount symbols compared (the denominator)
 * @param {number} args.fieldCount  field comparisons made (optional)
 * @param {string} args.what        e.g. "panmap's ocd→xmap conversion"
 * @param {string} args.against     e.g. "Mapper's own ocd→xmap"
 */
export function parityScore({
  mismatches,
  symbolCount,
  fieldCount,
  what,
  against,
}) {
  const dirty = symbolsWithMismatches(mismatches).size
  const clean = Math.max(0, symbolCount - dirty)
  const pct = n => (symbolCount ? ((n / symbolCount) * 100).toFixed(1) : '0.0')
  const parts = [
    `${pct(clean)}% of symbols identical (${clean}/${symbolCount}); ` +
      `${dirty} differ`,
  ]
  if (fieldCount) {
    const fieldOk = Math.max(0, fieldCount - mismatches.length)
    parts.push(
      `${((fieldOk / fieldCount) * 100).toFixed(2)}% of field comparisons ` +
        `agree (${mismatches.length} of ${fieldCount} differ)`,
    )
  }
  return `${what} vs ${against}: ${parts.join(', ')}.`
}
