import type { MapColor } from '../map/model.js'

/**
 * Build a `MapColor.id → numeric slot` lookup. The numeric
 * slot is what OCAD / xmap store on disk: prefer `sourceId` (round-trip
 * from the original file), fall back to a numeric `id`, and finally to
 * render order so downstream numeric channels stay stable when the
 * PanMap came from a source without numeric ids (e.g. gitmap).
 *
 * Each format wraps this with its own "missing color" sentinel via
 * `colorNumberLookup` (0 for OCAD) or `colorRefLookup` (-1 for xmap).
 */
export function buildColorIdMap(colors: MapColor[]): Map<string | number, number> {
  const map = new Map<string | number, number>()
  colors.forEach((c, i) => {
    const num = typeof c.sourceId === 'number'
      ? c.sourceId
      : typeof c.id === 'number' ? c.id : i
    map.set(c.id, num)
  })
  return map
}

/**
 * OCAD variant of the color-id lookup. Missing/unknown ids resolve to
 * `0` — Mapper's OCAD sentinel for "no color / use default" (real .ocd
 * files never write `-1` here).
 */
export function colorNumberLookup(colors: MapColor[]): (id: unknown) => number {
  const byId = buildColorIdMap(colors)
  return (id) => {
    if (id === undefined || id === null) return 0
    if (typeof id === 'number') return id < 0 ? 0 : id
    const looked = byId.get(id as string | number)
    return typeof looked === 'number' && looked >= 0 ? looked : 0
  }
}

/**
 * XMap variant of the color-id lookup. Missing/unknown ids resolve to
 * `-1` — xmap's sentinel for "no color reference".
 */
export function colorRefLookup(
  value: unknown,
  colorIds: Map<string | number, number>,
): number {
  if (value === undefined || value === null) return -1
  const mapped = colorIds.get(value as string | number)
  if (mapped !== undefined) return mapped
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : -1
}
