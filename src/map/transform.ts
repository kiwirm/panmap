const defaultOptions = {
  exportHidden: false,
}

export default transformFeatures

/**
 * Translate a PanMap into feature objects using the caller's
 * `createObjects` visitor.
 *
 * Historically this file also emitted per-symbol decoration features
 * (line dash/mid/start/end elements as separate GeoJSON features) by
 * reading OCAD-shaped fields off the symbol. Those fields disappeared
 * when the source sidecar was removed — decoration is now the SVG
 * exporter's job. GeoJSON output stays at the object level.
 */
function transformFeatures(map, createObjects, _createElement, options) {
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
        options.includeSymbols.find(symNum => symNum === getSymbolId(s))
    )
    .reduce((ss, s) => {
      ss[getSymbolId(s)] = s
      return ss
    }, {})

  const objects = options.objects || map.objects
  return objects
    .map(createObjects.bind(null, options, symbols))
    .flat()
    .filter(Boolean)
}

const getSymbolId = symbol =>
  symbol.id !== undefined ? symbol.id : symbol.symNum
