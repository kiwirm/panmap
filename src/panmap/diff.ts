import Panmap, {
  type MapColor,
  type MapObject,
  type MapSymbol,
  type RenderLayer,
} from './model.js'
import mapToSvg from '../export/svg/index.js'
import { boundsForCoords as sharedBoundsForCoords } from './coord.js'
import { parseSymbolCode } from './symbol-code.js'

export interface DiffMapsOptions {
  coordinateTolerance?: number
  coordinatePrecision?: number
  beforeCoordinateTransform?: CoordinateTransform
  afterCoordinateTransform?: CoordinateTransform
  includeUnchanged?: boolean
  unchangedOpacity?: number
  removedColor?: string
  addedColor?: string
  lineWidth?: number
  pointRadius?: number
}

type DiffKind = 'removed' | 'added' | 'unchanged'
type CoordinateTransform = (
  coord: number[],
  object: MapObject,
  map: Panmap,
) => number[]
type ResolvedDiffMapsOptions = Required<
  Omit<
    DiffMapsOptions,
    'beforeCoordinateTransform' | 'afterCoordinateTransform'
  >
> &
  Pick<
    DiffMapsOptions,
    'beforeCoordinateTransform' | 'afterCoordinateTransform'
  >

interface DiffSymbol extends MapSymbol {
  diffKind: DiffKind
}

interface DiffObject extends MapObject {
  diffKind: DiffKind
  sourceObject?: MapObject
}

const defaultOptions = {
  coordinateTolerance: 0,
  coordinatePrecision: 0,
  includeUnchanged: false,
  unchangedOpacity: 0.18,
  removedColor: 'rgb(220, 38, 38)',
  addedColor: 'rgb(22, 163, 74)',
  lineWidth: 18,
  pointRadius: 35,
}

/**
 * Compare two Panmaps and return a Panmap diff.
 *
 * Removed geometry is red and added geometry is green by default. Changed
 * objects are represented as removed old geometry plus added new geometry.
 * Line objects are compared by individual consecutive coordinate segments so
 * shared sections are omitted.
 */
