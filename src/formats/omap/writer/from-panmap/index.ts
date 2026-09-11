/**
 * XMap converter — `Panmap` symbols/objects → intermediate
 * XMap record shapes (`OmapSymbol`, `OmapAreaPattern`, …).
 *
 * The XML emission itself lives in `../encode.ts`. This directory only
 * builds the record shape; nothing here formats XML. The work is split
 * into cohesive modules:
 *   - `symbol.ts`      — `toOmapSymbol` dispatch + combined-symbol cases
 *   - `line.ts`        — line-symbol / borders builder
 *   - `area.ts`        — area-symbol builder
 *   - `point.ts`       — point-symbol builder
 *   - `text.ts`        — text-symbol builder
 *   - `elements.ts`    — OCAD/xmap point-element conversion
 *   - `colors.ts`      — colour / id mapping + nested colour rewrite
 *   - `object-type.ts` — canonical type → XMap type byte
 *   - `types.ts`       — `RawOmapSymbol`
 */
export type { RawOmapSymbol } from './types.js'
export { toOmapSymbol } from './symbol.js'
export { colorRef, colorIdMap, symbolIdMap } from './colors.js'
export { omapObjectType, omapSymbolType } from './object-type.js'
