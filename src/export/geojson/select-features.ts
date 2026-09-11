import type { Feature } from 'geojson'
import type Panmap from '../../panmap/model.js'
import type { MapObject, MapSymbol, MapColor } from '../../panmap/model.js'

/** Options accepted by `mapToGeoJson` and threaded through `selectFeatures`. */
export interface MapToGeoJsonOptions {
  /** Transform coordinates to the file's geographic CRS (default: true). */
  applyCrs?: boolean
  generateSymbolElements?: boolean
  exportHidden?: boolean
  includeSymbols?: Array<number | string> | false
  /** Digits after the decimal point for emitted coordinates (default: 6). */
  coordinatePrecision?: number
  /** Restrict/override the object set to export. */
  objects?: MapObject[]
  /** Palette carried through for downstream consumers. */
  colors?: MapColor[]
  /** Running feature-id counter, seeded to the object count. */
  idCount?: number
}

/** Symbols keyed by their resolved id. */
type SymbolMap = Record<number | string, MapSymbol>

/** Visitor that turns one map object into zero or more GeoJSON features. */
type CreateObjects = (
  options: MapToGeoJsonOptions,
  symbols: SymbolMap,
  object: MapObject,
  i: number,
) => Feature[] | undefined

const defaultOptions = {
  exportHidden: false,
}

export default selectFeatures

/**
 * Translate a Panmap into feature objects using the caller's
 * `createObjects` visitor.
 *
 * Historically this file also emitted per-symbol decoration features
 * (line dash/mid/start/end elements as separate GeoJSON features) by
 * reading OCAD-shaped fields off the symbol. Those fields disappeared
 * when the source sidecar was removed — decoration is now the SVG
 * exporter's job. GeoJSON output stays at the object level.
 */
function selectFeatures(
  map: Panmap,
  createObjects: CreateObjects,
  _createElement: unknown,
  options: MapToGeoJsonOptions,
): Feature[] {
  options = {
    ...defaultOptions,
    ...options,
    colors: map.colors,
    idCount: map.objects.length,
  }

  const symbols = map.symbols
    .filter(
      s =>
        !options.includeSymbols ||
        options.includeSymbols.find(symNum => symNum === getSymbolId(s)),
    )
    .reduce((ss, s) => {
      ss[getSymbolId(s)] = s
      return ss
    }, {} as SymbolMap)

  const objects = options.objects || map.objects
  return objects
    .map(createObjects.bind(null, options, symbols))
    .flat()
    .filter(Boolean) as Feature[]
}

const getSymbolId = (symbol: MapSymbol): number | string =>
  symbol.id !== undefined
    ? symbol.id
    : ((symbol as { symNum?: number | string }).symNum as number | string)