function diffMaps(
  before: Panmap,
  after: Panmap,
  options: DiffMapsOptions = {},
): Panmap {
  const opts = { ...defaultOptions, ...options }
  const beforeSymbols = symbolsById(before)
  const afterSymbols = symbolsById(after)
  const beforeObjects = transformObjects(
    before.objects,
    before,
    opts.beforeCoordinateTransform,
  )
  const afterObjects = transformObjects(
    after.objects,
    after,
    opts.afterCoordinateTransform,
  )
  const objects: DiffObject[] = []
  let id = 1

  // Every diff object renders with a recoloured clone of its ORIGINAL
  // symbol, so a changed feature keeps its real symbology (point icon,
  // line dashes/mid-symbols, area fill/pattern) and only its colour is
  // forced to the diff colour. Clones are memoised per (colour, source
  // symbol); objects with no resolvable symbol fall back to the generic
  // diff symbols below.
  const symbolClones = new Map<string, MapSymbol>()
  const symbolFor = (
    object: MapObject,
    symbolsFor: Record<string | number, MapSymbol>,
  ): MapSymbol | undefined =>
    symbolsFor[String(object.symbolId)] ?? symbolsFor[object.symbolId as never]
  const diffSymbolIdFor = (
    orig: MapSymbol | undefined,
    kind: DiffKind,
    type: string,
  ): string => {
    // Areas render as a coloured outline + hatched fill (see
    // diffAreaSymbols), not their real solid fill.
    if (type === 'area') return `diff-area-${kind}`
    if (!orig) return `${kind}-${type === 'line-text' ? 'text' : type}`
    const key = `${kind}::${orig.id}`
    if (!symbolClones.has(key)) {
      symbolClones.set(key, recolorSymbol(orig, kind, opts.unchangedOpacity))
    }
    return String(symbolClones.get(key)!.id)
  }

  let beforeLines = beforeObjects.filter(object => object.type === 'line')
  let afterLines = afterObjects.filter(object => object.type === 'line')
  // Fast pre-pass: drop whole lines that are identical (same symbol + exact
  // coordinate sequence) in both maps before the expensive per-segment
  // matching below. A fully-identical line would be cancelled segment-by-
  // segment anyway, so removing it up front is (near-)equivalent but makes
  // the diff scale with the CHANGED geometry instead of the whole map — the
  // difference matters on dense maps where per-segment keying dominates.
  // Skipped under includeUnchanged, which needs unchanged geometry rendered.
  if (!opts.includeUnchanged) {
    const changed = cancelIdenticalLines(
      beforeLines,
      afterLines,
      beforeSymbols,
      afterSymbols,
      opts,
    )
    beforeLines = changed.before
    afterLines = changed.after
  }
  const afterLineSegments = segmentCounts(afterLines, afterSymbols, opts)
  const beforeLineSegments = segmentCounts(beforeLines, beforeSymbols, opts)

  for (const object of beforeLines) {
    objects.push(
      ...lineSegmentDiffObjects(
        object,
        beforeSymbols,
        afterLineSegments,
        'removed',
        opts,
        () => id++,
        k => diffSymbolIdFor(symbolFor(object, beforeSymbols), k, object.type),
      ),
    )
  }

  for (const object of afterLines) {
    objects.push(
      ...lineSegmentDiffObjects(
        object,
        afterSymbols,
        beforeLineSegments,
        'added',
        opts,
        () => id++,
        k => diffSymbolIdFor(symbolFor(object, afterSymbols), k, object.type),
      ),
    )
  }

  const beforeOther = beforeObjects.filter(object => object.type !== 'line')
  const afterOther = afterObjects.filter(object => object.type !== 'line')
  const beforeOtherCounts = objectCounts(beforeOther, beforeSymbols, opts)
  const afterOtherCounts = objectCounts(afterOther, afterSymbols, opts)

  for (const object of beforeOther) {
    const key = objectKey(object, beforeSymbols, opts)
    if (!consume(afterOtherCounts, key)) {
      objects.push(
        diffObject(
          object,
          'removed',
          () => id++,
          diffSymbolIdFor(
            symbolFor(object, beforeSymbols),
            'removed',
            object.type,
          ),
        ),
      )
    } else if (opts.includeUnchanged) {
      objects.push(
        diffObject(
          object,
          'unchanged',
          () => id++,
          diffSymbolIdFor(
            symbolFor(object, beforeSymbols),
            'unchanged',
            object.type,
          ),
        ),
      )
    }
  }

  for (const object of afterOther) {
    const key = objectKey(object, afterSymbols, opts)
    if (!consume(beforeOtherCounts, key)) {
      objects.push(
        diffObject(
          object,
          'added',
          () => id++,
          diffSymbolIdFor(
            symbolFor(object, afterSymbols),
            'added',
            object.type,
          ),
        ),
      )
    }
  }

  return new Panmap({
    sourceFormat: 'diff',
    sourceFile: { before, after },
    metadata: {
      before: before.metadata,
      after: after.metadata,
      coordinatePrecision: opts.coordinatePrecision,
    },
    georeferencing: after.georeferencing ?? before.georeferencing,
    colors: diffColors(opts),
    symbols: [
      ...diffSymbols(opts),
      ...diffAreaSymbols(),
      ...symbolClones.values(),
    ],
    objects,
    warnings: [...before.warnings, ...after.warnings],
  })
}

function diffMapsToSvg(
  before: Panmap,
  after: Panmap,
  options?: DiffMapsOptions,
): unknown {
  return mapToSvg(diffMaps(before, after, options))
}

