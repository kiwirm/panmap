import type { MapColor, MapSymbol } from '../../../../panmap/model.js'
import { canonicalSymbolCode } from '../../../../panmap/symbol-code.js'

export function stableColorId(color: MapColor): string {
  // Include a stable disambiguator so duplicate-named color slots
  // (port-hills has 6 different "Green" entries used at different
  // render orders) don't collapse into one gitmap id. Renumber via
  // sourceId when present, else id — either is stable across a
  // single map's serialisation.
  const base = slug(color.name || String(color.id)) || String(color.id)
  const disc = color.sourceId ?? color.id
  return `color_${base}_${disc}`
}

export function stableSymbolId(symbol: MapSymbol): string {
  const code =
    canonicalSymbolCode(symbol.code) || String(symbol.sourceId ?? symbol.id)
  return `sym_${slug(code)}`
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
