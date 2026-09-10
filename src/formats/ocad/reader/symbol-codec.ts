/**
 * Central lookup tables for OCAD symbol and object types.
 *
 * Intended as the seed of a per-type codec registry that unifies:
 *   - the reader's per-type constructor dispatch (currently one file per
 *     symbol type in `read/`),
 *   - the writer's switch on `symbol.type` (encode-symbol.ts),
 *   - the toMap render-layer dispatch (to-map.ts symbolToRenderLayers),
 *   - the xmap render-layer dispatch (xmap/to-map.ts).
 *
 * For now, only the type-name maps are shared. Consumers still perform
 * their own dispatch; when a full registry lands, it should own those
 * dispatch tables and expose codec.read / codec.write / codec.toMap /
 * codec.fromMap per type.
 */

import {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
} from '../native/symbol-types.js'
import {
  PointObjectType,
  LineObjectType,
  AreaObjectType,
  UnformattedTextObjectType,
  FormattedTextObjectType,
  LineTextObjectType,
} from '../native/object-types.js'

/** Canonical name for a numeric OCAD symbol type. */
export const OCAD_SYMBOL_TYPE_NAMES: Readonly<Record<number, string>> = {
  [PointSymbolType]: 'point',
  [LineSymbolType]: 'line',
  [AreaSymbolType]: 'area',
  [TextSymbolType]: 'text',
}

/** Canonical name for a numeric OCAD object type. */
export const OCAD_OBJECT_TYPE_NAMES: Readonly<Record<number, string>> = {
  [PointObjectType]: 'point',
  [LineObjectType]: 'line',
  [AreaObjectType]: 'area',
  [UnformattedTextObjectType]: 'text',
  [FormattedTextObjectType]: 'text',
  [LineTextObjectType]: 'line-text',
}

export function ocadSymbolTypeName(type: number): string {
  return OCAD_SYMBOL_TYPE_NAMES[type] ?? 'unknown'
}

export function ocadObjectTypeName(type: number): string {
  return OCAD_OBJECT_TYPE_NAMES[type] ?? 'unknown'
}