// Remove lines that appear, unchanged, in BOTH maps — matched on the whole-
// object key (symbol + rounded coordinate sequence), as a multiset so
// duplicate identical lines pair up one-for-one. Returns the surviving
// (changed) lines on each side, in their original order so downstream diff-
// object ids and render order are unaffected. This is the cheap O(objects)
// pre-filter that keeps per-segment matching off unchanged geometry.
function cancelIdenticalLines(
  beforeLines: MapObject[],
  afterLines: MapObject[],
  beforeSymbols: Record<string | number, MapSymbol>,
  afterSymbols: Record<string | number, MapSymbol>,
  opts: typeof defaultOptions & DiffMapsOptions,
): { before: MapObject[]; after: MapObject[] } {
  // key -> stack of after-line indices carrying that key.
  const afterByKey = new Map<string, number[]>()
  afterLines.forEach((object, i) => {
    const k = objectKey(object, afterSymbols, opts)
    const bucket = afterByKey.get(k)
    if (bucket) bucket.push(i)
    else afterByKey.set(k, [i])
  })
  const cancelledAfter = new Set<number>()
  const before: MapObject[] = []
  for (const object of beforeLines) {
    const k = objectKey(object, beforeSymbols, opts)
    const bucket = afterByKey.get(k)
    if (bucket && bucket.length) cancelledAfter.add(bucket.pop()!)
    else before.push(object)
  }
  const after = afterLines.filter((_, i) => !cancelledAfter.has(i))
  return { before, after }
}

function transformObjects(
  objects: MapObject[],
  map: Panmap,
  transform?: CoordinateTransform,
): MapObject[] {
  if (!transform) return objects

  return objects.map(object => {
    const coordinates = Array.isArray(object.coordinates)
      ? (object.coordinates as number[][]).map(coord =>
          transform(coord, object, map),
        )
      : object.coordinates

    return {
      ...object,
      coordinates,
      bounds: Array.isArray(coordinates)
        ? boundsForCoords(coordinates)
        : object.bounds,
      sourceObject: object,
    }
  })
}

function diffColors(options: ResolvedDiffMapsOptions): MapColor[] {
  // The exporter draws HIGHER renderOrder first (at the bottom), so green
  // (added) gets the lowest order to sit on top of red (removed).
  return [
    {
      id: 'added',
      sourceId: 'added',
      name: 'Added',
      rgb: options.addedColor,
      renderOrder: 1,
    },
    {
      id: 'removed',
      sourceId: 'removed',
      name: 'Removed',
      rgb: options.removedColor,
      renderOrder: 2,
    },
    {
      id: 'unchanged',
      sourceId: 'unchanged',
      name: 'Unchanged',
      rgb: 'rgb(80, 80, 80)',
      renderOrder: 3,
    },
  ]
}

function diffSymbols(options: ResolvedDiffMapsOptions): DiffSymbol[] {
  return [
    diffSymbol('removed-line', 'line', 'removed', [
      { type: 'stroke', colorId: 'removed', width: options.lineWidth },
    ]),
    diffSymbol('added-line', 'line', 'added', [
      { type: 'stroke', colorId: 'added', width: options.lineWidth },
    ]),
    diffSymbol('removed-point', 'point', 'removed', [
      { type: 'point-fill', colorId: 'removed', radius: options.pointRadius },
    ]),
    diffSymbol('added-point', 'point', 'added', [
      { type: 'point-fill', colorId: 'added', radius: options.pointRadius },
    ]),
    diffSymbol('removed-area', 'area', 'removed', [
      { type: 'fill', colorId: 'removed', opacity: 0.6 },
    ]),
    diffSymbol('added-area', 'area', 'added', [
      { type: 'fill', colorId: 'added', opacity: 0.6 },
    ]),
    diffSymbol('removed-text', 'text', 'removed', [
      { type: 'text', colorId: 'removed', fontSize: 3 },
    ]),
    diffSymbol('added-text', 'text', 'added', [
      { type: 'text', colorId: 'added', fontSize: 3 },
    ]),
    diffSymbol('unchanged-line', 'line', 'unchanged', [
      {
        type: 'stroke',
        colorId: 'unchanged',
        width: options.lineWidth,
        opacity: options.unchangedOpacity,
      },
    ]),
    diffSymbol('unchanged-point', 'point', 'unchanged', [
      {
        type: 'point-fill',
        colorId: 'unchanged',
        radius: options.pointRadius,
        opacity: options.unchangedOpacity,
      },
    ]),
    diffSymbol('unchanged-area', 'area', 'unchanged', [
      { type: 'fill', colorId: 'unchanged', opacity: options.unchangedOpacity },
    ]),
    diffSymbol('unchanged-text', 'text', 'unchanged', [
      {
        type: 'text',
        colorId: 'unchanged',
        fontSize: 3,
        opacity: options.unchangedOpacity,
      },
    ]),
  ]
}

