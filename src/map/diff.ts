import PanMap, {
  type MapColor,
  type MapObject,
  type MapSymbol,
  type RenderLayer,
} from './model.js'
import mapToSvg from '../export/svg.js'
import { boundsForCoords as sharedBoundsForCoords } from './coord.js'

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
type CoordinateTransform = (coord: number[], object: MapObject, map: PanMap) => number[]
type ResolvedDiffMapsOptions = Required<
  Omit<
    DiffMapsOptions,
    | 'beforeCoordinateTransform'
    | 'afterCoordinateTransform'
  >
> &
  Pick<
    DiffMapsOptions,
    | 'beforeCoordinateTransform'
    | 'afterCoordinateTransform'
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
 * Compare two PanMaps and return a PanMap diff.
 *
 * Removed geometry is red and added geometry is green by default. Changed
 * objects are represented as removed old geometry plus added new geometry.
 * Line objects are compared by individual consecutive coordinate segments so
 * shared sections are omitted.
 */
function diffMaps(
  before: PanMap,
  after: PanMap,
  options: DiffMapsOptions = {}
): PanMap {
  const opts = { ...defaultOptions, ...options }
  const beforeSymbols = symbolsById(before)
  const afterSymbols = symbolsById(after)
  const beforeObjects = transformObjects(
    before.objects,
    before,
    opts.beforeCoordinateTransform
  )
  const afterObjects = transformObjects(
    after.objects,
    after,
    opts.afterCoordinateTransform
  )
  const objects: DiffObject[] = []
  let id = 1

  // Per-source-symbol clones for text objects. Text carries per-symbol
  // styling (fontSize, fontFamily, hAlign, vAlign) that a single shared
  // `added-text`/`removed-text` synthetic can't reproduce, so for every
  // original text symbol we produce three tinted clones (added/removed/
  // unchanged) on demand and point the diff object at those.
  const textSymbolClones = new Map<string, MapSymbol>();
  const cloneTextSymbol = (
    orig: MapSymbol, kind: DiffKind,
  ): string => {
    const key = `${kind}::${orig.id}`;
    if (textSymbolClones.has(key)) return String(textSymbolClones.get(key)!.id);
    const clonedId = `diff-${kind}-${orig.id}`;
    const clone: MapSymbol = {
      ...orig,
      id: clonedId,
      renderLayers: (orig.renderLayers ?? []).map((layer: RenderLayer) => {
        if (layer.type !== 'text' && layer.type !== 'line-text') return layer;
        return {
          ...layer,
          colorId: kind,
          ...(kind === 'unchanged' ? { opacity: opts.unchangedOpacity } : {}),
        } as RenderLayer;
      }),
    };
    textSymbolClones.set(key, clone);
    return clonedId;
  };

  const beforeLines = beforeObjects.filter(object => object.type === 'line')
  const afterLines = afterObjects.filter(object => object.type === 'line')
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
        () => id++
      )
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
        () => id++
      )
    )
  }

  const beforeOther = beforeObjects.filter(object => object.type !== 'line')
  const afterOther = afterObjects.filter(object => object.type !== 'line')
  const beforeOtherCounts = objectCounts(beforeOther, beforeSymbols, opts)
  const afterOtherCounts = objectCounts(afterOther, afterSymbols, opts)

  const clonedSymbolIdFor = (
    object: MapObject, kind: DiffKind,
    symbolsFor: Record<string | number, MapSymbol>,
  ): string | null => {
    if (object.type !== 'text' && object.type !== 'line-text') return null;
    const orig = symbolsFor[String(object.symbolId)] ?? symbolsFor[object.symbolId as never];
    if (!orig) return null;
    return cloneTextSymbol(orig, kind);
  };

  for (const object of beforeOther) {
    const key = objectKey(object, beforeSymbols, opts)
    if (!consume(afterOtherCounts, key)) {
      objects.push(diffObject(object, 'removed', () => id++,
        clonedSymbolIdFor(object, 'removed', beforeSymbols)))
    } else if (opts.includeUnchanged) {
      objects.push(diffObject(object, 'unchanged', () => id++,
        clonedSymbolIdFor(object, 'unchanged', beforeSymbols)))
    }
  }

  for (const object of afterOther) {
    const key = objectKey(object, afterSymbols, opts)
    if (!consume(beforeOtherCounts, key)) {
      objects.push(diffObject(object, 'added', () => id++,
        clonedSymbolIdFor(object, 'added', afterSymbols)))
    }
  }

  return new PanMap({
    sourceFormat: 'diff',
    sourceFile: { before, after },
    metadata: {
      before: before.metadata,
      after: after.metadata,
      coordinatePrecision: opts.coordinatePrecision,
    },
    georeferencing: after.georeferencing ?? before.georeferencing,
    colors: diffColors(opts),
    symbols: [...diffSymbols(opts), ...textSymbolClones.values()],
    objects,
    warnings: [...before.warnings, ...after.warnings],
  })
}

function diffMapsToSvg(
  before: PanMap,
  after: PanMap,
  options?: DiffMapsOptions
): unknown {
  return mapToSvg(diffMaps(before, after, options))
}

function transformObjects(
  objects: MapObject[],
  map: PanMap,
  transform?: CoordinateTransform
): MapObject[] {
  if (!transform) return objects

  return objects.map(object => {
    const coordinates = Array.isArray(object.coordinates)
      ? (object.coordinates as number[][]).map(coord =>
          transform(coord, object, map)
        )
      : object.coordinates

    return {
      ...object,
      coordinates,
      bounds: Array.isArray(coordinates) ? boundsForCoords(coordinates) : object.bounds,
      sourceObject: object,
    }
  })
}

