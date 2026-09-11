/**
 * Map a canonical `MapSymbol` / `MapObject` `type` string to the XMap
 * numeric type byte the record shapes and object emitter expect.
 */
import type { MapObject, MapSymbol } from '../../../../panmap/model.js'

function omapSymbolType(symbol: MapSymbol): number {
  if (symbol.type === 'point') return 1
  if (symbol.type === 'line') return 2
  if (symbol.type === 'area') return 4
  if (symbol.type === 'text' || symbol.type === 'line-text') return 8
  return 0
}

function omapObjectType(object: MapObject): number {
  if (object.type === 'point') return 0
  if (object.type === 'text' || object.type === 'line-text') return 4
  return 1
}

export { omapObjectType, omapSymbolType }