// Diff outlines are deliberately fat so added/removed/modified geometry
// reads clearly over the base map.
export const DIFF_OUTLINE_WIDTH = 44

// Area features in a diff render as a coloured OUTLINE (fat border) plus a
// hatched fill in the same colour — not their real solid fill. Returns the
// area symbol (`diff-area-<kind>`) and the border line it references
// (`diff-border-<kind>`) for each kind.
export function diffAreaSymbols(
  kinds: string[] = ['added', 'removed', 'unchanged'],
): MapSymbol[] {
  const out: MapSymbol[] = []
  for (const kind of kinds) {
    out.push({
      id: `diff-border-${kind}`,
      sourceId: `diff-border-${kind}`,
      code: `diff-border-${kind}`,
      name: `diff-border-${kind}`,
      type: 'line',
      hidden: false,
      layers: [{ type: 'stroke', colorId: kind, width: DIFF_OUTLINE_WIDTH }],
    } as unknown as MapSymbol)
    out.push({
      id: `diff-area-${kind}`,
      sourceId: `diff-area-${kind}`,
      code: `diff-area-${kind}`,
      name: `diff-area-${kind}`,
      type: 'area',
      hidden: false,
      layers: [
        {
          type: 'hatch-fill',
          colorId: kind,
          spacing: 120,
          lineWidth: 14,
          angle: 45,
        },
        { type: 'border-symbol', symbolId: `diff-border-${kind}` },
      ],
    } as unknown as MapSymbol)
  }
  return out
}

function diffSymbol(
  id: string,
  type: string,
  diffKind: DiffKind,
  layers: RenderLayer[],
): DiffSymbol {
  return {
    id,
    sourceId: id,
    code: id,
    name: id,
    type,
    hidden: false,
    diffKind,
    layers,
  }
}

function symbolsById(map: Panmap): Record<number | string, MapSymbol> {
  return map.symbols.reduce<Record<number | string, MapSymbol>>(
    (symbols, symbol) => {
      symbols[symbol.id] = symbol
      return symbols
    },
    {},
  )
}

function lineSegmentDiffObjects(
  object: MapObject,
  symbols: Record<number | string, MapSymbol>,
  oppositeSegments: Map<string, number>,
  kind: 'removed' | 'added',
  options: ResolvedDiffMapsOptions,
  nextId: () => number,
  // Resolves the recoloured clone id of the object's original line symbol
  // for a given diff kind, so changed segments render with the real line
  // style (and unchanged segments get the dimmed 'unchanged' clone).
  symbolIdFor: (kind: DiffKind) => string,
): DiffObject[] {
  const result: DiffObject[] = []
  const coords = object.coordinates as number[][]

  if (!Array.isArray(coords) || coords.length < 2) {
    const key = objectKey(object, symbols, options)
    if (!consume(oppositeSegments, key)) {
      result.push(diffObject(object, kind, nextId, symbolIdFor(kind)))
    }
    return result
  }

  let current: number[][] = []
  let unchanged: number[][] = []
  const groupPrefix = groupPrefixOf(object, symbols)
  for (let index = 0; index < coords.length - 1; index++) {
    const previous = coords[index]
    const coord = coords[index + 1]
    const key = segmentKeyOf(groupPrefix, previous, coord, options)
    if (consume(oppositeSegments, key)) {
      if (current.length > 1) {
        result.push(
          lineDiffObject(object, current, kind, nextId, symbolIdFor(kind)),
        )
      }
      current = []
      if (options.includeUnchanged && kind === 'removed') {
        if (unchanged.length === 0) unchanged = [previous]
        unchanged.push(coord)
      }
      continue
    }

    if (unchanged.length > 1) {
      result.push(
        lineDiffObject(
          object,
          unchanged,
          'unchanged',
          nextId,
          symbolIdFor('unchanged'),
        ),
      )
      unchanged = []
    }

    if (unchanged.length === 1) {
      current = []
      unchanged = []
    }

    if (current.length === 0) current = [previous]
    current.push(coord)
  }

  if (current.length > 1) {
    result.push(
      lineDiffObject(object, current, kind, nextId, symbolIdFor(kind)),
    )
  }
  if (unchanged.length > 1) {
    result.push(
      lineDiffObject(
        object,
        unchanged,
        'unchanged',
        nextId,
        symbolIdFor('unchanged'),
      ),
    )
  }

  return result
}

