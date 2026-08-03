/**
 * panmap — convert and export orienteering map files.
 *
 * Native formats (lossless round-trip): ocad/ocd, omap/xmap, gitmap.
 * Export targets (lossy): svg, geojson, mvt.
 *
 * Top-level API:
 *   - read(input, options?)           → Map
 *   - write(map, path, options?)      → void   (native formats only)
 *   - convert(input, path, options?)  → void   (lossless: read + write)
 *   - exportMap(map, path, options?)  → void   (lossy: svg / geojson)
 *   - diff(a, b, options?)            → DiffMaps
 *
 * Per-format namespaces (`ocad`, `omap`, `gitmap`) expose the raw native
 * readers and writers for callers that need to work below the PanMap
 * model.
 */

import PanMap from './map/model.js'

import * as ocad from './formats/ocad/index.js'
import * as omap from './formats/omap/index.js'
import * as gitmap from './formats/gitmap/index.js'

export { read } from './read.js'
export { write, type WriteOptions, type NativeFormat } from './write.js'
export { convert } from './convert.js'
export {
  exportMap,
  mapToGeoJson,
  mapToSvg,
  getMapSvgRenderSupport,
  type ExportOptions,
  type ExportFormat,
} from './export/index.js'
export {
  default as diff,
  diffMapsToSvg,
  type DiffMapsOptions,
} from './map/diff.js'

export { PanMap, PanMap as Map }
export type {
  MapColor,
  MapObject,
  MapSymbol,
  RenderLayer,
  TextTypography,
  MapOptions,
} from './map/model.js'
export { ocad, omap, gitmap }