function diffColors(options: ResolvedDiffMapsOptions): MapColor[] {
  return [
    {
      id: 'removed',
      sourceId: 'removed',
      name: 'Removed',
      rgb: options.removedColor,
      renderOrder: 3,
    },
    {
      id: 'added',
      sourceId: 'added',
      name: 'Added',
      rgb: options.addedColor,
      renderOrder: 4,
    },
    {
      id: 'unchanged',
      sourceId: 'unchanged',
      name: 'Unchanged',
      rgb: 'rgb(80, 80, 80)',
      renderOrder: 1,
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

function diffSymbol(
  id: string,
  type: string,
  diffKind: DiffKind,
  renderLayers: RenderLayer[]
): DiffSymbol {
  return {
    id,
    sourceId: id,
    code: id,
    name: id,
    type,
    hidden: false,
    diffKind,
    renderLayers,
  }
}

function symbolsById(map: PanMap): Record<number | string, MapSymbol> {
  return map.symbols.reduce<Record<number | string, MapSymbol>>(
    (symbols, symbol) => {
      symbols[symbol.id] = symbol
      return symbols
    },
    {}
  )
}

function lineSegmentDiffObjects(
  object: MapObject,
  symbols: Record<number | string, MapSymbol>,
  oppositeSegments: Map<string, number>,
  kind: 'removed' | 'added',
  options: ResolvedDiffMapsOptions,
  nextId: () => number
): DiffObject[] {
  const result: DiffObject[] = []
  const coords = object.coordinates as number[][]

  if (!Array.isArray(coords) || coords.length < 2) {
    const key = objectKey(object, symbols, options)
    if (!consume(oppositeSegments, key)) {
      result.push(diffObject(object, kind, nextId))
    }
    return result
  }

  let current: number[][] = []
  let unchanged: number[][] = []
  coords.slice(1).forEach((coord, index) => {
    const previous = coords[index]
    const key = segmentKey(object, symbols, previous, coord, options)
    if (consume(oppositeSegments, key)) {
      if (current.length > 1) {
        result.push(lineDiffObject(object, current, kind, nextId))
      }
      current = []
      if (options.includeUnchanged && kind === 'removed') {
        if (unchanged.length === 0) unchanged = [previous]
        unchanged.push(coord)
      }
      return
    }

    if (unchanged.length > 1) {
      result.push(lineDiffObject(object, unchanged, 'unchanged', nextId))
      unchanged = []
    }

    if (unchanged.length === 1) {
      current = []
      unchanged = []
    }

    if (current.length === 0) current = [previous]
    current.push(coord)
  })

  if (current.length > 1) {
    result.push(lineDiffObject(object, current, kind, nextId))
  }
  if (unchanged.length > 1) {
    result.push(lineDiffObject(object, unchanged, 'unchanged', nextId))
  }

  return result
}

function segmentCounts(
  objects: MapObject[],
  symbols: Record<number | string, MapSymbol>,
  options: ResolvedDiffMapsOptions
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const object of objects) {
    const coords = object.coordinates as number[][]
    if (!Array.isArray(coords) || coords.length < 2) {
      increment(counts, objectKey(object, symbols, options))
      continue
    }
    coords.slice(1).forEach((coord, index) => {
      increment(counts, segmentKey(object, symbols, coords[index], coord, options))
    })
  }
  return counts
}

function objectCounts(
  objects: MapObject[],
  symbols: Record<number | string, MapSymbol>,
  options: ResolvedDiffMapsOptions
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
  options: ResolvedDiffMapsOptions
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
  options: ResolvedDiffMapsOptions
): string {
  if (!Array.isArray(coords)) return ''

  if (object.type === 'text' || object.type === 'line-text') {
    return coords[0] ? coordString(coords[0], options) : ''
  }

  return coords.map(coord => coordString(coord, options)).join('|')
}

function segmentKey(
  object: MapObject,
  symbols: Record<number | string, MapSymbol>,
  a: number[],
  b: number[],
  options: ResolvedDiffMapsOptions
): string {
  const ca = coordString(a, options)
  const cb = coordString(b, options)
  const segment = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`
  return [symbolKey(symbols[object.symbolId]), object.type, segment].join(':')
}

function symbolKey(symbol?: MapSymbol): string {
  return symbol ? symbol.code || symbol.name || String(symbol.id) : ''
}

function coordString(coord: number[], options: ResolvedDiffMapsOptions): string {
  if (options.coordinateTolerance > 0) {
    return `${roundTo(coord[0], options.coordinateTolerance)},${roundTo(
      coord[1],
      options.coordinateTolerance
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
    symbolId: overrideSymbolId ??
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
  nextId: () => number
): DiffObject {
  return {
    ...object,
    id: nextId(),
    symbolId: `${kind}-line`,
    type: 'line',
    coordinates,
    hidden: false,
    bounds: boundsForCoords(coordinates),
    diffKind: kind,
    sourceObject: object,
  }
}

function boundsForCoords(coordinates: number[][]): { min: number[]; max: number[] } {
  return sharedBoundsForCoords(coordinates) ?? { min: [0, 0], max: [0, 0] }
}

export { diffMapsToSvg }
export default diffMaps