function segmentCounts(
  objects: MapObject[],
  symbols: Record<number | string, MapSymbol>,
  options: ResolvedDiffMapsOptions,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const object of objects) {
    const coords = object.coordinates as number[][]
    if (!Array.isArray(coords) || coords.length < 2) {
      increment(counts, objectKey(object, symbols, options))
      continue
    }
    const groupPrefix = groupPrefixOf(object, symbols)
    for (let i = 1; i < coords.length; i++) {
      increment(
        counts,
        segmentKeyOf(groupPrefix, coords[i - 1], coords[i], options),
      )
    }
  }
  return counts
}

function objectCounts(
  objects: MapObject[],
  symbols: Record<number | string, MapSymbol>,
  options: ResolvedDiffMapsOptions,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const object of objects) {
    increment(counts, objectKey(object, symbols, options))
  }
  return counts
}

function objectKey(
  object: MapObject,
  symbols: Record<number | string, MapSymbol>,
  options: ResolvedDiffMapsOptions,
): string {
  const coords = object.coordinates as number[][]
  const coordKey = objectGeometryKey(object, coords, options)
  return [
    symbolKey(symbols[object.symbolId]),
    object.type,
    object.text || '',
    coordKey,
  ].join(':')
}

function objectGeometryKey(
  object: MapObject,
  coords: number[][],
  options: ResolvedDiffMapsOptions,
): string {
  if (!Array.isArray(coords)) return ''

  if (object.type === 'text' || object.type === 'line-text') {
    return coords[0] ? coordString(coords[0], options) : ''
  }

  return coords.map(coord => coordString(coord, options)).join('|')
}

// The per-object part of a segment/degenerate key: `<symbolKey>:<type>:`.
// Hoisted out of the per-segment loop so symbolKey (a regex test +
// parseSymbolCode) runs once per object instead of once per segment.
function groupPrefixOf(
  object: MapObject,
  symbols: Record<number | string, MapSymbol>,
): string {
  return `${symbolKey(symbols[object.symbolId])}:${object.type}:`
}

// Direction-independent key for the segment a→b, combined with a precomputed
// group prefix. Reproduces the original `<symbolKey>:<type>:ca|cb` exactly —
// only the symbolKey computation moved out of the loop.
function segmentKeyOf(
  groupPrefix: string,
  a: number[],
  b: number[],
  options: ResolvedDiffMapsOptions,
): string {
  const ca = coordString(a, options)
  const cb = coordString(b, options)
  return ca < cb ? `${groupPrefix}${ca}|${cb}` : `${groupPrefix}${cb}|${ca}`
}

