import fs from 'node:fs/promises'
import path from 'node:path'
import { XMLSerializer, DOMImplementation } from '@xmldom/xmldom'
import type PanMap from '../map/model.js'
import mapToGeoJson from './geojson.js'
import mapToSvg from './svg.js'

export type ExportFormat = 'svg' | 'geojson' | 'json'

export interface ExportOptions {
  format?: ExportFormat | string
  backgroundColor?: string
  whiteBackground?: boolean
  applyCrs?: boolean
  exportHidden?: boolean
  includeSymbols?: number[] | false
}

/**
 * Exports a Map to a lossy target format (svg, geojson).
 *
 * Lossy: the rendering / GIS representation does not retain enough
 * information to reconstruct the original native map file. For lossless
 * format-to-format conversion, see `convert`.
 */
export async function exportMap(
  map: PanMap,
  filename: string,
  options: ExportOptions = {}
): Promise<void> {
  const format = (
    options.format ?? path.extname(filename).slice(1)
  ).toLowerCase()

  switch (format) {
    case 'svg': {
      const svg = mapToSvg(map, {
        document: new DOMImplementation().createDocument(null, 'xml', null),
        backgroundColor:
          options.backgroundColor ??
          (options.whiteBackground ? 'white' : undefined),
      })
      await fs.writeFile(filename, new XMLSerializer().serializeToString(svg))
      return
    }
    case 'json':
    case 'geojson':
      await fs.writeFile(filename, JSON.stringify(mapToGeoJson(map, options)))
      return
    default:
      throw new Error(`Unsupported export format: ${format}`)
  }
}

export { default as mapToGeoJson } from './geojson.js'
export { default as mapToSvg, getMapSvgRenderSupport } from './svg.js'
export default exportMap