function symbolKey(symbol?: MapSymbol): string {
  if (!symbol) return ''
  // Canonicalise numeric OCAD-style codes so the same symbol matches
  // across source formats. OMap stores a major symbol as "101" while
  // OCAD stores "101.0"; parseSymbolCode packs both to the same integer
  // (101000), so an OMap-sourced map diffs cleanly against an
  // OCAD-sourced one instead of reporting every object as changed.
  // Non-numeric codes fall back to the raw string (then name/id).
  const code = symbol.code
  if (code && /^\d+(\.\d+)*$/.test(code.trim())) {
    return `#${parseSymbolCode(code)}`
  }
  return code || symbol.name || String(symbol.id)
}

function coordString(
  coord: number[],
  options: ResolvedDiffMapsOptions,
): string {
  if (options.coordinateTolerance > 0) {
    return `${roundTo(coord[0], options.coordinateTolerance)},${roundTo(
      coord[1],
      options.coordinateTolerance,
    )}`
  }

  const scale = 10 ** options.coordinatePrecision
  return `${Math.round(coord[0] * scale) / scale},${
    Math.round(coord[1] * scale) / scale
  }`
}

function roundTo(value: number, tolerance: number): number {
  return Math.round(value / tolerance) * tolerance
}

function consume(counts: Map<string, number>, key: string): boolean {
  const count = counts.get(key) || 0
  if (count <= 0) return false
  if (count === 1) counts.delete(key)
  else counts.set(key, count - 1)
  return true
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) || 0) + 1)
}

function diffObject(
  object: MapObject,
  kind: DiffKind,
  nextId: () => number,
  overrideSymbolId?: string | null,
): DiffObject {
  return {
    ...object,
    id: nextId(),
    symbolId:
      overrideSymbolId ??
      `${kind}-${object.type === 'line-text' ? 'text' : object.type}`,
    hidden: false,
    diffKind: kind,
    sourceObject: object,
  }
}

function lineDiffObject(
  object: MapObject,
  coordinates: number[][],
  kind: 'removed' | 'added' | 'unchanged',
  nextId: () => number,
  symbolId: string,
): DiffObject {
  return {
    ...object,
    id: nextId(),
    symbolId,
    type: 'line',
    coordinates,
    hidden: false,
    bounds: boundsForCoords(coordinates),
    diffKind: kind,
    sourceObject: object,
  }
}

function boundsForCoords(coordinates: number[][]): {
  min: number[]
  max: number[]
} {
  return sharedBoundsForCoords(coordinates) ?? { min: [0, 0], max: [0, 0] }
}

// Deep-clone a symbol, forcing every colour reference to `colorId` so it
// renders in a single diff colour while keeping its full symbology (point
// icons, line dashes/mid-symbols, area fills). Invalid ids (e.g. -1 "no
// colour") are left untouched so invisible layers stay invisible.
export function recolorSymbol(
  orig: MapSymbol,
  kind: string,
  unchangedOpacity = 0.18,
): MapSymbol {
  const clone = remapColorRefs(orig, kind) as MapSymbol
  clone.id = `diff-${kind}-${orig.id}`
  clone.sourceId = clone.id
  if (kind === 'unchanged') {
    for (const layer of (clone.layers ?? []) as Array<{ opacity?: number }>) {
      layer.opacity = unchangedOpacity
    }
  }
  return clone
}

function remapColorRefs(value: unknown, colorId: string): unknown {
  if (Array.isArray(value)) return value.map(v => remapColorRefs(v, colorId))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        isColorKey(k) && isColorRef(v) ? colorId : remapColorRefs(v, colorId)
    }
    return out
  }
  return value
}

// Keys holding a colour reference: `color`, `colorId`, `fillColorId`,
// `leftColorId`, `innerColor`, `outerColor`, `frColor`, … (British
// spelling too). Anchored so `sourceId` / `code` are never matched.
function isColorKey(key: string): boolean {
  return /colou?r(id)?$/i.test(key)
}
function isColorRef(v: unknown): boolean {
  return (
    (typeof v === 'number' && v >= 0) || (typeof v === 'string' && v.length > 0)
  )
}

export { diffMapsToSvg }
export default diffMaps
